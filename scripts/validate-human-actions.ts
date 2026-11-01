import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { resolveSelection } from '../packages/game-core/src/index.ts';
import type { MatchRuntime } from '../apps/server/src/match.ts';
import type { InPlayFact } from '../apps/server/src/in-play-facts.ts';
import { runtimeFingerprint } from '../apps/server/src/runtime-fingerprint.ts';
import type { GameCommand, HumanActionIntent, HumanActionView, HumanChoiceAnswer, Position } from '../packages/protocol/src/index.ts';
import { seedHumanScenario, practiceBasic, practiceEnergy, practiceSearch, practiceEvolution, practiceNumber, practiceOrder, practiceCoins, type PracticeScenarioOptions } from './human-action-fixtures.ts';

const directory = resolve(process.argv[2] ?? `artifacts/human-actions-real-${Date.now()}`);
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory); // 拒绝覆盖已有运行。
const hashFile = async (file: string | URL) => createHash('sha256').update(await readFile(file)).digest('hex');
const sourceHash = await runtimeFingerprint();
const rules = await Promise.all(['规则基准', '卡牌说明文语义', '赛场规则摘要'].map(async name => ({ file: `rules/${name}.md`, sha256: await hashFile(`rules/${name}.md`) })));
const app = await buildApp({ dataDir: join(directory, 'data'), systemDir: resolve('system') });
const main = await seedHumanScenario(app.gameService, 'real-human-actions');
const plannedCases = [
  '指定附能', '已完成行动真实复核', '检索等待人选牌', '指定特性抽牌', '指定备战槽放置', '指定进化', '指定攻击和回合处理',
  '缺能量攻击规则拒绝', '规则拒绝后真实重试', '中毒检查及结束回合', '明确替补临时交权', '替补等待人选后归还', '人选抽牌数量', '人定牌库逆序',
  '可选投2硬币后固定投1', '选牌确认后展示入手完成',
];
interface CaseRecord {
  name: string; matchId: string; actionId: string; expectedStatus: 'completed' | 'failed'; actualStatus: HumanActionView['status'];
  status: 'running' | 'passed' | 'failed'; elapsedMs: number; eventIds: string[]; humanChoices: Record<string, unknown>[]; evidence?: Record<string, unknown>; error?: string;
}
const report: { startedAt: string; sourceHash: string; fixtureHash: string; scriptHash: string; promptVersion: string; finalSourceHash?: string; finalFixtureHash?: string; finalScriptHash?: string; finalPromptVersion?: string; rules: typeof rules; model: string; effort: string; fast: boolean; plannedCases: string[]; cases: CaseRecord[]; fixtureInPlayFacts: Record<string, InPlayFact[]>; placementInPlayFacts?: InPlayFact[]; status: string; error?: string } = {
  startedAt: new Date().toISOString(), sourceHash, fixtureHash: await hashFile(new URL('./human-action-fixtures.ts', import.meta.url)), scriptHash: await hashFile(new URL(import.meta.url)), promptVersion: main.meta.prompts.version,
  rules, model: main.meta.model.model, effort: main.meta.model.reasoningEffort, fast: main.meta.model.fast, plannedCases, cases: [], fixtureInPlayFacts: {}, status: 'running',
};
assert.equal(report.model, 'gpt-6.1-terra'); assert.equal(report.effort, 'medium'); assert.equal(report.fast, false);
const inPlayFacts = async (match: MatchRuntime): Promise<InPlayFact[]> => ((await match.observe(match.state.id, 'A', null)).snapshot as unknown as { inPlayFacts: InPlayFact[] }).inPlayFacts;
async function captureFixtureFacts(match: MatchRuntime): Promise<void> {
  const facts = await inPlayFacts(match); report.fixtureInPlayFacts[match.state.id] = facts;
  assert.equal(facts.length, match.state.zones['A:active']!.contents.items[0] ? 5 : 4);
  for (const fact of facts) assert.equal(fact.firstInPlay?.turn, 1, '既有场上卡牌组必须具有第1回合的真实历史');
}
async function seed(id: string, options: PracticeScenarioOptions = {}): Promise<MatchRuntime> {
  const match = await seedHumanScenario(app.gameService, id, options); await captureFixtureFacts(match); return match;
}
const root = (match: MatchRuntime) => `/api/matches/${match.state.id}`;
const handIds = (match: MatchRuntime) => match.state.zones['A:hand']!.contents.items.map(item => item!.id);
const handCount = (match: MatchRuntime) => handIds(match).length;
const deckIds = (match: MatchRuntime) => match.state.zones['A:deck']!.contents.items.map(item => item!.id);
const energyCount = (match: MatchRuntime) => match.view('A').zones.find(zone => zone.id === 'A:hand')!.items.filter(item => item?.kind === 'card' && item.card.kind === 'energy').length;
const handPosition = (match: MatchRuntime, name: string): Position => {
  const index = match.view('A').zones.find(zone => zone.id === 'A:hand')!.items.findIndex(item => item?.kind === 'card' && item.card.name === name);
  assert.ok(index >= 0, `手牌缺少${name}`); return { zoneId: 'A:hand', index };
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await app.inject(body === undefined ? { method: 'GET', url: path } : { method: 'POST', url: path, payload: body as Record<string, unknown> });
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${response.statusCode}: ${response.body}`); return response.json<T>();
}
interface Plan {
  intent?: HumanActionIntent; control?: { id: string; action: 'retry' | 'repair' }; expectedStatus?: 'completed' | 'failed';
  onChoice?: (action: HumanActionView) => { selected: string[]; number?: number };
  verify: (action: HumanActionView) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
}
interface ExecutorCall { name: string; arguments: { command?: { kind: string; mode?: string; count?: number }; choiceIds?: string[]; effectText?: string; effectStep?: string; quantityScopes?: Record<string, unknown>[]; [key: string]: unknown } }
interface ExecutorState {
  messages: { type?: string; name?: string; arguments?: string }[];
  answers: { choice: { id: string; kind: string }; number?: number; identities: string[]; executed?: string[]; quantityUses?: { count: number; scope: string }[]; quantityBindings?: unknown[]; resolution?: unknown }[];
  effectStepUses?: string[];
}
const actionRecords = (match: MatchRuntime, action: HumanActionView) => match.records.filter(record => record.event && action.eventIds.includes(record.event.A.id));
async function executorEvidence(match: MatchRuntime, action: HumanActionView) {
  const state = JSON.parse(await readFile(join(match.directory, 'human-actions', `${action.id}.json`), 'utf8')) as ExecutorState;
  const calls: ExecutorCall[] = state.messages.flatMap(message => message.type === 'function_call' && message.name && message.arguments ? [{ name: message.name, arguments: JSON.parse(message.arguments) as ExecutorCall['arguments'] }] : []);
  return { calls, answers: state.answers, effectStepUses: state.effectStepUses ?? [] };
}
async function perform(name: string, match: MatchRuntime, plan: Plan): Promise<HumanActionView> {
  const started = Date.now(), expectedStatus = plan.expectedStatus ?? 'completed';
  let action = plan.control
    ? await request<HumanActionView>(`${root(match)}/actions/${plan.control.id}/control`, { playerId: 'A', action: plan.control.action })
    : await request<HumanActionView>(`${root(match)}/actions`, { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, intent: plan.intent });
  const entry: CaseRecord = { name, matchId: match.state.id, actionId: action.id, expectedStatus, actualStatus: action.status, status: 'running', elapsedMs: 0, eventIds: [], humanChoices: [] };
  report.cases.push(entry); let last = '';
  try {
    while (Date.now() - started < 600_000) {
      const current = await request<HumanActionView | null>(`${root(match)}/actions/current?playerId=A`);
      assert.ok(current); assert.equal(current.id, action.id); action = current;
      const progress = `${action.status}:${action.eventIds.length}`;
      if (progress !== last) { console.log(JSON.stringify({ case: name, matchId: match.state.id, actionId: action.id, status: action.status, committedSteps: action.eventIds.length, elapsedMs: Date.now() - started })); last = progress; }
      if (action.status === 'awaiting_choice') {
        assert.ok(plan.onChoice, `未预期选择：${action.choice?.title}`);
        const choice = action.choice!, decision = plan.onChoice(action);
        const answer: HumanChoiceAnswer = { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, choiceId: choice.id, selected: decision.selected };
        if (choice.kind === 'number') { if (decision.number === undefined) throw new Error('测试人类未明确数量'); answer.number = decision.number; }
        else assert.equal(decision.number, undefined);
        entry.humanChoices.push({ choiceId: choice.id, title: choice.title, kind: choice.kind, minimum: choice.minimum, maximum: choice.maximum, options: choice.options.map(option => ({ id: option.id, label: option.label, ...(option.position ? { position: option.position } : {}), ...(option.card ? { cardName: option.card.name } : {}) })), selected: [...decision.selected], ...(decision.number === undefined ? {} : { number: decision.number }), revision: answer.revision });
        await request<HumanActionView>(`${root(match)}/actions/${action.id}/choice`, answer);
      } else if (['completed', 'failed', 'cancelled'].includes(action.status)) {
        entry.actualStatus = action.status; entry.elapsedMs = Date.now() - started; entry.eventIds = action.eventIds;
        if (action.error) entry.error = action.error;
        assert.equal(action.status, expectedStatus, `${name}：${action.error ?? action.status}`);
        const evidence = await plan.verify(action); if (evidence) entry.evidence = evidence;
        entry.status = 'passed'; return action;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`${name}超过600秒，现场已保留`);
  } catch (error) {
    entry.actualStatus = action.status; entry.elapsedMs = Date.now() - started; entry.eventIds = action.eventIds; entry.status = 'failed'; entry.error = error instanceof Error ? error.message : String(error); throw error;
  }
}
function ruleRejected(action: HumanActionView) {
  assert.equal(action.eventIds.length, 0); assert.match(action.error ?? '', /能量|费用/u);
  assert.doesNotMatch(action.error ?? '', /模型流|连接|超时|function_call|tool_call|回执/u);
}
try {
  await captureFixtureFacts(main);
  const source = handPosition(main, practiceEnergy.name), energyId = main.state.zones['A:hand']!.contents.items[source.index]!.id;
  const attach = await perform(plannedCases[0]!, main, { intent: { kind: 'attach', source, target: { zoneId: 'A:active', index: 0 } }, verify: () => assert.ok(main.state.groups['practice:A:active:0']!.attached.includes(energyId)) });
  const beforeReview = { attached: [...main.state.groups['practice:A:active:0']!.attached], hand: handIds(main) };
  await perform(plannedCases[1]!, main, { control: { id: attach.id, action: 'repair' }, verify: () => { assert.deepEqual(main.state.groups['practice:A:active:0']!.attached, beforeReview.attached); assert.deepEqual(handIds(main), beforeReview.hand); } });
  const beforeSearch = energyCount(main); let selectedEnergy = 0;
  await perform(plannedCases[2]!, main, { intent: { kind: 'play', source: handPosition(main, practiceSearch.name) }, onChoice: action => {
    const choice = action.choice!; assert.equal(energyCount(main), beforeSearch, '人类确认前不得检索选牌');
    if (choice.kind === 'number') { assert.ok(choice.minimum <= 2 && choice.maximum >= 2); return { selected: [], number: 2 }; }
    assert.equal(choice.kind, 'select'); const options = choice.options.filter(option => option.card?.kind === 'energy'); assert.ok(options.length >= 2); selectedEnergy = 2; return { selected: options.slice(0, 2).map(option => option.id) };
  }, verify: () => { assert.equal(selectedEnergy, 2); assert.equal(energyCount(main), beforeSearch + 2); } });
  const beforeAbility = handCount(main);
  await perform(plannedCases[3]!, main, { intent: { kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 }, verify: () => assert.equal(handCount(main), beforeAbility + 1) });
  const basicSource = handPosition(main, practiceBasic.name), basicId = main.state.zones['A:hand']!.contents.items[basicSource.index]!.id;
  await perform(plannedCases[4]!, main, { intent: { kind: 'play', source: basicSource, target: { zoneId: 'A:bench', index: 2 } }, verify: () => { const object = main.state.zones['A:bench']!.contents.items[2]; assert.equal(object?.kind, 'group'); assert.ok(main.state.groups[object!.id]!.stack.includes(basicId)); } });
  report.placementInPlayFacts = await inPlayFacts(main);
  for (const fact of report.placementInPlayFacts) assert.equal(fact.firstInPlay?.turn, fact.position.zoneId === 'A:bench' && fact.position.index === 2 ? 3 : 1, '新放置与既有场上卡牌组的在场时点必须区分');
  const evolutionSource = handPosition(main, practiceEvolution.name), evolutionId = main.state.zones['A:hand']!.contents.items[evolutionSource.index]!.id;
  await perform(plannedCases[5]!, main, { intent: { kind: 'evolve', source: evolutionSource, target: { zoneId: 'A:active', index: 0 } }, verify: () => { assert.equal(main.state.groups['practice:A:active:0']!.stack.at(-1), evolutionId); assert.ok(main.state.groups['practice:A:active:0']!.attached.includes(energyId)); } });
  const attack: HumanActionIntent = { kind: 'attack', source: { zoneId: 'A:active', index: 0 }, attackIndex: 0, target: { zoneId: 'B:active', index: 0 } };
  await perform(plannedCases[6]!, main, { intent: attack, verify: () => { assert.equal(main.state.groups['practice:B:active:0']!.state.damageCounters, 3); assert.equal(main.state.flow.turnOwner, 'B'); } });
  const illegal = await seed('real-rule-rejection'), originalHand = handIds(illegal);
  const rejection = await perform(plannedCases[7]!, illegal, { intent: attack, expectedStatus: 'failed', verify: action => { ruleRejected(action); assert.deepEqual(handIds(illegal), originalHand); assert.deepEqual(illegal.state.groups['practice:A:active:0']!.attached, []); } });
  await perform(plannedCases[8]!, illegal, { control: { id: rejection.id, action: 'retry' }, expectedStatus: 'failed', verify: action => { ruleRejected(action); assert.deepEqual(handIds(illegal), originalHand); assert.deepEqual(illegal.state.groups['practice:A:active:0']!.attached, []); } });
  const poison = await seed('real-check-poisoned', { poisoned: true });
  await perform(plannedCases[9]!, poison, { intent: { kind: 'end_turn' }, verify: () => { assert.equal(poison.state.groups['practice:A:active:0']!.state.damageCounters, 1); assert.deepEqual(poison.state.groups['practice:A:active:0']!.state.specialConditions, ['poisoned']); assert.equal(poison.state.flow.turnOwner, 'B'); assert.equal(poison.state.flow.turnNumber, 4); } });
  const handoff = await seed('real-handoff-explicit', { handoff: true }), replacement = handoff.state.zones['A:bench']!.contents.items[4]!.id;
  await perform(plannedCases[10]!, handoff, { intent: { kind: 'resolve_handoff', source: { zoneId: 'A:bench', index: 4 }, target: { zoneId: 'A:active', index: 0 } }, verify: () => { assert.equal(handoff.state.zones['A:active']!.contents.items[0]?.id, replacement); assert.equal(handoff.state.zones['A:bench']!.contents.items[4], null); assert.equal(handoff.state.flow.operator, 'B'); assert.equal(handoff.state.flow.turnOwner, 'B'); assert.equal(handoff.state.flow.turnNumber, 4); assert.equal(handoff.state.flow.handoffReturnTo, null); } });
  const choiceHandoff = await seed('real-handoff-human-choice', { handoff: true }), chosenReplacement = choiceHandoff.state.zones['A:bench']!.contents.items[4]!.id; let handoffChoices = 0;
  await perform(plannedCases[11]!, choiceHandoff, { intent: { kind: 'resolve_handoff' }, onChoice: action => { handoffChoices++; assert.equal(choiceHandoff.state.zones['A:active']!.contents.items[0], null); const choice = action.choice!; assert.equal(choice.kind, 'select'); assert.equal(choice.minimum, 1); assert.equal(choice.maximum, 1); const option = choice.options.find(option => option.position?.zoneId === 'A:bench' && option.position.index === 4); assert.ok(option); return { selected: [option.id] }; }, verify: () => { assert.equal(handoffChoices, 1); assert.equal(choiceHandoff.state.zones['A:active']!.contents.items[0]?.id, chosenReplacement); assert.equal(choiceHandoff.state.flow.operator, 'B'); assert.equal(choiceHandoff.state.flow.turnOwner, 'B'); assert.equal(choiceHandoff.state.flow.handoffReturnTo, null); } });
  const number = await seed('real-human-number', { extraHand: ['number'] }), numberDeck = deckIds(number).length, numberHand = handCount(number); let numberChoices = 0;
  await perform(plannedCases[12]!, number, { intent: { kind: 'play', source: handPosition(number, practiceNumber.name) }, onChoice: action => { numberChoices++; assert.equal(deckIds(number).length, numberDeck); assert.equal(action.choice!.kind, 'number'); assert.equal(action.choice!.maximum, 3); return { selected: [], number: 3 }; }, verify: () => { assert.equal(numberChoices, 1); assert.equal(deckIds(number).length, numberDeck - 3); assert.equal(handCount(number), numberHand - 1 + 3); } });
  const order = await seed('real-human-order', { extraHand: ['order'] }), originalTop = deckIds(order).slice(0, 3), orderDeck = deckIds(order).length, orderHand = handCount(order); let orderChoices = 0;
  await perform(plannedCases[13]!, order, { intent: { kind: 'play', source: handPosition(order, practiceOrder.name) }, onChoice: action => { orderChoices++; const choice = action.choice!; assert.equal(choice.kind, 'order'); assert.equal(choice.minimum, 3); assert.equal(choice.maximum, 3); assert.deepEqual(deckIds(order).slice(0, 3), originalTop); const selected = [2, 1, 0].map(index => { const option = choice.options.find(option => option.position?.zoneId === 'A:deck' && option.position.index === index); assert.ok(option?.card); return option.id; }); return { selected }; }, verify: () => { assert.equal(orderChoices, 1); assert.deepEqual(deckIds(order).slice(0, 3), [...originalTop].reverse()); assert.equal(deckIds(order).length, orderDeck); assert.equal(handCount(order), orderHand - 1); } });
  const coins = await seed('real-segmented-coins', { extraHand: ['coins'] }); let coinNumberChoices = 0;
  const optionalCoinStep = '你可以选择投掷1至3次硬币', fixedCoinStep = '然后投掷1次硬币';
  const coinEffect = practiceCoins.kind === 'trainer' ? practiceCoins.text : '';
  await perform(plannedCases[14]!, coins, { intent: { kind: 'play', source: handPosition(coins, practiceCoins.name) }, onChoice: action => {
    assert.equal(actionRecords(coins, action).filter(record => record.request?.command.kind === 'random').length, 0, '人选数量前不得投掷');
    const choice = action.choice!;
    if (choice.kind === 'select') { const option = choice.options.find(option => /投掷|执行|是/u.test(option.label) && !/不|跳过|否/u.test(option.label)); assert.ok(option, '测试人类应能明确选择执行可选部分'); return { selected: [option.id] }; }
    assert.equal(choice.kind, 'number'); coinNumberChoices++; assert.ok(choice.minimum <= 2 && choice.maximum >= 2); return { selected: [], number: 2 };
  }, verify: async action => {
    assert.equal(coinNumberChoices, 1);
    const randomRecords = actionRecords(coins, action).filter(record => record.request?.command.kind === 'random');
    const actualCounts = randomRecords.map(record => { const receipt = record.receipt; assert.ok(receipt?.status === 'committed'); return (receipt.result as { coins: unknown[] }).coins.length; });
    assert.deepEqual(actualCounts, [2, 1], '同模式的可选与固定分句应分别成功执行一次');
    const evidence = await executorEvidence(coins, action), answer = evidence.answers.find(answer => answer.choice.kind === 'number'); assert.ok(answer);
    assert.deepEqual(answer.quantityUses?.map(use => use.count), [2]);
    const requestCall = evidence.calls.find(call => call.name === 'request_choice' && call.arguments.kind === 'number'); assert.ok(requestCall);
    assert.equal(requestCall.arguments.effectText, coinEffect);
    assert.ok(requestCall.arguments.quantityScopes?.some(scope => scope.kind === 'random' && scope.mode === 'coins' && scope.effectStep === optionalCoinStep));
    const executions = evidence.calls.flatMap(call => call.name === 'execute_atomic' ? [call.arguments]
      : call.name === 'execute_sequence' && Array.isArray(call.arguments.steps) ? call.arguments.steps as ExecutorCall['arguments'][] : []);
    for (const [count, step] of [[2, optionalCoinStep], [1, fixedCoinStep]] as const) {
      const execution = executions.find(args => args.command?.kind === 'random' && args.command.count === count && args.effectStep === step && args.effectText === coinEffect); assert.ok(execution);
      assert.equal(execution.choiceIds?.includes(answer.choice.id), count === 2, '固定投1不得借用前段数量选择');
    }
    assert.equal(evidence.effectStepUses.length, 2); return { actualCounts, ...evidence };
  } });
  const selected = await seed('real-selected-card-completion'), beforeSelectedHand = handCount(selected), beforeSelectedDeck = deckIds(selected).length;
  const selectedSource = handPosition(selected, practiceSearch.name), selectedSourceId = selected.state.zones['A:hand']!.contents.items[selectedSource.index]!.id;
  let selectedId = '', selectedChoiceId = '', selectionCount = 0;
  await perform(plannedCases[15]!, selected, { intent: { kind: 'play', source: selectedSource }, onChoice: action => {
    assert.equal(handCount(selected), beforeSelectedHand - (handIds(selected).includes(selectedSourceId) ? 0 : 1), '确认前不得把候选加入手牌');
    const choice = action.choice!;
    if (choice.kind === 'number') { assert.ok(choice.minimum <= 1 && choice.maximum >= 1); return { selected: [], number: 1 }; }
    assert.equal(choice.kind, 'select'); selectionCount++;
    const option = choice.options.find(option => option.card?.kind === 'energy' && option.position?.zoneId === 'A:deck'); assert.ok(option?.position);
    selectedId = selected.state.zones['A:deck']!.contents.items[option.position.index]!.id; selectedChoiceId = choice.id; return { selected: [option.id] };
  }, verify: async action => {
    assert.equal(selectionCount, 1); assert.ok(handIds(selected).includes(selectedId)); assert.equal(handCount(selected), beforeSelectedHand); assert.equal(deckIds(selected).length, beforeSelectedDeck - 1);
    assert.ok(selected.state.zones['A:discard']!.contents.items.some(item => item?.id === selectedSourceId));
    const path = actionRecords(selected, action).flatMap(record => {
      const command = record.request?.command as GameCommand | undefined, before = selected.records[record.sequence - 1]!.state;
      if (command?.kind !== 'move' && command?.kind !== 'show') return [];
      const objects = resolveSelection(before, command.kind === 'move' ? command.source : command.selection);
      return objects.some(object => object.kind === 'card' && object.id === selectedId) ? [{ sequence: record.sequence, kind: command.kind, ...(command.kind === 'move' ? { destination: command.destination.container } : {}) }] : [];
    });
    assert.ok(path.some(step => step.kind === 'show')); assert.ok(path.some(step => step.kind === 'move' && step.destination?.kind === 'zone' && step.destination.zoneId === 'A:hand'));
    assert.ok(actionRecords(selected, action).some(record => record.request?.command.kind === 'shuffle'));
    const evidence = await executorEvidence(selected, action), answer = evidence.answers.find(answer => answer.choice.id === selectedChoiceId); assert.ok(answer);
    assert.ok(answer.executed?.includes(`card:${selectedId}`), '选牌必须在确认后以choiceId成功执行');
    return { selectedId, selectedChoiceId, path, ...evidence };
  } });
  assert.equal(report.cases.length, plannedCases.length); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await app.close(); report.finalSourceHash = await runtimeFingerprint(); report.finalPromptVersion = (await app.gameService.prompts()).version!;
  report.finalFixtureHash = await hashFile(new URL('./human-action-fixtures.ts', import.meta.url)); report.finalScriptHash = await hashFile(new URL(import.meta.url));
  if (report.sourceHash !== report.finalSourceHash || report.promptVersion !== report.finalPromptVersion || report.fixtureHash !== report.finalFixtureHash || report.scriptHash !== report.finalScriptHash) { report.status = 'source_changed'; process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  await writeFile(join(directory, 'report.md'), `# 人类操作代理真实验证\n\n状态：${report.status}\n\n模型：${report.model} / ${report.effort} / fast=${report.fast}\n\n源码：${report.sourceHash}\n\n提示词：${report.promptVersion}\n\n${report.cases.map(row => `- ${row.name}：${row.status}（实际 ${row.actualStatus}，预期 ${row.expectedStatus}）；${row.elapsedMs} ms；对局 ${row.matchId}；行动 ${row.actionId}`).join('\n')}\n\n${report.error ?? ''}\n\n原始轨迹与对局保存在本目录 data/matches/，未运行项目仍列在 report.json 的 plannedCases 中；不改写历史验证原件。\n`, { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, passed: report.cases.filter(row => row.status === 'passed').length, planned: plannedCases.length, report: join(directory, 'report.json'), ...(report.error ? { error: report.error } : {}) }));
}
