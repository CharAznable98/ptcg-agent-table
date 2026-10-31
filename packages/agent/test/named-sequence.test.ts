import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, FileSessionStore, MemorySessionStore, loadPrompts } from '../src/index.ts';
import { MoveKnownInputSchema, ShowKnownInputSchema } from '../../protocol/src/index.ts';
import type { ModelReply, ModelRequest, ToolReceipt, ToolRequest } from '../src/types.ts';
const look = { name: 'look', description: '查看整区', effect: 'command' as const, inputSchema: Type.Any() };
const declared = { name: 'declare', description: '宣告', effect: 'command' as const, inputSchema: Type.Object({ text: Type.String() }) };
const show = { name: 'show_known', description: '已选牌展示', effect: 'command' as const, inputSchema: ShowKnownInputSchema };
const move = { name: 'move_known', description: '已选牌移动', effect: 'command' as const, inputSchema: MoveKnownInputSchema };
const raw = { name: 'move', description: '位置移动', effect: 'command' as const, inputSchema: Type.Any() };
const shuffle = { name: 'shuffle', description: '洗牌', effect: 'command' as const, inputSchema: Type.Any() };
const random = { name: 'random', description: '随机', effect: 'command' as const, inputSchema: Type.Any() };
const handoff = { name: 'handoff', description: '交权', effect: 'command' as const, inputSchema: Type.Any() };
const catalog = [look, declared, show, move, raw, shuffle, random, handoff];
const zone = (zoneId: string) => ({ kind: 'zone', zoneId });
const lookup = { tool: 'look', arguments: { selection: { container: zone('A:deck'), range: { mode: 'all' } } } };
const showSelected = { tool: 'show_known', arguments: { zoneId: 'A:deck', name: '合成目标' } };
const moveSelected = { tool: 'move_known', arguments: { zoneId: 'A:deck', name: '合成目标', destination: { container: zone('A:hand'), index: 0 } } };
function reply(actions: unknown[], id = 'sequence'): ModelReply { const args = JSON.stringify({ actions }); return { id, model: 'test', output: [{ type: 'function_call', call_id: id, name: 'execute_sequence', arguments: args }], calls: [{ callId: id, name: 'execute_sequence', arguments: args }], usage: null }; }
async function fixture(actions: unknown[], options: { restart?: boolean; missing?: boolean; finish?: boolean; observeAfter?: string } = {}) {
  const directory = options.restart ? await mkdtemp(join(tmpdir(), 'ptcg-named-')) : undefined;
  const store = directory ? new FileSessionStore(directory) : new MemorySessionStore(), controller = new AbortController(), calls: ToolRequest[] = [], requests: ModelRequest[] = [];
  let revision = 0, decisions = 0;
  const config = { store, trace: { async append() {} }, prompts: await loadPrompts(),
    model: { async generate(request: ModelRequest) { requests.push(structuredClone(request)); if (++decisions === 1) return reply(actions); throw Error('CHECK_NEXT_DECISION'); } },
    match: { async observe(matchId: string, playerId: string) { return { matchId, playerId, revision, cursor: String(revision), status: options.finish && calls.length === actions.length ? 'finished' as const : 'active' as const, snapshot: {}, observations: [], tools: catalog, toolCatalog: catalog }; }, async execute(request: ToolRequest): Promise<ToolReceipt> {
      calls.push(structuredClone(request)); revision++;
      if (request.tool === 'look') { if (options.restart) controller.abort(); return { status: 'committed', revision, data: { revealed: true }, continuation: 'continue', continuationGuard: { kind: 'named_selection', zoneIds: ['A:deck'] } } as ToolReceipt; }
      if (options.missing && request.tool === 'show_known') return { status: 'not_executed', revision, data: { reason: 'KNOWN_CARD_NOT_FOUND' }, continuation: 'observe' };
      return { status: 'committed', revision, data: {}, continuation: options.observeAfter === request.tool ? 'observe' : 'continue', ...(request.tool === 'shuffle' ? { continuationGuard: { kind: 'hidden_shuffle', zoneIds: ['A:deck'] } } : {}) };
    } },
  };
  const runtime = new AgentRuntime(config);
  await runtime.create({ matchId: 'named', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  const first = await runtime.activate('named', 'A', options.restart ? controller.signal : undefined);
  const saved = await store.load('named', 'A');
  const outcome = options.restart ? await new AgentRuntime({ ...config, store: new FileSessionStore(directory!) }).activate('named', 'A') : first;
  if (directory) await rm(directory, { recursive: true, force: true });
  return { outcome, first, saved, calls, requests, decisions };
}

test('整区查看后按预选牌名连续展示移动，只用一个决策且仅暴露包装schema', async () => {
  const result = await fixture([lookup, showSelected, moveSelected], { finish: true });
  assert.equal(result.outcome.status, 'finished', result.outcome.reason); assert.equal(result.decisions, 1);
  assert.deepEqual(result.calls.map(call => call.tool), ['look', 'show_known', 'move_known']);
  assert.deepEqual(result.requests[0]!.tools.map(tool => tool.name), ['execute_sequence'], 'DUPLICATE_ATOMIC_SCHEMAS');
});

test('查看后的直接下一步不是同区预选牌名时必须先返回模型', async () => {
  const result = await fixture([lookup, { tool: 'declare', arguments: { text: '不能在新增信息上继续作未限定决策' } }]);
  assert.deepEqual(result.calls.map(call => call.tool), ['look']);
  assert.equal(JSON.parse(result.requests[1]!.input.find(item => item.type === 'function_call_output')!.output as string).stoppedReason, 'OBSERVATION_REQUIRED');
});

test('同区预选目标不存在时不执行后缀，工具缺牌结果交回模型', async () => {
  const result = await fixture([lookup, showSelected, moveSelected], { missing: true });
  assert.deepEqual(result.calls.map(call => call.tool), ['look', 'show_known']);
  const feedback = JSON.parse(result.requests[1]!.input.find(item => item.type === 'function_call_output')!.output as string);
  assert.equal(feedback.results[1].receipt.status, 'not_executed'); assert.equal(feedback.skipped.length, 1);
});

test('named选择不消除同区原索引依赖，洗牌后也不能按牌名窥探', async () => {
  const byPosition = { tool: 'move', arguments: { source: { container: zone('A:deck'), range: { mode: 'indices', indices: [2] } }, destination: { container: zone('A:hand'), index: 0 } } };
  const indexed = await fixture([lookup, showSelected, byPosition]);
  assert.deepEqual(indexed.calls.map(call => call.tool), ['look', 'show_known']);
  const hidden = await fixture([lookup, showSelected, { tool: 'shuffle', arguments: { selection: { container: zone('A:deck'), range: { mode: 'all' } } } }, moveSelected]);
  assert.deepEqual(hidden.calls.map(call => call.tool), ['look', 'show_known', 'shuffle']);
  assert.equal(JSON.parse(hidden.requests[1]!.input.find(item => item.type === 'function_call_output')!.output as string).stoppedReason, 'SHUFFLE_DEPENDENCY');
});

test('查看后取消重启仍保留named选择保护和原定选择，不新增决策', async () => {
  const result = await fixture([lookup, showSelected, moveSelected], { restart: true, finish: true });
  assert.equal(result.first.reason, 'CANCELLED');
  assert.equal(result.saved!.sequence!.results[0]!.receipt.continuationGuard!.kind, 'named_selection');
  assert.equal(result.outcome.status, 'finished', result.outcome.reason); assert.equal(result.decisions, 1);
});

test('命名选择中不支持stepReference或动态条件，预检拒绝后没有查看副作用', async () => {
  const invalid = { tool: 'move_known', arguments: { zoneId: 'A:deck', name: '合成目标', stepReference: 0, destination: moveSelected.arguments.destination } };
  const result = await fixture([lookup, invalid]);
  assert.deepEqual(result.calls, []); assert.equal(result.outcome.reason, 'CHECK_NEXT_DECISION');
});

test('named反馈声明observe时仍停止后缀，不越过其它新信息边界', async () => {
  const result = await fixture([lookup, showSelected, moveSelected], { observeAfter: 'show_known' });
  assert.deepEqual(result.calls.map(call => call.tool), ['look', 'show_known']);
});

test('固定无关步骤可以继续，随机和交权的observe反馈始终停止', async () => {
  const unrelated = await fixture([lookup, showSelected, { tool: 'declare', arguments: { text: '执行已定步骤' } }, moveSelected], { finish: true });
  assert.equal(unrelated.outcome.status, 'finished', unrelated.outcome.reason);
  for (const tool of ['random', 'handoff']) {
    const barrier = await fixture([lookup, showSelected, { tool, arguments: tool === 'random' ? { mode: 'coins', count: 1 } : { to: 'B', reason: '选择' } }, moveSelected], { observeAfter: tool });
    assert.deepEqual(barrier.calls.map(call => call.tool), ['look', 'show_known', tool]);
    assert.equal(JSON.parse(barrier.requests[1]!.input.find(item => item.type === 'function_call_output')!.output as string).stoppedReason, 'OBSERVATION_REQUIRED');
  }
});

test('单步模式保持原子工具定义，不引入包装schema', async () => {
  const store = new MemorySessionStore();
  let effects = 0;
  const runtime = new AgentRuntime({ store, limits: { maxActionsPerDecision: 1 }, prompts: await loadPrompts(), trace: { async append() {} }, model: { async generate(request) {
    assert.deepEqual(request.tools.map(tool => tool.name), ['declare']);
    const args = JSON.stringify({ text: '一步' }); return { id: 'one', model: 'test', output: [{ type: 'function_call', call_id: 'one', name: 'declare', arguments: args }], calls: [{ callId: 'one', name: 'declare', arguments: args }], usage: null };
  } }, match: { async observe(matchId, playerId) { return { matchId, playerId, revision: effects, cursor: String(effects), status: effects ? 'finished' : 'active', snapshot: {}, observations: [], tools: [declared], toolCatalog: catalog }; }, async execute() { effects++; return { status: 'committed', revision: effects, data: {} }; } } });
  await runtime.create({ matchId: 'single', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  assert.equal((await runtime.activate('single', 'A')).status, 'finished'); assert.equal(effects, 1);
});
