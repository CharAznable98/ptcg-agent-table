import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentRuntime, FileSessionStore, JsonlTrace, SecretRedactor, atomicJson, createModel, loadModelConfig, loadPrompts } from '../packages/agent/src/index.ts';
import type { MatchPort, ModelGateway, ModelItem, ModelRequest } from '../packages/agent/src/types.ts';
import { GameService } from '../apps/server/src/service.ts';
import { asJson } from '../apps/server/src/match.ts';
import type { DeckData, PlayerId } from '../packages/protocol/src/index.ts';

// 限时的真实接入验证；只用合成资料和独立目录，不启动生产服务或完整对局。
const root = resolve(import.meta.dirname, '..');
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-throughput-' + randomUUID().slice(0, 6);
const directory = join(root, 'artifacts/agent-validation', runId);
await mkdir(directory, { recursive: true });
async function files(path: string): Promise<string[]> {
  return (await Promise.all((await readdir(path, { withFileTypes: true })).map(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]))).flat();
}
const sourceFiles = [
  'package.json', 'package-lock.json', 'scripts/validate-throughput.ts', 'system/agent.example.json', 'system/prompts.json', 'system/prompts.example.json',
  ...(await Promise.all(['packages/agent', 'packages/game-core/src', 'packages/protocol/src', 'apps/server/src', 'rules'].map(path => files(join(root, path))))).flat().map(path => path.slice(root.length + 1)),
];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
const sourceHashes = await hashes();
await atomicJson(join(directory, 'source-manifest.json'), sourceHashes);
const redactor = new SecretRedactor(), trace = new JsonlTrace(join(directory, 'trace.jsonl'), redactor);
const config = { ...await loadModelConfig(join(root, 'system/agent.example.json')), timeoutMs: 45_000, maxRetries: 0 };
assert.equal(config.model, 'gpt-6.1-terra'); assert.equal(config.reasoningEffort, 'medium'); assert.equal(config.fast, false);
const prompts = await loadPrompts(join(root, 'system/prompts.json'));
await atomicJson(join(directory, 'prompts.json'), prompts);
const gateway = createModel(config, trace, redactor), requests: ModelRequest[] = [];
const signal = AbortSignal.timeout(120_000);
const model: ModelGateway = { async generate(request) {
  assert.ok(requests.length < 8, '验证最多八次模型调用');
  requests.push({ ...request, input: structuredClone(request.input) });
  return gateway.generate({ ...request, signal });
} };
const basic = { name: '吞吐验证宝可梦（合成）', kind: 'pokemon' as const, hp: 60, types: ['火'], stage: '基础', abilities: [], attacks: [{ name: '无效果', energyCost: [], damageText: '0', text: '合成资料用于验证固定卡组只装配一次。'.repeat(250) }], weaknesses: [], resistances: [], retreatCost: 0 };
const deck: DeckData = { name: '吞吐合成卡组', cards: [{ card: basic, count: 60 }] };
const hiddenName = 'B_PRIVATE_SYNTHETIC_86142';
const otherDeck: DeckData = { name: '隐藏合成卡组', cards: [{ card: { ...basic, name: '对手合成宝可梦', attacks: [] }, count: 59 }, { card: { kind: 'trainer', name: hiddenName, subtype: 'item', text: '未公开合成牌' }, count: 1 }] };
const service = new GameService({ dataDir: join(directory, 'data'), systemDir: join(directory, 'system'), rulesDir: join(root, 'rules') });
const startedAt = Date.now();
try {
  await service.init();
  const game = await service.createMatch({ mode: 'local', autoRun: false, players: [{ name: '合成甲', kind: 'human', deck }, { name: '合成乙', kind: 'human', deck: otherDeck }] });
  const match = service.match(game.match.id);
  for (let i = 0; i < 5 && match.state.flow.choice; i++) {
    const choice = match.state.flow.choice, actor = choice.playerId;
    const position = match.view(actor).zones.find(z => z.id === `${actor}:hand`)!.items.find(item => item?.kind === 'card' && item.card.kind === 'pokemon');
    const command = choice.kind === 'choose_first' ? { kind: 'choose_first' as const, firstPlayer: 'A' as const } : { kind: 'initial_placement' as const, active: position!.position, bench: [] };
    const receipt = await match.command(actor, { requestId: randomUUID(), revision: match.state.revision, command });
    assert.equal(receipt.status, 'committed');
  }
  assert.equal(match.state.flow.operator, 'A');
  const readyCursor = (await match.observe(match.state.id, 'A', null)).cursor;
  const names = Array.from({ length: 16 }, (_, n) => `合成步骤${n + 1}`);
  const completed = () => names.every((name, n) => match.state.playerMarkers.A?.[name] === n + 1);
  const port: MatchPort = {
    async observe(matchId, playerId, after) {
      const frame = await match.observe(matchId, playerId, after ?? readyCursor);
      const marking = !completed();
      const task = marking ? '这是操作吞吐验证片段。依次给玩家A设置16个独立marker：合成步骤1=1，依次至合成步骤16=16。只调用set_state，target为player A，field.key为marker。操作之间没有随机或开牌。优先用execute_sequence提交每批8步，一共两批。不要修改牌面或报告对局胜负。' : match.state.flow.phase === 'check' ? '阶段参数验证：检查已完成，请用set_turn进入B的回合（phase=turn，playerId=B）。不要报告胜负。' : '阶段参数验证：现在请用set_turn进入回合间检查（phase=check，playerId=null）。不要报告胜负。';
      return { ...frame, snapshot: asJson({ ...frame.snapshot as object, task }), tools: frame.tools.filter(t => t.name === (marking ? 'set_state' : 'set_turn')), status: !marking && match.state.flow.turnOwner === 'B' ? 'waiting' : frame.status };
    },
    async execute(request) {
      if (request.tool === 'set_turn') {
        assert.ok(completed());
        assert.deepEqual(request.arguments, match.state.flow.phase === 'check' ? { phase: 'turn', playerId: 'B' } : { phase: 'check', playerId: null });
        return match.execute(request);
      }
      assert.equal(request.tool, 'set_state');
      const args = request.arguments as { target: { kind: string; playerId: PlayerId }; field: { key: string; name: string; value: number } };
      assert.deepEqual(args.target, { kind: 'player', playerId: 'A' }); assert.equal(args.field.key, 'marker');
      assert.equal(args.field.value, names.indexOf(args.field.name) + 1); assert.ok(names.includes(args.field.name));
      assert.equal(match.state.playerMarkers.A?.[args.field.name], undefined, '不得重复执行已完成步骤');
      return match.execute(request);
    },
  };
  const store = new FileSessionStore(join(directory, 'contexts'));
  const runtime = new AgentRuntime({ model, match: port, store, trace, prompts, limits: { maxDecisionsPerActivation: 6, maxTotalModelCalls: 8 } });
  await runtime.create({ matchId: match.state.id, playerId: 'A', deck: asJson(deck), strategy: { version: 1, content: '' }, rules: service.rulesText() });
  const result = await runtime.activate(match.state.id, 'A', signal);
  assert.equal(result.status, 'waiting', result.reason); assert.ok(completed()); assert.ok(result.decisions <= 6);
  const before = (await store.load(match.state.id, 'A'))!;
  assert.equal(before.toolCalls, 18); assert.equal(before.compactions, 0, '固定资料不应触发压缩');
  await runtime.compact(match.state.id, 'A');
  const first = (await store.load(match.state.id, 'A'))!;
  const declared = await match.execute({ matchId: match.state.id, playerId: 'B', requestId: randomUUID(), revision: match.state.revision, tool: 'declare', arguments: { text: '新增的合成增量事实：验证标识 9247。' } });
  assert.equal(declared.status, 'committed');
  assert.equal((await runtime.activate(match.state.id, 'A', signal)).decisions, 0);
  await runtime.compact(match.state.id, 'A');
  const final = (await store.load(match.state.id, 'A'))!;
  const compactInputs = requests.filter(r => r.role === 'compactor').map(r => JSON.parse(r.input[0]!.content as string));
  assert.equal(final.compactions, 2); assert.ok(compactInputs.length >= 2 && compactInputs.length <= 4);
  const secondInputs = compactInputs.filter(input => input.previousSummary !== null);
  assert.ok(secondInputs.length >= 1);
  for (const input of secondInputs) { assert.deepEqual({ ...input.previousSummary, evidenceRefs: input.previousSummary.evidenceRefs.map((ref: string) => input.evidenceSources[ref]) }, first.summary); assert.equal(input.observations.length, 1); assert.equal(input.toolHistory.length, 0); }
  assert.match(final.summary!.text, /9247/); assert.equal(final.observations.length, before.observations.length + 1);
  const count = requests.length; await runtime.compact(match.state.id, 'A'); assert.equal(requests.length, count);
  for (const request of requests.filter(r => r.role === 'player')) {
    const users = request.input.filter(m => m.role === 'user').map(m => JSON.parse(m.content as string));
    assert.equal(users.filter(m => m.snapshot).length, 1); assert.equal(users.filter(m => m.deck).length, 1);
    assert.equal(users.find(m => m.snapshot).snapshot.ownDeck, undefined);
  }
  const events = (await readFile(trace.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  const starts = events.filter(e => e.kind === 'model_started'), finishes = events.filter(e => e.kind === 'model_finished');
  assert.equal(starts.length, finishes.length);
  for (const event of starts) {
    const body = event.request as { model: string; service_tier: string; reasoning: { effort: string }; input: ModelItem[] };
    assert.equal(body.model, 'gpt-6.1-terra'); assert.equal(body.service_tier, 'default'); assert.equal(body.reasoning.effort, 'medium');
    assert.ok(!JSON.stringify(body).includes(hiddenName), '不能向A泄露B的隐藏牌名');
  }
  assert.deepEqual(await hashes(), sourceHashes, '验证期间源码与规则不得变化');
  await atomicJson(join(directory, 'source-manifest-after.json'), await hashes());
  for (const path of await files(directory)) { const content = await readFile(path, 'utf8'); assert.equal(content, redactor.clean(content), '凭证不得进入记录'); }
  const manifest = { status: 'passed', runId, model: config.model, reasoningEffort: config.reasoningEffort, fast: config.fast, promptVersion: prompts.version, elapsedMs: Date.now() - startedAt,
    playerDecisions: result.decisions, atomicCommands: before.toolCalls, automaticCompactions: before.compactions, explicitCompactions: final.compactions,
    modelCalls: starts.length, structuredRetries: events.filter(e => e.kind === 'structured_rejected').length, retainedObservations: final.observations.length, retainedToolHistory: final.toolHistory.length, secondCompactionObservations: secondInputs[0]!.observations.length,
    calls: finishes.map(e => ({ role: e.role, elapsedMs: e.elapsedMs, usage: (e.response as Record<string, unknown>).usage })),
    checks: { singleSnapshotAndDeck: true, deltaOnlyCompaction: true, previousSummaryMerged: true, originalHistoryRetained: true, sourceHashesUnchanged: true, hiddenOpponentCardExcluded: true, validPhaseArguments: true, credentialLeaks: 0 },
    scope: '真实模型与真实MatchRuntime；16个合成标记操作、两次阶段切换及增量压缩。未验证完整对局、策略强度或全部卡文。' };
  await atomicJson(join(directory, 'manifest.json'), manifest);
  console.log(JSON.stringify({ status: manifest.status, runId, elapsedMs: manifest.elapsedMs, atomicCommands: manifest.atomicCommands, playerDecisions: manifest.playerDecisions, automaticCompactions: manifest.automaticCompactions, explicitCompactions: manifest.explicitCompactions, modelCalls: manifest.modelCalls }));
} catch (error) {
  const safe = redactor.clean({ message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  await atomicJson(join(directory, 'manifest.json'), { status: 'failed', runId, elapsedMs: Date.now() - startedAt, error: safe });
  console.error('VALIDATION_FAILED', safe); process.exitCode = 1;
} finally { await service.close(); console.log(`EVIDENCE ${directory}`); }
