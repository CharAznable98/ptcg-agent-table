import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime, FileSessionStore, MemorySessionStore, loadPrompts } from '../src/index.ts';
import type { ModelGateway, ModelReply, ModelRequest, MatchPort, PlayerSession, SessionStore, ToolReceipt, ToolRequest } from '../src/types.ts';
import { compressionBudget, contextBytes, recentHistory } from '../src/context.ts';

function call(name: string, value: unknown, id = 'decision'): ModelReply {
  const arguments_ = JSON.stringify(value);
  return { id, model: 'test', output: [{ type: 'function_call', call_id: id, name, arguments: arguments_ }], calls: [{ callId: id, name, arguments: arguments_ }], usage: null };
}
const tool = { name: 'advance', description: '执行一个确定操作', effect: 'command' as const, inputSchema: Type.Object({ step: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }) };
const sequence = (steps: number[], id = 'sequence') => call('execute_sequence', { actions: steps.map(step => ({ tool: 'advance', arguments: { step } })) }, id);

function fixture(total: number, options: { largeSnapshot?: boolean; eventBytes?: number } = {}) {
  let revision = 0;
  const calls: ToolRequest[] = [];
  const deck = { cards: [{ name: '合成资料', text: '合成牌文'.repeat(options.largeSnapshot ? 12_000 : 1) }] };
  const port: MatchPort = {
    async observe(matchId, playerId, after) {
      const observations = after === String(revision) ? [] : [{ id: `event-${revision}`, revision, data: { note: '增量'.repeat(options.eventBytes ?? 1) } }];
      return { matchId, playerId, revision, cursor: String(revision), status: revision === total ? 'finished' : 'active', snapshot: { viewer: playerId, step: revision, ownDeck: deck }, observations, tools: [tool] };
    },
    async execute(request) {
      assert.equal(request.revision, revision);
      assert.equal((request.arguments as { step: number }).step, revision);
      calls.push(structuredClone(request)); revision++;
      return { status: 'committed', revision, data: {}, continuation: 'continue' } as ToolReceipt;
    },
  };
  return { port, calls, deck };
}
async function setup(model: ModelGateway, port: MatchPort, deck: unknown = {}, store: SessionStore = new MemorySessionStore()) {
  const runtime = new AgentRuntime({ model, match: port, store, trace: { async append() {} }, prompts: await loadPrompts() });
  await runtime.create({ matchId: 'throughput', playerId: 'A', deck: deck as PlayerSession['deck'], strategy: { version: 1, content: '' }, rules: '' });
  return { runtime, store };
}

test('一次决策按顺序执行多个原子工具，每步使用实际新版本', async () => {
  const { port, calls } = fixture(3); let decisions = 0;
  const model: ModelGateway = { async generate(request) {
    const latest = JSON.parse(request.input.at(-1)!.content as string);
    assert.deepEqual(latest.execution.availableTools, ['advance', 'execute_sequence'], '批处理包装工具必须列入本次可用集');
    decisions++; return sequence([0, 1, 2]);
  } };
  const { runtime, store } = await setup(model, port);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
  assert.equal(decisions, 1); assert.deepEqual(calls.map(c => c.revision), [0, 1, 2]);
  assert.equal(new Set(calls.map(c => c.requestId)).size, 3);
  const session = (await store.load('throughput', 'A'))!;
  assert.equal(session.toolCalls, 3);
  assert.equal(session.messages.filter(m => m.type === 'function_call_output').length, 1);
});

test('新信息出现后停止后缀，向模型返回已执行结果与未执行项', async () => {
  const { port, calls } = fixture(3); const execute = port.execute.bind(port); let decisions = 0;
  port.execute = async request => ({ ...await execute(request), continuation: calls.length === 1 ? 'observe' : 'continue' });
  const model: ModelGateway = { async generate(request) {
    decisions++;
    if (decisions === 2) {
      const feedback = request.input.find(m => m.type === 'function_call_output')!;
      const value = JSON.parse(feedback.output as string);
      assert.equal(value.results.length, 1); assert.equal(value.skipped.length, 2);
      assert.equal(value.stoppedReason, 'OBSERVATION_REQUIRED');
    }
    return sequence(decisions === 1 ? [0, 1, 2] : [1, 2], `decision-${decisions}`);
  } };
  const { runtime } = await setup(model, port);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
  assert.equal(decisions, 2); assert.deepEqual(calls.map(c => (c.arguments as { step: number }).step), [0, 1, 2]);
});

