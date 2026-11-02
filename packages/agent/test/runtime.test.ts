import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, MemorySessionStore, FileSessionStore, StrategyRepository, loadPrompts, LocalCodexCredentials, SecretRedactor, JsonlTrace, consumeResponses, toChatMessages, createModel } from '../src/index.ts';
import type { MatchPort, ModelGateway, ModelReply, ModelRequest, PlayerFrame, ToolRequest, TraceSink } from '../src/types.ts';
import { playerInput } from '../src/context.ts';

class Trace implements TraceSink {
  events: Record<string, unknown>[] = [];
  async append(event: Record<string, unknown>): Promise<void> { this.events.push(structuredClone(event)); }
}
function call(name: string, args: unknown, id = 'c1'): ModelReply {
  const fn = { callId: id, name, arguments: JSON.stringify(args) };
  return { id, model: 'gpt-6.1-terra', output: [{ type: 'function_call', call_id: id, name, arguments: fn.arguments }], calls: [fn], usage: null };
}
class ScriptedModel implements ModelGateway {
  requests: ModelRequest[] = [];
  readonly next: (request: ModelRequest, n: number) => ModelReply;
  constructor(next: (request: ModelRequest, n: number) => ModelReply) { this.next = next; }
  async generate(request: ModelRequest): Promise<ModelReply> { const { signal: _, ...captured } = request; this.requests.push(structuredClone(captured)); return this.next(request, this.requests.length); }
}
const tool = { name: 'move', description: '移动', effect: 'command' as const, inputSchema: Type.Object({ index: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }) };
class Port implements MatchPort {
  calls: ToolRequest[] = [];
  done = false;
  rev = 0;
  events = [{ id: 'own-event', revision: 0, data: { knownCard: '自身看过的卡' } }];
  async observe(matchId: string, playerId: string, after: string | null): Promise<PlayerFrame> {
    return { matchId, playerId, revision: this.rev, cursor: '1', status: this.done ? 'finished' : 'active', snapshot: { private: `only-${playerId}` }, observations: after ? [] : this.events, tools: [tool] };
  }
  async execute(request: ToolRequest) {
    this.calls.push(request); this.done = true; this.rev++;
    return { status: 'committed' as const, revision: this.rev, data: { ok: true } };
  }
}
async function setup(model: ModelGateway, port: MatchPort = new Port(), store = new MemorySessionStore()) {
  const trace = new Trace();
  const runtime = new AgentRuntime({ model, match: port, store, trace, prompts: await loadPrompts() });
  await runtime.create({ matchId: 'm', playerId: 'A', deck: { name: 'A-deck' }, strategy: { version: 1, content: '' }, rules: '规则集合 cn-official-2026-10-27' });
  return { runtime, port, store, trace };
}

test('模型只选择工具，身份、请求 ID 和版本由运行模块绑定', async () => {
  const model = new ScriptedModel(() => call('move', { index: 0 }));
  const { runtime, port } = await setup(model);
  assert.deepEqual(await runtime.activate('m', 'A'), { status: 'finished', decisions: 1 });
  const request = (port as Port).calls[0]!;
  assert.equal(request.playerId, 'A'); assert.equal(request.revision, 0); assert.ok(request.requestId.length > 20);
});

test('唯一批量工具明确请求函数调用，避免纯文字答复耗尽重试而没有执行', async () => {
  const model = new ScriptedModel(request => request.toolChoice === 'execute_sequence'
    ? call('execute_sequence', { actions: [{ tool: 'move', arguments: { index: 0 } }] })
    : { id: 'text-only', model: 'test', output: [{ role: 'assistant', content: '操作计划' }], calls: [], usage: null });
  const { runtime, port } = await setup(model);
  assert.deepEqual(await runtime.activate('m', 'A'), { status: 'finished', decisions: 1 });
  assert.equal((port as Port).calls.length, 1);
  assert.equal(model.requests.length, 1);
});

