import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, MemorySessionStore, loadPrompts } from '../src/index.ts';
import { compactionContextBytes, linkToolObservations, restoreToolObservations } from '../src/context.ts';
import { independentAfterHiddenShuffle } from '../src/sequence.ts';
import type { ModelReply, ModelRequest } from '../src/types.ts';

function call(name: string, value: unknown, id: string): ModelReply {
  const args = JSON.stringify(value);
  return { id, model: 'test', output: [{ type: 'function_call', call_id: id, name, arguments: args }], calls: [{ callId: id, name, arguments: args }], usage: null };
}
const advance = { name: 'advance', description: '推进', effect: 'command' as const, inputSchema: Type.Object({}) };

test('自动压缩只覆盖成功推理消费的源水位，未消费事件和工具反馈不先入摘要', async () => {
  const store = new MemorySessionStore(); let step = 0, players = 0, compactions = 0;
  const requests: ModelRequest[] = [];
  const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), limits: { compactAfterBytes: 3000, recentHistoryBytes: 2000 }, trace: { async append() {} },
    model: { async generate(request) {
      requests.push(structuredClone(request));
      if (request.role === 'compactor') {
        compactions++;
        const input = JSON.parse(request.input[0]!.content as string);
        assert.deepEqual(input.observations.map((event: { id: string }) => event.id), ['e1'], 'UNCONSUMED_OBSERVATION_SUMMARIZED');
        assert.deepEqual(input.toolHistory, [], 'UNCONSUMED_TOOL_SUMMARIZED');
        assert.doesNotMatch(JSON.stringify(input), /JUST_ATTACHED/);
        return call('submit_result', { text: '此前没有附能。', evidenceRefs: ['e1'] }, 'compact');
      }
      if (++players === 2) {
        const rows = request.input.filter(item => item.role === 'user').map(item => JSON.parse(item.content as string));
        assert.ok(rows.some(row => row.memory));
        assert.equal(rows.flatMap(row => row.observations ?? []).filter(event => event.id === 'before').length, 0, 'SUMMARY_PREFIX_REPLAYED');
        assert.equal(rows.flatMap(row => row.observations ?? []).filter(event => event.id === 'attached').length, 1);
        assert.equal(request.input.filter(item => item.type === 'function_call_output' && item.call_id === 'decision-1').length, 1);
      }
      return call('advance', {}, `decision-${players}`);
    } },
    match: { async observe(matchId, playerId, after) {
      const event = step ? { id: 'attached', revision: 1, data: { fact: 'JUST_ATTACHED' } } : { id: 'before', revision: 0, data: { fact: 'NO_ATTACHMENT', padding: '已知资料'.repeat(300) } };
      return { matchId, playerId, revision: step, cursor: String(step), status: step === 2 ? 'finished' : 'active', snapshot: { step }, observations: after === String(step) ? [] : [event], tools: [advance] };
    }, async execute() { step++; return { status: 'committed', revision: step, data: { result: 'JUST_ATTACHED' } }; } },
  });
  await runtime.create({ matchId: 'watermark', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  assert.equal((await runtime.activate('watermark', 'A')).status, 'finished');
  assert.equal(compactions, 1); assert.equal(players, 2);
  const after = (await store.load('watermark', 'A'))!;
  assert.equal(after.context!.observationOffset, 1); assert.equal(after.context!.toolOffset, 0);
  assert.equal(after.messages.filter(item => item.type === 'function_call_output').length, 2, '原件保留');
});