test('序列中一个参数无效时整体预检拒绝，不能绕过身份参数限制', async () => {
  const { port, calls } = fixture(2); let decisions = 0;
  const model: ModelGateway = { async generate() {
    decisions++;
    if (decisions === 1) return call('execute_sequence', { actions: [{ tool: 'advance', arguments: { step: 0 } }, { tool: 'advance', arguments: { step: 1, playerId: 'B' } }] });
    assert.equal(calls.length, 0);
    return sequence([0, 1], 'corrected');
  } };
  const { runtime } = await setup(model, port);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
  assert.equal(decisions, 2); assert.ok(calls.every(c => c.playerId === 'A'));
});

test('序列业务拒绝保留成功前缀，末步拒绝也不能报告全部完成', async () => {
  for (const steps of [[0, 1, 2], [0, 1]]) {
    const { port, calls } = fixture(2), execute = port.execute.bind(port); let decisions = 0;
    port.execute = request => decisions === 1 && calls.length === 1 ? Promise.resolve({ status: 'rejected', revision: 1, data: { error: 'fixture rejection' } }) : execute(request);
    const model: ModelGateway = { async generate(request) {
      if (++decisions === 1) return sequence(steps);
      const feedback = JSON.parse(request.input.find(m => m.type === 'function_call_output')!.output as string);
      assert.equal(feedback.status, 'rejected'); assert.equal(feedback.stoppedReason, 'TOOL_REJECTED');
      assert.equal(feedback.results.length, 2); assert.equal(feedback.skipped.length, steps.length - 2);
      assert.equal(calls.length, 1);
      return call('advance', { step: 1 }, 'retry');
    } };
    const { runtime } = await setup(model, port);
    assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
    assert.equal(calls.length, 2);
  }
});

test('序列中间外部版本改变不能静默重绑定余下操作', async () => {
  const { port, calls } = fixture(2), observe = port.observe.bind(port); let decisions = 0;
  port.observe = async (...args) => { const frame = await observe(...args); return calls.length === 1 && decisions === 1 ? { ...frame, revision: 99 } : frame; };
  const model: ModelGateway = { async generate(request) {
    if (++decisions === 1) return sequence([0, 1]);
    const feedback = JSON.parse(request.input.find(m => m.type === 'function_call_output')!.output as string);
    assert.equal(feedback.stoppedReason, 'REVISION_CHANGED'); assert.equal(calls.length, 1);
    throw new Error('CHECKED_STALE_PREFIX');
  } };
  const { runtime } = await setup(model, port);
  assert.equal((await runtime.activate('throughput', 'A')).reason, 'CHECKED_STALE_PREFIX');
});

test('超过十六步或嵌套序列在副作用前拒绝', async () => {
  const { port, calls } = fixture(1); let decisions = 0;
  const model: ModelGateway = { async generate() {
    assert.equal(calls.length, 0);
    if (++decisions === 1) return sequence(Array.from({ length: 17 }, (_, n) => n));
    if (decisions === 2) return call('execute_sequence', { actions: [{ tool: 'execute_sequence', arguments: { actions: [] } }] }, 'nested');
    return sequence([0], 'valid');
  } };
  const { runtime } = await setup(model, port);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished'); assert.equal(decisions, 3);
});