test('单步模式唯一原子工具明确调用；多个原子工具仍由模型选择', async () => {
  for (const multiple of [false, true]) {
    const port = new Port();
    const observe = port.observe.bind(port);
    port.observe = async (...args) => {
      const frame = await observe(...args);
      return multiple ? { ...frame, tools: [...frame.tools, { ...tool, name: 'other_move' }] } : frame;
    };
    const model = new ScriptedModel(request => request.toolChoice === (multiple ? undefined : 'move')
      ? call('move', { index: 0 })
      : { id: 'text-only', model: 'test', output: [{ role: 'assistant', content: '操作计划' }], calls: [], usage: null });
    const runtime = new AgentRuntime({ model, match: port, store: new MemorySessionStore(), trace: new Trace(), prompts: await loadPrompts(), limits: { maxActionsPerDecision: 1 } });
    await runtime.create({ matchId: 'm', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
    assert.deepEqual(await runtime.activate('m', 'A'), { status: 'finished', decisions: 1 });
    assert.equal(port.calls.length, 1);
  }
});

test('等待期间短暂展示持久排队，失败重启后仍进入下一次实际模型请求', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-observation-delivery-'));
  const store = new FileSessionStore(directory);
  let phase = 0;
  const port: MatchPort = {
    async observe(matchId, playerId, after) {
      return { matchId, playerId, revision: phase, cursor: phase === 0 ? '1' : '2', status: phase === 1 ? 'waiting' : phase === 3 ? 'finished' : 'active', snapshot: {}, tools: [tool], observations: phase === 0 && !after ? [{ id: 'initial', revision: 0, data: {} }] : phase === 1 && after === '1' ? [{ id: 'transient-public', revision: 1, data: { shownCard: '短暂展示后重新隐藏的牌' } }] : [] };
    },
    async execute() { phase = phase === 0 ? 1 : 3; return { status: 'committed', revision: phase, data: {} }; },
  };
  const model = new ScriptedModel((_, n) => { if (n === 2) throw new Error('temporary model failure'); return call('move', { index: 0 }, `call-${n}`); });
  const options = { model, match: port, store, trace: new Trace(), prompts: await loadPrompts() };
  const first = new AgentRuntime(options);
  await first.create({ matchId: 'delivery', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  assert.equal((await first.activate('delivery', 'A')).status, 'waiting');
  const waiting = await store.load('delivery', 'A');
  assert.equal(waiting!.cursor, '2');
  assert.deepEqual(waiting!.pendingObservations.map(item => item.id), ['transient-public']);
  phase = 2;
  assert.equal((await new AgentRuntime(options).activate('delivery', 'A')).status, 'aborted');
  assert.match(JSON.stringify(model.requests[1]!.input), /短暂展示后重新隐藏的牌/);
  assert.deepEqual((await store.load('delivery', 'A'))!.pendingObservations, []);
  assert.equal((await new AgentRuntime(options).activate('delivery', 'A')).status, 'finished');
  assert.match(JSON.stringify(model.requests[2]!.input), /短暂展示后重新隐藏的牌/);
  const { rm } = await import('node:fs/promises');
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test('裁判终局必须明确异常或确认有效报告，不根据当前环节推测意图', async () => {
  let result: unknown = { kind: 'abnormal', reason: '违规无法修复' };
  const model = new ScriptedModel(() => call('submit_result', { verdict: 'uphold', explanation: '资料核对', evidenceRefs: ['e'], ruleRefs: ['rule'], steps: [{ kind: 'end_match', result }] }));
  const { runtime } = await setup(model);
  const input = { matchId: 'm', disputeId: 'd', facts: {}, evidenceIds: ['e'], ruleRefs: ['rule'], validRestoreTargets: [], validReportedResults: ['report-valid'], zones: [], rules: '' };
  assert.deepEqual((await runtime.judge(input)).steps, [{ kind: 'end_match', result }]);
  result = { kind: 'confirm_reported_result', reportEventId: 'report-valid' };
  assert.deepEqual((await runtime.judge(input)).steps, [{ kind: 'end_match', result }]);
  result = { kind: 'confirm_reported_result', reportEventId: 'report-revoked' };
  await assert.rejects(runtime.judge(input), /INVALID_REPORTED_RESULT/);
});

test('裁判语义和宿主计划校验错误反馈后可在有限次数内纠正', async () => {
  const model = new ScriptedModel((_, n) => call('submit_result', { verdict: 'uphold', explanation: '有依据的处置', evidenceRefs: ['e'], ruleRefs: ['rule'], steps: [{ kind: 'restore', targetEventId: n === 1 ? 'bad-target' : 'valid-target' }] }, `judge-${n}`));
  const { runtime } = await setup(model);
  let hostChecks = 0;
  const result = await runtime.judge({ matchId: 'm', disputeId: 'd', facts: {}, evidenceIds: ['e'], ruleRefs: ['rule'], validRestoreTargets: ['valid-target'], zones: [], rules: '' }, () => { if (++hostChecks === 1) throw new Error('CANDIDATE_PLAN_INVALID'); });
  assert.deepEqual(result.steps, [{ kind: 'restore', targetEventId: 'valid-target' }]);
  assert.equal(model.requests.length, 3);
  assert.match(JSON.stringify(model.requests[1]!.input), /INVALID_RESTORE_TARGET/);
  assert.match(JSON.stringify(model.requests[2]!.input), /CANDIDATE_PLAN_INVALID/);
});

test('总结和压缩的越权证据同样反馈重试，纠正前不保存候选', async () => {
  const counts = { summary: 0, compactor: 0 };
  const model = new ScriptedModel(request => {
    if (request.role === 'player') return call('move', { index: 0 }, 'play');
    if (request.role === 'judge') throw new Error('unexpected judge');
    const stage = JSON.parse(request.input[0]!.content as string).stage;
    if (stage === 'policy_patch') return call('submit_result', { baseVersion: 1, changes: [], changeSummary: '已核验，无策略增量' });
    if (stage === 'facts_review') { const input = JSON.parse(request.input[0]!.content as string); return call('submit_result', { assessments: input.facts.map((f: { id: string }) => ({ factId: f.id, status: 'supported', evidenceRefs: ['own-event'], publicRefs: [], explanation: '原始事件支持' })) }); }
    const n = ++counts[request.role];
    const refs = n === 1 ? ['unknown-evidence'] : [request.role === 'compactor' ? 'e1' : 'own-event'];
    return call('submit_result', request.role === 'summary' ? { facts: [{ id: 'observed', kind: 'event', status: 'supported', statement: '已执行操作', subjectRefs: [], conflictKey: 'operation', evidenceRefs: refs, publicRefs: [], relatedEntryIds: [] }] } : { text: '合法摘要', evidenceRefs: refs }, `${request.role}-${n}`);
  });
  const { runtime, store } = await setup(model);
  await runtime.activate('m', 'A');
  assert.deepEqual((await runtime.summarize('m', 'A', { version: 1, content: '' })).policy!.entries, []);
  await runtime.compact('m', 'A');
  assert.deepEqual(counts, { summary: 2, compactor: 2 });
  assert.equal((await store.load('m', 'A'))!.summary!.text, '合法摘要');
  for (const role of ['summary', 'compactor']) {
    const requests = model.requests.filter(request => request.role === role);
    assert.match(JSON.stringify(requests[1]!.input), role === 'compactor' ? /invalidEvidenceRefs.*unknown-evidence/ : /EVIDENCE_OUT_OF_SCOPE/);
  }
});

test('无效参数会反馈后纠正，不能先把无效命令送到游戏模块', async () => {
  const model = new ScriptedModel((_, n) => call('move', n === 1 ? { index: -1 } : { index: 0 }, `c${n}`));
  const { runtime, port, store } = await setup(model);
  assert.equal((await runtime.activate('m', 'A')).status, 'finished');
  assert.equal((port as Port).calls.length, 1);
  assert.match(JSON.stringify(model.requests[1]?.input), /rejected/);
  assert.equal((await store.load('m', 'A'))?.toolHistory.length, 2);
});

test('模型伪造身份或版本参数被 schema 拒绝', async () => {
  const model = new ScriptedModel(() => call('move', { index: 0, playerId: 'B', revision: 99 }));
  const { runtime, port } = await setup(model);
  const result = await runtime.activate('m', 'A');
  assert.equal(result.status, 'aborted'); assert.equal((port as Port).calls.length, 0);
});

test('一次返回多个调用时不执行任何一个，且返回每个调用的错误', async () => {
  const model = new ScriptedModel((_, n) => {
    if (n > 1) return call('move', { index: 0 }, `c${n}`);
    const first = call('move', { index: 0 }, 'a'); const second = call('move', { index: 1 }, 'b');
    return { ...first, output: [...first.output, ...second.output], calls: [...first.calls, ...second.calls] };
  });
  const { runtime, port } = await setup(model);
  assert.equal((await runtime.activate('m', 'A')).status, 'finished');
  assert.equal((port as Port).calls.length, 1);
  assert.equal(model.requests[1]?.input.filter(i => i.type === 'function_call_output').length, 2);
});

test('真实副作用提交后断连，重启使用同一 ID／版本，不重复执行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-resume-'));
  const store = new FileSessionStore(directory);
  let effects = 0; let original: ToolRequest | null = null;
  const port = new Port();
  port.execute = async request => {
    if (!original) { original = structuredClone(request); effects++; throw new Error('uncertain write'); }
    assert.deepEqual(request, original);
    port.done = true;
    return { status: 'committed', revision: 1, data: { ok: true } };
  };
  const model = new ScriptedModel(() => call('move', { index: 0 }));
  const trace = new Trace(); const prompts = await loadPrompts();
  const first = new AgentRuntime({ model, match: port, store, trace, prompts });
  await first.create({ matchId: 'm', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  assert.equal((await first.activate('m', 'A')).status, 'aborted');
  assert.ok((await store.load('m', 'A'))?.pending);
  const resumed = new AgentRuntime({ model, match: port, store: new FileSessionStore(directory), trace, prompts });
  assert.equal((await resumed.activate('m', 'A')).status, 'finished');
  assert.equal(effects, 1); assert.equal(model.requests.length, 1);
});

test('等待对手时不调用模型；双方固定资料与私有观察不串流', async () => {
  const model = new ScriptedModel(() => call('move', { index: 0 }));
  const { runtime, store, port } = await setup(model);
  await runtime.create({ matchId: 'm', playerId: 'B', deck: { secret: 'B_PRIVATE' }, strategy: { version: 3, content: 'B_STRATEGY' }, rules: '' });
  await runtime.activate('m', 'A');
  assert.doesNotMatch(JSON.stringify(model.requests), /B_PRIVATE|B_STRATEGY|only-B/);
  (port as Port).done = false;
  const before = model.requests.length;
  const observe = port.observe.bind(port);
  port.observe = async (...args) => ({ ...await observe(...args), status: 'waiting' });
  assert.equal((await runtime.activate('m', 'B')).status, 'waiting');
  assert.equal(model.requests.length, before);
  assert.equal((await store.load('m', 'B'))?.strategy.version, 3);
});

test('上下文压缩保留已见信息和回滚通知，不修改初始策略', async () => {
  const model = new ScriptedModel(request => request.role === 'compactor'
    ? call('submit_result', { text: '看过的卡仍记得；牌桌已回滚，旧位置无效。', evidenceRefs: ['e1'] }) : call('move', { index: 0 }));
  const { runtime, store } = await setup(model);
  await runtime.activate('m', 'A'); await runtime.compact('m', 'A');
  const session = (await store.load('m', 'A'))!;
  assert.equal(session.observations.length, 1); assert.equal(session.compactions, 1); assert.equal(session.strategy.content, '');
  assert.match(session.summary?.text ?? '', /仍记得/);
});

test('裁判不能恢复已撤销事件或引用不在输入范围内的资料', async () => {
  const model = new ScriptedModel(() => call('submit_result', { verdict: 'uphold', explanation: '测试', evidenceRefs: ['e'], ruleRefs: ['r'], steps: [{ kind: 'restore', targetEventId: 'revoked' }] }));
  const { runtime } = await setup(model);
  await assert.rejects(runtime.judge({ matchId: 'm', disputeId: 'd', facts: {}, evidenceIds: ['e'], ruleRefs: ['r'], validRestoreTargets: ['active'], zones: [], rules: '' }), /INVALID_RESTORE_TARGET/);
});

test('总结只使用本席位资料，未知证据引用不能发布', async () => {
  const model = new ScriptedModel(request => request.role === 'player' ? call('move', { index: 0 })
    : call('submit_result', { facts: [{ id: 'foreign', kind: 'event', status: 'supported', statement: '越权资料', subjectRefs: [], conflictKey: 'foreign', evidenceRefs: ['opponent-secret-event'], publicRefs: [], relatedEntryIds: [] }] }));
  const { runtime } = await setup(model);
  await runtime.activate('m', 'A');
  await assert.rejects(runtime.summarize('m', 'A', { version: 1, content: '' }), /EVIDENCE_OUT_OF_SCOPE/);
});

test('策略版本原子保存，重启重试不重复发布，旧基础版本不能覆盖新经验', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-memory-')); const trace = new Trace();
  const repo = new StrategyRepository(dir, trace); const opponent = await repo.create({ cards: [] });
  const input = { opponentId: opponent.id, matchId: 'm', playerId: 'A', baseVersion: 1, update: { strategy: '新策略', changeSummary: '经验', evidenceRefs: ['e'] } };
  assert.equal((await repo.publish(input)).version, 2);
  const restart = new StrategyRepository(dir, trace);
  assert.equal((await restart.publish(input)).version, 2);
  assert.equal((await restart.read(opponent.id)).strategies.length, 2);
  await assert.rejects(restart.publish({ ...input, matchId: 'new' }), /STRATEGY_VERSION_CONFLICT/);
});

test('SSE 任意分片和 CRLF 可以解析；缺少 completed 不能当作成功', async () => {
  const text = 'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\r\n\r\n';
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const char of text) controller.enqueue(new TextEncoder().encode(char)); controller.close(); } });
  const result = await consumeResponses(new Response(stream), async () => {}); assert.equal(result.id, 'r');
  await assert.rejects(consumeResponses(new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), async () => {}), /未收到 response.completed/);
});