test('洗牌后整区搬运、向牌库追加与整区查看不依赖旧顺序，按旧位置选牌仍停止', () => {
  const zone = (zoneId: string) => ({ kind: 'zone', zoneId });
  assert.equal(independentAfterHiddenShuffle({ tool: 'move', arguments: { source: { container: zone('A:hand'), range: { mode: 'all' } }, destination: { container: zone('A:deck'), index: 0 } } }, ['A:hand'], 'A'), true);
  assert.equal(independentAfterHiddenShuffle({ tool: 'move', arguments: { source: { container: zone('A:hand'), range: { mode: 'range', start: 0, count: 1 } }, destination: { container: zone('A:deck'), index: 0 } } }, ['A:deck'], 'A'), true);
  assert.equal(independentAfterHiddenShuffle({ tool: 'look', arguments: { selection: { container: zone('A:deck'), range: { mode: 'all' } } } }, ['A:deck'], 'A'), true);
  assert.equal(independentAfterHiddenShuffle({ tool: 'set_state', arguments: { target: zone('A:hand'), field: { key: 'visibility', value: null } } }, ['A:hand'], 'A'), true);
  assert.equal(independentAfterHiddenShuffle({ tool: 'move', arguments: { source: { container: zone('A:deck'), range: { mode: 'indices', indices: [3] } }, destination: { container: zone('A:hand'), index: 0 } } }, ['A:deck'], 'A'), false);
  assert.equal(independentAfterHiddenShuffle({ tool: 'move', arguments: { source: { container: { kind: 'group', position: { zoneId: 'A:deck', index: 2 }, relation: 'attached' }, range: { mode: 'all' } }, destination: { container: zone('A:hand'), index: 0 } } }, ['A:deck'], 'A'), false);
  assert.equal(independentAfterHiddenShuffle({ tool: 'move', arguments: { source: { container: zone('A:hand'), range: { mode: 'all' } }, destination: { container: { kind: 'group', position: { zoneId: 'A:deck', index: 2 }, relation: 'attached' }, index: 0 } } }, ['A:deck'], 'A'), false);
});

test('同事件参数和结果以可逆引用提供一次，额外开牌、拒绝和历史读取不丢失', () => {
  const arguments_ = { text: '本次使用只应计算一次'.repeat(100) }, result = { note: '实际结果'.repeat(100) };
  const observations = [{ id: 'event', revision: 1, data: { id: 'event', revision: 1, data: { command: { kind: 'declare', ...arguments_ }, result } } }];
  const tools = [{ request: { tool: 'declare', arguments: arguments_ }, receipt: { status: 'committed', revision: 1, data: { status: 'committed', eventId: 'event', revision: 1, result } } },
    { request: { tool: 'look', arguments: {} }, receipt: { status: 'committed', revision: 1, data: { status: 'committed', eventId: 'event', result: { result, reveals: [{ newCard: true }] } } } },
    { request: { tool: 'declare', arguments: arguments_ }, receipt: { status: 'rejected', revision: 1, data: { result } } },
    { request: { tool: 'read_history', arguments: {} }, receipt: { status: 'read', revision: 1, data: { result } } }];
  const raw = structuredClone(tools), aliases = new Map([['event', 'e1']]);
  const linked = linkToolObservations(tools, observations, aliases);
  assert.deepEqual(linked[0]!.request, { tool: 'declare', arguments: { observationRef: 'e1', field: 'commandArguments' } });
  assert.deepEqual(linked[0]!.receipt, { status: 'committed', revision: 1, data: { status: 'committed', eventId: 'event', revision: 1, result: { observationRef: 'e1', field: 'result' } } });
  assert.deepEqual(linked.slice(1), raw.slice(1));
  assert.deepEqual(restoreToolObservations(linked, observations, aliases), raw);
  assert.deepEqual(tools, raw);
  assert.ok(Buffer.byteLength(JSON.stringify(linked)) < Buffer.byteLength(JSON.stringify(raw)));
});

test('未消费大消息不触发提前压缩，成功消费后的可压缩前缀才触发', async () => {
  const store = new MemorySessionStore(); let step = 0, players = 0, compactions = 0;
  const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), limits: { compactAfterBytes: 3000 }, trace: { async append() {} },
    model: { async generate(request) {
      if (request.role === 'compactor') {
        assert.equal(players, 2, 'FRESH_INPUT_TRIGGERED_PREMATURE_COMPACTION'); compactions++;
        const input = JSON.parse(request.input[0]!.content as string);
        assert.match(JSON.stringify(input), /BIG_NEW_INFORMATION/);
        return call('submit_result', { text: '已知大资料已保留。', evidenceRefs: [] }, 'compact');
      }
      players++;
      if (players === 2) assert.match(JSON.stringify(request.input), /BIG_NEW_INFORMATION/, '新增事实先完整交付');
      return call('advance', {}, `decision-${players}`);
    } },
    match: { async observe(matchId, playerId, after) {
      const event = { id: `event-${step}`, revision: step, data: { fact: step === 1 ? 'BIG_NEW_INFORMATION:' + '资料'.repeat(1000) : '小资料' } };
      return { matchId, playerId, revision: step, cursor: String(step), status: step === 3 ? 'finished' : 'active', snapshot: { step }, observations: after === String(step) ? [] : [event], tools: [advance] };
    }, async execute() { step++; return { status: 'committed', revision: step, data: {} }; } },
  });
  await runtime.create({ matchId: 'delayed-trigger', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  const outcome = await runtime.activate('delayed-trigger', 'A');
  assert.equal(outcome.status, 'finished', outcome.reason); assert.equal(players, 3); assert.equal(compactions, 1);
});