test('序列提交后断连，磁盘重载复用原请求且继续未执行部分', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-sequence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { port, calls } = fixture(3); const execute = port.execute.bind(port);
  let original: ToolRequest | null = null, receipt: ToolReceipt | null = null, decisions = 0;
  port.execute = async request => {
    if (!original) { original = structuredClone(request); receipt = await execute(request); throw new Error('uncertain commit'); }
    if (request.requestId === original.requestId) { assert.deepEqual(request, original); return receipt!; }
    return execute(request);
  };
  const model: ModelGateway = { async generate(request) {
    const latest = JSON.parse(request.input.at(-1)!.content as string);
    assert.deepEqual(latest.execution.availableTools, ['advance', 'execute_sequence'], '批处理包装工具必须列入本次可用集');
    decisions++; return sequence([0, 1, 2]);
  } };
  const { runtime, store } = await setup(model, port, {}, new FileSessionStore(directory));
  assert.equal((await runtime.activate('throughput', 'A')).status, 'aborted');
  assert.ok((await store.load('throughput', 'A'))?.pending);
  const resumed = new AgentRuntime({ model, match: port, store: new FileSessionStore(directory), trace: { async append() {} }, prompts: await loadPrompts() });
  assert.equal((await resumed.activate('throughput', 'A')).status, 'finished');
  assert.equal(decisions, 1); assert.equal(calls.length, 3);
});

test('取消发生在序列中间时，停止新副作用并保留后续步骤供显式恢复', async () => {
  const { port, calls } = fixture(3); const execute = port.execute.bind(port), controller = new AbortController();
  port.execute = async request => { const receipt = await execute(request); if (calls.length === 1) controller.abort(); return receipt; };
  let decisions = 0; const model: ModelGateway = { async generate(request) {
    const latest = JSON.parse(request.input.at(-1)!.content as string);
    assert.deepEqual(latest.execution.availableTools, ['advance', 'execute_sequence'], '批处理包装工具必须列入本次可用集');
    decisions++; return sequence([0, 1, 2]);
  } };
  const { runtime, store } = await setup(model, port);
  assert.equal((await runtime.activate('throughput', 'A', controller.signal)).reason, 'CANCELLED');
  assert.equal(calls.length, 1); assert.equal((await store.load('throughput', 'A'))?.sequence?.next, 1);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
  assert.equal(calls.length, 3); assert.equal(decisions, 1);
});

test('单步恢复已保存的长序列也只执行一个操作，后续继续无需新增决策', async () => {
  const { port, calls } = fixture(4), execute = port.execute.bind(port), controller = new AbortController(); let decisions = 0;
  port.execute = async request => { const receipt = await execute(request); if (calls.length === 1) controller.abort(); return receipt; };
  const model: ModelGateway = { async generate() { decisions++; return sequence([0, 1, 2, 3]); } };
  const { runtime, store } = await setup(model, port);
  assert.equal((await runtime.activate('throughput', 'A', controller.signal)).reason, 'CANCELLED');
  const stepper = new AgentRuntime({ model, match: port, store, trace: { async append() {} }, prompts: await loadPrompts(), limits: { maxActionsPerDecision: 1, maxToolCallsPerActivation: 1, maxDecisionsPerActivation: 1 } });
  assert.equal((await stepper.activate('throughput', 'A')).reason, 'ACTION_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 2); assert.equal((await store.load('throughput', 'A'))?.sequence?.next, 2);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished'); assert.equal(calls.length, 4); assert.equal(decisions, 1);
});

test('旧快照迁移先摘要过去见过的事实，不能因替换快照丢失知识', async () => {
  const { port } = fixture(1); let compacted = false;
  const model: ModelGateway = { async generate(request) {
    if (request.role === 'compactor') {
      assert.match(JSON.stringify(request.input), /过去合法看到的秘密/); compacted = true;
      return call('submit_result', { text: '过去合法看到的秘密仍记得，旧位置不可直接复用。', evidenceRefs: [] });
    }
    assert.ok(compacted); assert.match(JSON.stringify(request.input), /过去合法看到的秘密/);
    return call('advance', { step: 0 });
  } };
  const { runtime, store } = await setup(model, port);
  const old = (await store.load('throughput', 'A'))!; delete old.context;
  old.messages = [{ role: 'user', content: JSON.stringify({ revision: 0, snapshot: { revealed: '过去合法看到的秘密' }, observations: [], memory: null }) }];
  await store.save(old);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
  const migrated = (await store.load('throughput', 'A'))!;
  assert.equal(migrated.context?.legacySnapshots, undefined); assert.equal(migrated.compactions, 1);
});

