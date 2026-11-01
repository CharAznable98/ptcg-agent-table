import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { runtimeFingerprint } from '../apps/server/src/runtime-fingerprint.ts';
import { seedHumanScenario, practiceBasic, practiceEnergy, practiceOther, practiceSearch } from './human-action-fixtures.ts';
import type { HumanActionIntent, HumanActionView, HumanActionChoice, Position } from '../packages/protocol/src/index.ts';

const directory = resolve(process.argv[2]!);
await mkdir(directory, { recursive: false });
const app = await buildApp({ dataDir: join(directory, 'data'), systemDir: resolve('system') });
const sourceHash = await runtimeFingerprint();
const rules = await Promise.all(['规则基准', '卡牌说明文语义', '赛场规则摘要'].map(async name => ({ file: `rules/${name}.md`, sha256: createHash('sha256').update(await readFile(`rules/${name}.md`)).digest('hex') })));
const scriptHash = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const report: { sourceHash: string; finalSourceHash?: string; promptHash: string; model: string; effort: string; fast: boolean; cases: Record<string, unknown>[]; status: string; error?: string } = {
  sourceHash, promptHash: createHash('sha256').update(await readFile('system/prompts.json')).digest('hex'), model: 'gpt-6.1-terra', effort: 'medium', fast: false, cases: [], status: 'running',
};
async function traceRows(directory: string): Promise<Record<string, unknown>[]> {
  try { return (await readFile(join(directory, 'human-agent-trace.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
try {
  const main = await seedHumanScenario(app.gameService, 'refinement-comparison');
  assert.equal(main.meta.model.model, report.model); assert.equal(main.meta.model.reasoningEffort, report.effort); assert.equal(main.meta.model.fast, false);
  const hand = (name: string) => ({ zoneId: 'A:hand', index: main.view('A').zones.find(zone => zone.id === 'A:hand')!.items.findIndex(item => item?.kind === 'card' && item.card.name === name) });
  for (const [name, intent] of [
    ['附能', { kind: 'attach', source: hand(practiceEnergy.name), target: { zoneId: 'A:active', index: 0 } }],
    ['基础出场', null],
    ['结束回合', { kind: 'end_turn' }],
  ] as [string, HumanActionIntent | null][]) {
    const started = Date.now(), traceStart = (await traceRows(main.directory)).length;
    const actual = intent ?? { kind: 'play', source: hand(practiceBasic.name), target: { zoneId: 'A:bench', index: 2 } };
    const response = await app.inject({ method: 'POST', url: `/api/matches/${main.state.id}/actions`, payload: { playerId: 'A', requestId: randomUUID(), revision: main.state.revision, intent: actual } });
    assert.equal(response.statusCode, 202, response.body);
    const action = response.json<HumanActionView>();
    const controller = app.gameService.humanController(main, 'A');
    let current = controller.view('A')!;
    while (current.status === 'running' && Date.now() - started < 300_000) { await new Promise(resolve => setTimeout(resolve, 100)); current = controller.view('A')!; }
    assert.equal(current.id, action.id); assert.equal(current.status, 'completed', JSON.stringify(current));
    const state = JSON.parse(await readFile(join(main.directory, 'human-actions', `${action.id}.json`), 'utf8')) as { modelCalls: number; messages: unknown[] };
    const trace = (await readFile(join(main.directory, 'human-agent-trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as Record<string, unknown>[];
    const measurements = trace.slice(traceStart).filter(row => row.kind === 'model_finished' && (String(row.sessionId).includes(action.id) || row.sessionId === `human:${main.state.id}:A`));
    report.cases.push({ name, actionId: action.id, elapsedMs: Date.now() - started, modelCalls: state.modelCalls, committedSteps: current.eventIds.length, status: current.status, tokenUsage: measurements.map(row => row.tokenUsage) });
    console.log(JSON.stringify(report.cases.at(-1)));
  }

  const effects = await seedHumanScenario(app.gameService, 'refinement-effects', { attachedEnergy: true });
  const effectHand = (name: string): Position => ({ zoneId: 'A:hand', index: effects.view('A').zones.find(zone => zone.id === 'A:hand')!.items.findIndex(item => item?.kind === 'card' && item.card.name === name) });
  async function performEffect(name: string, intent: HumanActionIntent, decide?: (choice: HumanActionChoice) => string[]) {
    const started = Date.now(), beforeRows = await traceRows(effects.directory);
    const controller = app.gameService.humanController(effects, 'A');
    const action = await controller.start({ playerId: 'A', requestId: randomUUID(), revision: effects.state.revision, intent });
    const decisions: unknown[] = [];
    let current = action;
    while (Date.now() - started < 300_000) {
      current = controller.view('A')!;
      if (current.status === 'awaiting_choice') {
        assert.ok(decide); const choice = current.choice!, selected = decide(choice); decisions.push({ choice, selected });
        await controller.answer(action.id, { playerId: 'A', requestId: randomUUID(), revision: effects.state.revision, choiceId: choice.id, selected });
      } else if (current.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(current.status, 'completed', JSON.stringify(current));
    const state = JSON.parse(await readFile(join(effects.directory, 'human-actions', `${action.id}.json`), 'utf8'));
    const rows = (await traceRows(effects.directory)).slice(beforeRows.length).filter(row => row.kind === 'model_finished' && row.sessionId === `human:${effects.state.id}:A`);
    const tokenUsage = rows.map(row => row.tokenUsage);
    report.cases.push({ name, matchId: effects.state.id, actionId: action.id, elapsedMs: Date.now() - started, modelCalls: state.modelCalls, committedSteps: current.eventIds.length, humanChoices: decisions, tokenUsage, status: 'completed' });
    console.log(JSON.stringify(report.cases.at(-1)));
  }
  const beforeAbility = effects.state.zones['A:hand']!.contents.items.length;
  await performEffect('主动特性', { kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  assert.equal(effects.state.zones['A:hand']!.contents.items.length, beforeAbility + 1);
  const beforeSearch = effects.state.zones['A:deck']!.contents.items.length;
  await performEffect('训练家检索等待人选', { kind: 'play', source: effectHand(practiceSearch.name) }, choice => {
    assert.equal(choice.kind, 'select'); assert.equal(effects.state.zones['A:deck']!.contents.items.length, beforeSearch);
    const options = choice.options.filter(option => option.card?.kind === 'energy'); assert.ok(options.length >= 2); return options.slice(-2).map(option => option.id);
  });
  assert.equal(effects.state.zones['A:deck']!.contents.items.length, beforeSearch - 2);
  await performEffect('主动招式及检查交权', { kind: 'attack', source: { zoneId: 'A:active', index: 0 }, attackIndex: 0, target: { zoneId: 'B:active', index: 0 } });
  assert.equal(effects.state.groups['practice:B:active:0']!.state.damageCounters, 3); assert.equal(effects.state.flow.turnOwner, 'B');
  const response = await app.inject({ method: 'POST', url: '/api/matches', payload: { mode: 'local', players: ['甲', '乙'].map(name => ({ name, kind: 'human', deck: { cards: [{ card: practiceOther, count: 60 }] } })) } });
  assert.equal(response.statusCode, 200, response.body);
  const fresh = app.gameService.match(response.json().match.id);
  let finalPlacementAt = 0;
  while (fresh.state.flow.choice) {
    const choice = fresh.state.flow.choice;
    const command = choice.kind === 'choose_first' ? { kind: 'choose_first', firstPlayer: 'A' } : { kind: 'initial_placement', active: { zoneId: `${choice.playerId}:hand`, index: 0 }, bench: [] };
    const receipt = await app.inject({ method: 'POST', url: `/api/matches/${fresh.state.id}/commands`, payload: { playerId: choice.playerId, requestId: randomUUID(), revision: fresh.state.revision, command } });
    assert.equal(receipt.statusCode, 200, receipt.body); finalPlacementAt = Date.now();
  }
  await app.gameService.prepareHumanTurn(fresh);
  const opening = app.gameService.humanController(fresh, 'A').view('A')!; assert.equal(opening.status, 'completed');
  const openingState = JSON.parse(await readFile(join(fresh.directory, 'human-actions', `${opening.id}.json`), 'utf8'));
  assert.equal(openingState.modelCalls, 0); assert.equal(fresh.state.zones['A:hand']!.contents.items.length, 7); assert.equal(opening.eventIds.length, 1);
  report.cases.push({ name: '准备完成后自动首抽', matchId: fresh.state.id, actionId: opening.id, elapsedMs: Date.now() - finalPlacementAt, modelCalls: openingState.modelCalls, committedSteps: opening.eventIds.length, status: opening.status });
  await writeFile(join(directory, 'sources.json'), JSON.stringify({ sourceHash, rules, scriptHash, promptHash: report.promptHash }, null, 2), { flag: 'wx' });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await app.close(); report.finalSourceHash = await runtimeFingerprint();
  if (report.sourceHash !== report.finalSourceHash) { report.status = 'source_changed'; process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ report: join(directory, 'report.json'), status: report.status }));
}