test('每段必须重发的当前快照基准不作为可压缩历史触发反复摘要', async () => {
  const store = new MemorySessionStore(); let step = 0, players = 0;
  const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), limits: { compactAfterBytes: 3000 }, trace: { async append() {} },
    model: { async generate(request) {
      assert.equal(request.role, 'player', 'UNCHANGED_SNAPSHOT_TRIGGERED_USELESS_COMPACTION');
      assert.match(JSON.stringify(request.input), /同一公开基准/); players++;
      return call('advance', {}, `decision-${players}`);
    } },
    match: { async observe(matchId, playerId, after) {
      return { matchId, playerId, revision: step, cursor: String(step), status: step === 3 ? 'finished' : 'active', snapshot: { unchangedPublic: '同一公开基准'.repeat(1000) }, observations: after === String(step) ? [] : [{ id: `event-${step}`, revision: step, data: {} }], tools: [advance] };
    }, async execute() { step++; return { status: 'committed', revision: step, data: {} }; } },
  });
  await runtime.create({ matchId: 'anchor', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  const outcome = await runtime.activate('anchor', 'A');
  assert.equal(outcome.status, 'finished', outcome.reason); assert.equal(players, 3);
  const after = (await store.load('anchor', 'A'))!, measured = compactionContextBytes(after);
  assert.equal(after.compactions, 0); assert.ok(measured.anchorBytes > 3000); assert.ok(measured.compressibleBytes < 3000);
});

test('原生开牌反馈与同请求观察完全一致时只提供一个完整开牌来源', async () => {
  const store = new MemorySessionStore();
  const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), trace: { async append() {} }, model: { async generate() { throw Error('UNUSED'); } }, match: { async observe() { throw Error('UNUSED'); }, async execute() { throw Error('UNUSED'); } } });
  const s = await runtime.create({ matchId: 'native-link', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  const result = { count: 30 }, reveals = [{ cards: [{ position: { zoneId: 'A:deck', index: 0 }, card: { customText: '完整查看信息'.repeat(1000) } }] }];
  const receipt = { status: 'committed', revision: 1, data: { status: 'committed', eventId: 'look-event', revision: 1, result: { result, reveals } }, continuation: 'observe' };
  s.observations = [{ id: 'look-event', revision: 1, data: { id: 'look-event', revision: 1, sequence: 1, at: 'now', actor: 'A', commandKind: 'look', label: 'look', data: { command: { kind: 'look', selection: { mode: 'all' } }, result, reveals } } }];
  s.messages = [{ type: 'function_call', call_id: 'look', name: 'look', arguments: '{}' }, { type: 'function_call_output', call_id: 'look', output: JSON.stringify(receipt) }, { role: 'user', content: JSON.stringify({ revision: 1, observations: s.observations }) }];
  const original = structuredClone(s.messages);
  const { playerInput } = await import('../src/context.ts');
  const frame = { matchId: s.matchId, playerId: 'A', revision: 1, cursor: '1', status: 'active' as const, snapshot: {}, observations: [], tools: [advance] };
  const input = playerInput(s, frame, 16);
  const native = JSON.parse(input.find(item => item.type === 'function_call_output')!.output as string);
  assert.deepEqual(native.data.result, { observationRef: 'look-event', field: 'resultWithReveals' }, 'NATIVE_LOOK_INFORMATION_DUPLICATED');
  assert.deepEqual(restoreToolObservations([{ request: {}, receipt: native }], s.observations)[0]!.receipt, receipt, '完整开牌反馈可逆');
  assert.deepEqual(s.messages, original);
  s.messages = s.messages.slice(0, 2); delete s.context!.wire;
  const noSource = playerInput(s, frame, 16);
  assert.deepEqual(JSON.parse(noSource.find(item => item.type === 'function_call_output')!.output as string), receipt, '不允许引用不在本请求中的旧观察');
});