test('大体量卡组与当前快照只进入每个请求一次，20步不触发逐步压缩', async () => {
  const { port, deck } = fixture(20, { largeSnapshot: true }); const requests: ModelRequest[] = [];
  const model: ModelGateway = { async generate(request) {
    requests.push(structuredClone(request));
    if (request.role === 'compactor') return call('submit_result', { text: '已完成的操作保留在原件中。', evidenceRefs: [] });
    return call('advance', { step: requests.filter(r => r.role === 'player').length - 1 }, `step-${requests.length}`);
  } };
  const { runtime } = await setup(model, port, deck);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
  assert.equal(requests.filter(r => r.role === 'compactor').length, 0);
  for (const request of requests) {
    const users = request.input.filter(m => m.role === 'user').map(m => JSON.parse(m.content as string));
    assert.equal(users.filter(m => m.snapshot).length, 1);
    assert.equal(users.filter(m => m.deck).length, 1);
    assert.equal(users.find(m => m.snapshot).snapshot.ownDeck, undefined);
  }
});

test('连续压缩只提交水位后的增量，原始观察与工具历史全部留存', async () => {
  const { port, deck } = fixture(12, { eventBytes: 6000 }); const requests: ModelRequest[] = [];
  let step = 0;
  const model: ModelGateway = { async generate(request) {
    requests.push(structuredClone(request));
    return request.role === 'compactor' ? call('submit_result', { text: '保留已知事实，旧位置按历史版本解释。', evidenceRefs: [] }) : call('advance', { step: step++ }, `step-${step}`);
  } };
  const { runtime, store } = await setup(model, port, deck);
  assert.equal((await runtime.activate('throughput', 'A')).status, 'finished');
  const compactions = requests.filter(r => r.role === 'compactor');
  assert.ok(compactions.length >= 2);
  const seen = new Set<string>();
  for (const request of compactions) {
    const value = JSON.parse(request.input[0]!.content as string);
    for (const event of value.observations) { assert.ok(!seen.has(event.id), `重复压缩 ${event.id}`); seen.add(event.id); }
  }
  const session = (await store.load('throughput', 'A'))!;
  assert.equal(session.observations.length, 13); assert.equal(session.toolHistory.length, 12);
  await runtime.compact('throughput', 'A');
  const count = requests.length;
  await runtime.compact('throughput', 'A');
  assert.equal(requests.length, count, '无新增事实不得重复请求压缩');
});

test('摘要预算覆盖中文、JSON转义和证据引用，历史截断保留完整调用反馈段', () => {
  const ids = ['证据-1', '证据-2'];
  const budget = compressionBudget(512, ids);
  for (const text of ['汉'.repeat(budget.maxTextCharacters), '\u0000'.repeat(budget.maxTextCharacters)]) {
    assert.ok(contextBytes({ text, evidenceRefs: ids.slice(0, budget.maxEvidenceRefs) }) <= 512);
  }
  const old = [{ role: 'user', content: '很长旧观察'.repeat(200) }, ...call('advance', { step: 0 }, 'old').output, { type: 'function_call_output', call_id: 'old', output: '{}' }];
  const latest = [{ role: 'user', content: '新观察' }, ...call('advance', { step: 1 }, 'new').output, { type: 'function_call_output', call_id: 'new', output: '{}' }];
  assert.deepEqual(recentHistory([...old, ...latest], contextBytes(latest)), latest);
});

test('默认一次可提交十二步已确定操作，不为八步边界增加模型决策', async () => {
  const { port, calls } = fixture(12); let decisions = 0;
  const model: ModelGateway = { async generate() { decisions++; return sequence(Array.from({length:12},(_,n)=>n)); } };
  const { runtime } = await setup(model,port);
  assert.equal((await runtime.activate('throughput','A')).status,'finished');
  assert.equal(decisions,1);assert.equal(calls.length,12);
});
