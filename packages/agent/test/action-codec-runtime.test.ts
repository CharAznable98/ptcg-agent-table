import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, MemorySessionStore, loadPrompts } from '../src/index.ts';
import { MoveDestinationSchema, SelectionSchema } from '../../protocol/src/index.ts';
import type { Json, ModelReply, ModelRequest, ToolDefinition, ToolRequest } from '../src/types.ts';
const move: ToolDefinition = { name: 'move', description: '移动', effect: 'command', inputSchema: Type.Object({ source: SelectionSchema, destination: MoveDestinationSchema }, { additionalProperties: false }), argumentEncoding: 'ptcg-positions-v1' };
const canonical = { source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'range', start: 2, count: 1 } }, destination: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation: 'attached' }, index: 1 } };
function call(actions: unknown[]): ModelReply { const args = JSON.stringify({ actions }); return { id: 'encoded', model: 'test', output: [{ type: 'function_call', call_id: 'encoded', name: 'execute_sequence', arguments: args }], calls: [{ callId: 'encoded', name: 'execute_sequence', arguments: args }], usage: null }; }
async function fixture(actions: unknown[], options: { available?: boolean; restore?: boolean; legacy?: boolean } = {}) {
  const store = new MemorySessionStore(), calls: ToolRequest[] = [], requests: ModelRequest[] = [];
  const definition: ToolDefinition = { ...move }; if (options.legacy) delete definition.argumentEncoding;
  let revision = 0, decisions = 0;
  const prompts = await loadPrompts(); prompts.feedback.positionEncoding = '仅在execution.argumentFormat=ptcg-positions-v1时使用短坐标。';
  const runtime = new AgentRuntime({ store, prompts, trace: { async append() {} }, model: { async generate(request) { requests.push(structuredClone(request)); if (++decisions === 1) return call(actions); throw Error('CHECK_AFTER_PREFLIGHT'); } }, match: {
    async observe(matchId, playerId) { return { matchId, playerId, revision, cursor: String(revision), status: calls.length ? 'finished' : 'active', snapshot: {}, observations: [], tools: options.available === false ? [{ name: 'declare', description: '宣告', effect: 'command', inputSchema: Type.Object({ text: Type.String() }) }] : [definition], toolCatalog: [definition] }; },
    async execute(request) { calls.push(structuredClone(request)); revision++; return { status: 'committed', revision, data: {} }; },
  } });
  const session = await runtime.create({ matchId: 'codec-runtime', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  if (options.restore) { session.sequence = { callId: 'old-canonical', actions: [{ tool: 'move', arguments: canonical as Json }], next: 0, expectedRevision: 0, results: [] }; await store.save(session); }
  return { outcome: await runtime.activate('codec-runtime', 'A'), calls, requests, saved: (await store.load('codec-runtime', 'A'))! };
}

test('模型短坐标在整个wrapper验证后解码为规范命令，持久化及宿主不见短格式', async () => {
  const result = await fixture([{ tool: 'move', arguments: { source: 'A:hand/2', destination: 'A:active/0/attached/1' } }]);
  assert.equal(result.outcome.status, 'finished', result.outcome.reason); assert.deepEqual(result.calls[0]!.arguments, canonical);
  assert.deepEqual((result.saved.toolHistory[0]!.request as ToolRequest).arguments, canonical);
  const execution = JSON.parse(result.requests[0]!.input.at(-1)!.content as string).execution;
  assert.equal(execution.argumentFormat, 'ptcg-positions-v1');
  assert.match(result.saved.instructions, /仅在execution.argumentFormat/);
});

test('后续短参数非法时在任何副作用前反馈，不能先执行合法前缀', async () => {
  for (const source of ['A:hand/-1', 'A:hand/9007199254740992']) {
    const result = await fixture([{ tool: 'move', arguments: { source: 'A:hand/2', destination: 'A:active/0/attached/1' } }, { tool: 'move', arguments: { source, destination: 'A:hand/0' } }]);
    assert.deepEqual(result.calls, []); assert.equal(result.outcome.reason, 'CHECK_AFTER_PREFLIGHT');
    assert.ok(result.requests[1]!.input.some(item => item.type === 'function_call_output'));
  }
});

test('旧局未标记的工具继续使用规范参数，没有短格式标志', async () => {
  const legacy = await fixture([{ tool: 'move', arguments: canonical }], { legacy: true });
  assert.equal(legacy.outcome.status, 'finished', legacy.outcome.reason); assert.deepEqual(legacy.calls[0]!.arguments, canonical);
  assert.equal(JSON.parse(legacy.requests[0]!.input.at(-1)!.content as string).execution.argumentFormat, undefined);
});

test('带编码能力的工具在单步模式仍暴露和执行规范参数', async () => {
  const store = new MemorySessionStore(); let effects = 0;
  const runtime = new AgentRuntime({ store, limits: { maxActionsPerDecision: 1 }, prompts: await loadPrompts(), trace: { async append() {} }, model: { async generate(request) {
    assert.equal(JSON.parse(request.input.at(-1)!.content as string).execution.argumentFormat, undefined);
    assert.deepEqual(request.tools[0]!.inputSchema, move.inputSchema);
    const args = JSON.stringify(canonical); return { id: 'single', model: 'test', output: [{ type: 'function_call', call_id: 'single', name: 'move', arguments: args }], calls: [{ callId: 'single', name: 'move', arguments: args }], usage: null };
  } }, match: { async observe(matchId, playerId) { return { matchId, playerId, revision: effects, cursor: String(effects), status: effects ? 'finished' : 'active', snapshot: {}, observations: [], tools: [move], toolCatalog: [move] }; }, async execute(request) { assert.deepEqual(request.arguments, canonical); effects++; return { status: 'committed', revision: effects, data: {} }; } } });
  await runtime.create({ matchId: 'single-codec', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  assert.equal((await runtime.activate('single-codec', 'A')).status, 'finished'); assert.equal(effects, 1);
});

test('追加末尾由宿主处理，模型end参数解码后保留且非法来源后缀零副作用', async () => {
  const appended = await fixture([{ tool: 'move', arguments: { source: 'A:hand/2', destination: 'A:deck/end' } }]);
  assert.equal(appended.outcome.status, 'finished', appended.outcome.reason);
  assert.deepEqual(appended.calls[0]!.arguments, { source: canonical.source, destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 'end' } });
  const invalid = await fixture([{ tool: 'move', arguments: { source: 'A:hand/2', destination: 'A:deck/end' } }, { tool: 'move', arguments: { source: 'A:deck/end', destination: 'A:hand/0' } }]);
  assert.deepEqual(invalid.calls, []); assert.equal(invalid.outcome.reason, 'CHECK_AFTER_PREFLIGHT');
});

test('编码不会绕过实际frame权限，已保存规范序列恢复也不会再次解码', async () => {
  const denied = await fixture([{ tool: 'move', arguments: { source: 'A:hand/2', destination: 'A:active/0/attached/1' } }], { available: false });
  assert.deepEqual(denied.calls, []);
  assert.match(JSON.stringify(denied.requests[1]!.input), /TOOL_UNAVAILABLE/);
  const resumed = await fixture([], { restore: true });
  assert.equal(resumed.outcome.status, 'finished', resumed.outcome.reason); assert.equal(resumed.requests.length, 0); assert.deepEqual(resumed.calls[0]!.arguments, canonical);
});
