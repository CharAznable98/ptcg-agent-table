import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { HumanActionController } from '../src/human-actions.ts';
import { MatchRuntime } from '../src/match.ts';
import { humanTurnStart } from '../src/human-turn-start.ts';
import { seedHumanScenario } from '../../../scripts/human-action-fixtures.ts';
import type { ModelReply, ModelRequest } from '../../../packages/agent/src/index.ts';
import type { CardData, GameCommand, HumanActionView, PlayerId } from '../../../packages/protocol/src/index.ts';

const simple: CardData = { kind: 'pokemon', name: '合成开局宝可梦', hp: 80, stage: '基础', types: ['草'], abilities: [], attacks: [], weaknesses: [], resistances: [], retreatCost: 0 };
function tool(name: string, args: unknown): ModelReply { const callId = randomUUID(), argumentsJson = JSON.stringify(args); return { id: randomUUID(), model: 'test', output: [{ type: 'function_call', call_id: callId, name, arguments: argumentsJson }], calls: [{ callId, name, arguments: argumentsJson }], usage: null }; }
const step = (command: GameCommand, choiceIds: string[] = [], effectText?: string) => ({ command, choiceIds, ...(effectText ? { effectText } : {}) });
const draw = (to = 'hand'): GameCommand => ({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: `A:${to}` }, index: 'end' } });
async function fixture(t: TestContext, card = simple, generate: (request: ModelRequest) => Promise<ModelReply> | ModelReply = () => { throw new Error('普通开局不应请求模型'); }) {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-turn-start-'));
  const app = await buildApp({ dataDir: join(directory, 'data'), systemDir: join(directory, 'system'), modelFactory: () => ({ generate: async request => generate(request) }) });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const response = await app.inject({ method: 'POST', url: '/api/matches', payload: { mode: 'local', players: ['甲', '乙'].map(name => ({ name, kind: 'human', deck: { cards: [{ count: 60, card }] } })) } });
  assert.equal(response.statusCode, 200, response.body);
  const match = app.gameService.match(response.json().match.id);
  const command = async (playerId: PlayerId, command: GameCommand) => {
    const receipt = await match.command(playerId, { requestId: randomUUID(), revision: match.state.revision, command }); assert.equal(receipt.status, 'committed'); return receipt;
  };
  for (let count = 0; match.state.flow.choice && count < 6; count++) {
    const choice = match.state.flow.choice;
    if (choice.kind === 'choose_first') await command(choice.playerId, { kind: 'choose_first', firstPlayer: 'A' });
    else if (choice.kind === 'initial_placement') await command(choice.playerId, { kind: 'initial_placement', active: { zoneId: `${choice.playerId}:hand`, index: 0 }, bench: [] });
    else throw new Error(`未预期准备选择：${choice.kind}`);
  }
  await app.gameService.prepareHumanTurn(match);
  const controller = app.gameService.humanController(match, 'A');
  const settle = async (status: HumanActionView['status']) => {
    for (let count = 0; count < 1000; count++) { const action = controller.view('A'); if (action?.status === status) return action; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error(`未到达${status}：${JSON.stringify(controller.view('A'))}`);
  };
  return { app, match, controller, settle, command };
}

test('准备完成后自动首抽，普通回合并发排程只抽一次且不调用模型', async t => {
  const { app, match, controller, command } = await fixture(t);
  assert.equal(controller.view('A')!.status, 'completed'); assert.equal(controller.view('A')!.intent.kind, 'turn_start');
  assert.equal(match.state.zones['A:hand']!.contents.items.length, 7); assert.equal(match.state.zones['A:deck']!.contents.items.length, 46);
  await command('A', { kind: 'set_turn', phase: 'check', playerId: null }); await command('A', { kind: 'set_turn', phase: 'turn', playerId: 'B' });
  await Promise.all(Array.from({ length: 8 }, () => app.gameService.prepareHumanTurn(match)));
  const current = app.gameService.humanController(match, 'B').view('B')!;
  assert.equal(current.status, 'completed'); assert.equal(current.eventIds.length, 1); assert.equal(match.state.zones['B:hand']!.contents.items.length, 7);
});

test('恢复至首抽之前重新抽一次，恢复至首抽之后不重复；检查/交权/异议不自动越过', async t => {
  const { app, match, controller, command } = await fixture(t);
  const drawId = controller.view('A')!.eventIds[0]!;
  await match.debug({ kind: 'restore', targetEventId: drawId }); await app.gameService.prepareHumanTurn(match);
  const restored = controller.view('A')!;
  assert.notEqual(restored.eventIds[0], drawId); assert.equal(match.state.zones['A:hand']!.contents.items.length, 7);
  const after = await command('A', { kind: 'declare', text: '首抽之后恢复点' }); assert.equal(after.status, 'committed');
  await match.debug({ kind: 'restore', targetEventId: after.eventId }); await app.gameService.prepareHumanTurn(match);
  assert.equal(match.state.zones['A:hand']!.contents.items.length, 7); assert.equal(controller.view('A')!.id, restored.id);
  await command('A', { kind: 'set_turn', phase: 'check', playerId: null }); const revision = match.state.revision;
  await app.gameService.prepareHumanTurn(match); assert.equal(match.state.revision, revision); assert.equal(humanTurnStart(match, 'A'), null);
});

test('抽牌前取消自动开局后不能开始普通行动，显式继续才完成', async t => {
  let pending: ((value: ModelReply) => void) | undefined;
  const { match, controller, settle } = await fixture(t, { ...simple, rulesText: '自己的回合开始时，检查此宝可梦的效果。' }, () => new Promise(resolve => { pending = resolve; }));
  for (let count = 0; !pending && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(pending); const current = controller.view('A')!;
  const cancellation = controller.control(current.id, { playerId: 'A', action: 'cancel' });
  pending(tool('finish_action', {})); await cancellation;
  await assert.rejects(controller.start({ playerId: 'A', requestId: randomUUID(), revision: match.state.revision, intent: { kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 1 } } }), /回合开始处理/u);
  const before = match.state.revision; await controller.ensureTurnStart(); assert.equal(match.state.revision, before); assert.equal(controller.view('A')!.status, 'cancelled');
  const retry = controller.control(current.id, { playerId: 'A', action: 'retry' }); await retry;
  for (let count = 0; controller.view('A')!.status === 'running' && count < 100; count++) { await new Promise(resolve => setTimeout(resolve, 5)); pending?.(tool('execute_sequence', { steps: [step(draw())], finish: true })); }
  assert.equal((await settle('completed')).eventIds.length, 1);
});

test('加入手牌前窗口保留在私有暂存区，取消及重启后沿原选择继续，不重抽', async t => {
  const effect = '从牌库抽到这张卡时，在加入手牌前，你可以将其丢弃。';
  let calls = 0, choiceId = '';
  const { app, match, controller, settle } = await fixture(t, { ...simple, rulesText: effect }, () => {
    calls++;
    if (calls === 1) return tool('execute_atomic', step(draw('staging')));
    return tool('request_choice', { kind: 'select', title: '是否丢弃抽到的卡', options: [{ id: 'yes', label: '丢弃' }, { id: 'no', label: '不执行' }], minimum: 1, maximum: 1 });
  });
  const waiting = await settle('awaiting_choice'); choiceId = waiting.choice!.id;
  assert.equal(match.state.zones['A:hand']!.contents.items.length, 6); assert.equal(match.state.zones['A:staging']!.contents.items.length, 1);
  assert.equal(match.view('B').zones.find(zone => zone.id === 'A:staging')!.items[0]!.kind, 'hidden');
  await controller.control(waiting.id, { playerId: 'A', action: 'cancel' });
  await assert.rejects(controller.start({ playerId: 'A', requestId: randomUUID(), revision: match.state.revision, intent: { kind: 'end_turn' } }), /回合开始处理/u);
  await controller.close();
  let recoveryCalls = 0;
  const recovered = new HumanActionController({ match, playerId: 'A', prompts: () => app.gameService.prompts(), wake: () => {}, modelFactory: () => ({ generate: async () => {
    recoveryCalls++;
    if (recoveryCalls === 1) return tool('request_choice', { kind: 'select', title: '是否丢弃抽到的卡', options: [{ id: 'yes', label: '丢弃' }, { id: 'no', label: '不执行' }], minimum: 1, maximum: 1 });
    return tool('execute_sequence', { steps: [step({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:staging' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId])], finish: true });
  } }) });
  t.after(() => recovered.close()); await recovered.recover(); await recovered.control(waiting.id, { playerId: 'A', action: 'retry' });
  for (let count = 0; recovered.view('A')!.status === 'running' && count < 200; count++) await new Promise(resolve => setTimeout(resolve, 5));
  choiceId = recovered.view('A')!.choice!.id;
  await recovered.answer(waiting.id, { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, choiceId, selected: ['no'] });
  for (let count = 0; recovered.view('A')!.status === 'running' && count < 200; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(recovered.view('A')!.status, 'completed'); assert.equal(match.state.zones['A:staging']!.contents.items.length, 0); assert.equal(match.state.zones['A:hand']!.contents.items.length, 7);
  const stored = JSON.parse(await readFile(join(match.directory, 'human-actions', `${waiting.id}.json`), 'utf8')); assert.equal(stored.pending, null); assert.equal(recovered.view('A')!.eventIds.length, 2);
});

test('强制自身开局状态无需再选目标，不能借机发动未选择的主动特性', async t => {
  const mandatory = '自己的回合开始时，在这只宝可梦上放置开始标记。';
  const voluntary = '自己的回合时可以使用1次。从自己的牌库抽1张牌。';
  let calls = 0;
  const { match, settle } = await fixture(t, { ...simple, rulesText: mandatory, abilities: [{ name: '主动补给', text: voluntary }] }, request => {
    calls++;
    if (calls > 2) throw new Error(String(request.input.filter(item => item.type === 'function_call_output').at(-1)?.output));
    if (calls === 1) return tool('execute_atomic', step(draw(), [], voluntary));
    return tool('execute_sequence', { steps: [step({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'marker', name: '合成强制状态', value: true } }, [], mandatory), step(draw())], finish: true });
  });
  const done = await settle('completed'); assert.equal(calls, 2); assert.equal(done.eventIds.length, 2); assert.equal(match.state.zones['A:hand']!.contents.items.length, 7);
});

test('开局无牌才申报败北，成功抽到最后一张不会立刻败北', async t => {
  for (const remaining of [0, 1]) await t.test(`剩余${remaining}张`, async sub => {
    const { app, match, command } = await fixture(sub);
    await command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: remaining, count: 46 - remaining } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } });
    await app.gameService.prepareHumanTurn(match); assert.equal(match.state.flow.phase, 'turn', '回合内清空牌库不直接败北');
    await command('A', { kind: 'set_turn', phase: 'check', playerId: null }); await command('A', { kind: 'set_turn', phase: 'turn', playerId: 'B' }); await app.gameService.prepareHumanTurn(match);
    await command('B', { kind: 'set_turn', phase: 'check', playerId: null }); await command('B', { kind: 'set_turn', phase: 'turn', playerId: 'A' }); await app.gameService.prepareHumanTurn(match);
    assert.equal(app.gameService.humanController(match, 'A').view('A')!.status, 'completed'); assert.equal(match.state.zones['A:deck']!.contents.items.length, 0);
    if (remaining) { assert.equal(match.state.flow.phase, 'turn'); assert.equal(match.state.flow.proposedResult, null); }
    else { assert.equal(match.state.flow.phase, 'result_pending'); assert.equal(match.state.flow.proposedResult?.kind, 'win'); assert.equal(match.state.flow.proposedResult?.kind === 'win' && match.state.flow.proposedResult.winner, 'B'); }
  });
});

test('重启及全部GET不推进旧局，明确激活才自动首抽一次，非法席位不修改状态', async t => {
  const { app, match, controller } = await fixture(t);
  const drawId = controller.view('A')!.eventIds[0]!, dataDir = app.gameService.dataDir, systemDir = app.gameService.systemDir;
  await app.close();
  const offline = new MatchRuntime({ directory: match.directory }); await offline.recover(); await offline.debug({ kind: 'restore', targetEventId: drawId });
  assert.equal(offline.state.zones['A:hand']!.contents.items.length, 6);
  const path = join(match.directory, 'journal.jsonl'), untouched = await readFile(path, 'utf8'); let modelCalls = 0;
  const reopen = () => buildApp({ dataDir, systemDir, modelFactory: () => ({ generate: async () => { modelCalls++; throw new Error('普通恢复首抽不应请求模型'); } }) });
  const readonly = await reopen();
  assert.equal(await readFile(path, 'utf8'), untouched, 'service.init不能推进旧局');
  for (const url of ['/api/matches', `/api/matches/${match.state.id}?viewer=A`, `/api/matches/${match.state.id}/history?viewer=A`, `/api/matches/${match.state.id}/replay?viewer=A&index=0`, `/api/matches/${match.state.id}/export`, `/api/matches/${match.state.id}/actions/current?playerId=A`]) assert.equal((await readonly.inject(url)).statusCode, 200);
  assert.equal(await readFile(path, 'utf8'), untouched, '只读入口不能补抽');
  for (const payload of [{}, { playerId: 'C' }, { playerId: 'omniscient' }, { playerId: 'A', extra: true }]) assert.equal((await readonly.inject({ method: 'POST', url: `/api/matches/${match.state.id}/actions/activate`, payload })).statusCode, 400);
  const ai = await seedHumanScenario(readonly.gameService, 'activation-ai-seat', { aiSpectator: true });
  const aiPath = join(ai.directory, 'journal.jsonl'), aiBefore = await readFile(aiPath, 'utf8');
  assert.equal((await readonly.inject({ method: 'POST', url: `/api/matches/${ai.state.id}/actions/activate`, payload: { playerId: 'A' } })).statusCode, 403);
  assert.equal(await readFile(aiPath, 'utf8'), aiBefore); assert.equal(await readFile(path, 'utf8'), untouched, '非法激活不能推进任何席位');
  await readonly.close(); assert.equal(await readFile(path, 'utf8'), untouched, '关闭须收敛后台任务而不补抽');
  const live = await reopen(); t.after(() => live.close());
  assert.equal(await readFile(path, 'utf8'), untouched, '再次重启未打开仍不补抽');
  const opened = await live.inject({ method: 'POST', url: `/api/matches/${match.state.id}/actions/activate`, payload: { playerId: 'A' } }); assert.equal(opened.statusCode, 202); assert.equal(opened.json().intent.kind, 'turn_start'); assert.equal(opened.json().status, 'completed');
  const view = (await live.inject(`/api/matches/${match.state.id}?viewer=A`)).json(); assert.equal(view.zones.find((zone: { id: string }) => zone.id === 'A:hand').items.length, 7);
  const after = await readFile(path, 'utf8');
  await Promise.all(Array.from({ length: 5 }, () => live.inject({ method: 'POST', url: `/api/matches/${match.state.id}/actions/activate`, payload: { playerId: 'A' } })));
  assert.equal(await readFile(path, 'utf8'), after, '并发重复打开不能重复抽牌'); assert.equal(modelCalls, 0);
});

test('重启中断的人类动作在实时打开后仍等待显式继续，不被自动开局覆盖', async t => {
  const { app, match, controller } = await fixture(t, { ...simple, rulesText: '自己的回合开始时，检查此宝可梦的效果。' }, request => new Promise<ModelReply>((_resolve, reject) => {
    if (request.signal?.aborted) { reject(new Error('合成服务关闭')); return; }
    request.signal?.addEventListener('abort', () => reject(new Error('合成服务关闭')), { once: true });
  }));
  for (let count = 0; !controller.running && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  const actionId = controller.view('A')!.id, revision = match.state.revision;
  await app.close(); let calls = 0;
  const recovered = await buildApp({ dataDir: app.gameService.dataDir, systemDir: app.gameService.systemDir, modelFactory: () => ({ generate: async () => { calls++; return tool('execute_sequence', { steps: [step(draw())], finish: true }); } }) });
  t.after(() => recovered.close());
  const opened = (await recovered.inject(`/api/matches/${match.state.id}?viewer=A`)).json();
  assert.equal(opened.humanAction.id, actionId); assert.equal(opened.humanAction.status, 'failed'); assert.match(opened.humanAction.error, /服务已重启/u); assert.equal(opened.revision, revision); assert.equal(calls, 0);
  const activation = await recovered.inject({ method: 'POST', url: `/api/matches/${match.state.id}/actions/activate`, payload: { playerId: 'A' } }); assert.equal(activation.statusCode, 202); assert.equal(activation.json().id, actionId); assert.equal(activation.json().status, 'failed'); assert.equal(calls, 0);
  const current = recovered.gameService.humanController(recovered.gameService.match(match.state.id), 'A');
  await current.control(actionId, { playerId: 'A', action: 'retry' });
  for (let count = 0; current.view('A')!.status === 'running' && count < 200; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(current.view('A')!.status, 'completed'); assert.equal(current.view('A')!.id, actionId); assert.equal(calls, 1);
});

test('首抽历史仅接受明确顶部一张的range或indices，其他索引和多牌不能冒充', async t => {
  type Range = Extract<GameCommand, { kind: 'move' }>['source']['range'];
  const cases: [string, Range, boolean][] = [
    ['range 0/1', { mode: 'range', start: 0, count: 1 }, true],
    ['indices [0]', { mode: 'indices', indices: [0] }, true],
    ['indices [1]', { mode: 'indices', indices: [1] }, false],
    ['indices [0,1]', { mode: 'indices', indices: [0, 1] }, false],
  ];
  for (const [name, range, expected] of cases) await t.test(name, async sub => {
    const { app, match } = await fixture(sub); await app.close();
    const offline = new MatchRuntime({ directory: match.directory }); await offline.recover();
    const execute = async (command: GameCommand) => {
      const receipt = await offline.command(offline.state.flow.operator, { requestId: randomUUID(), revision: offline.state.revision, command }); assert.equal(receipt.status, 'committed');
    };
    await execute({ kind: 'set_turn', phase: 'check', playerId: null }); await execute({ kind: 'set_turn', phase: 'turn', playerId: 'B' });
    assert.equal(humanTurnStart(offline, 'B')!.drew, false);
    await execute({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'B:deck' }, range }, destination: { container: { kind: 'zone', zoneId: 'B:hand' }, index: 'end' } });
    assert.equal(humanTurnStart(offline, 'B')!.drew, expected);
  });
});