test('流式 failed 事件必须失败，即使之前已有文字输出', async () => {
  await assert.rejects(consumeResponses(new Response('data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded"}}}\n\n'), async () => {}), /rate_limit_exceeded/);
});

test('本地认证只读；凭证和账户标识不进入轨迹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-auth-')); const path = join(dir, 'auth.json');
  const token = 'not-a-real-access-token'; const refresh = 'not-a-real-refresh-token';
  const original = JSON.stringify({ tokens: { access_token: token, refresh_token: refresh, account_id: 'private-account-123' } });
  await writeFile(path, original); const redactor = new SecretRedactor(); const source = new LocalCodexCredentials(path, redactor);
  assert.equal((await source.headers()).Authorization, `Bearer ${token}`);
  const trace = new JsonlTrace(join(dir, 'trace.jsonl'), redactor);
  await trace.append({ nested: { access_token: token }, message: `Bearer ${token} ${refresh} private-account-123` });
  const output = await readFile(trace.path, 'utf8');
  for (const value of [token, refresh, 'private-account-123']) assert.ok(!output.includes(value));
  assert.equal(await readFile(path, 'utf8'), original);
});

test('兼容协议转换保留完整的调用／反馈对，不伪造加密推理为文字', () => {
  const output = toChatMessages('sys', [{ type: 'function_call', call_id: 'c', name: 'move', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: '{"ok":true}' }, { type: 'reasoning', encrypted_content: 'opaque' }]);
  assert.equal(output.length, 3); assert.equal(output[2]?.tool_call_id, 'c'); assert.doesNotMatch(JSON.stringify(output), /opaque/);
});

test('模型返回瞬间收到取消，不再执行新的牌桌操作', async () => {
  const controller = new AbortController();
  const model = new ScriptedModel(() => { controller.abort(); return call('move', { index: 0 }); });
  const { runtime, port, store } = await setup(model);
  const result = await runtime.activate('m', 'A', controller.signal);
  assert.equal(result.status, 'aborted'); assert.equal(result.reason, 'CANCELLED');
  assert.equal((port as Port).calls.length, 0); assert.ok((await store.load('m', 'A'))?.pending);
});

test('模型配置只接受凭证引用，明文密钥或 fast 配置必须拒绝', () => {
  const trace = new Trace();
  const valid = { schemaVersion: 1, model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, connection: { kind: 'openai_compatible', baseUrl: 'https://example.com/v1', apiKeyEnv: 'MODEL_API_KEY', protocol: 'responses' } } as const;
  assert.ok(createModel(valid, trace));
  assert.throws(() => createModel({ ...valid, fast: true } as unknown as typeof valid, trace), /STRUCTURED_OUTPUT_INVALID/);
  assert.throws(() => createModel({ ...valid, apiKey: 'plaintext-is-not-accepted' } as typeof valid, trace), /STRUCTURED_OUTPUT_INVALID/);
});

test('压缩消耗最后一次调用额度后，不能再超额请求玩家模型', async () => {
  const model = new ScriptedModel(() => call('submit_result', { text: '无历史，无新增事实。', evidenceRefs: [] }));
  const store = new MemorySessionStore(); const port = new Port();
  const runtime = new AgentRuntime({ model, match: port, store, trace: new Trace(), prompts: await loadPrompts(), limits: { maxTotalModelCalls: 1, compactAfterBytes: 1 } });
  const session = await runtime.create({ matchId: 'm', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  // 自动压缩只处理已被玩家消费的资料，先建立这样的历史前缀。
  session.observations = structuredClone(port.events);
  session.messages = [{ role: 'user', content: JSON.stringify({ observations: session.observations }) }];
  Object.assign(session.context!, { deliveredMessages: 1, deliveredObservations: 1, deliveredTools: 0 });
  playerInput(session, await port.observe('m', 'A', null), 16);
  session.context!.deliveredWireItems = session.context!.wire!.items.length;
  await store.save(session);
  const result = await runtime.activate('m', 'A');
  assert.equal(result.status, 'aborted'); assert.equal(result.reason, 'TOTAL_MODEL_BUDGET_EXHAUSTED');
  assert.equal(model.requests.length, 1); assert.equal(model.requests[0]?.role, 'compactor'); assert.equal(port.calls.length, 0);
  assert.equal((await store.load('m', 'A'))?.modelCalls, 1);
});

test('执行中的席位拒绝并发总结，不覆盖工具循环的上下文', async () => {
  let release: (reply: ModelReply) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const model: ModelGateway = { async generate() { started(); return new Promise<ModelReply>(resolve => { release = resolve; }); } };
  const { runtime } = await setup(model);
  const running = runtime.activate('m', 'A'); await ready;
  await assert.rejects(runtime.summarize('m', 'A', { version: 1, content: '' }), /ACTIVATION_IN_PROGRESS/);
  release(call('move', { index: 0 }));
  assert.equal((await running).status, 'finished');
});
