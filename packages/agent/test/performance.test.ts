import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Type } from '@sinclair/typebox';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime, HttpModelGateway, JsonlTrace, MemorySessionStore, SecretRedactor, loadPrompts, validationError } from '../src/index.ts';
import type { MatchPort, ModelReply } from '../src/types.ts';

const reply = (value: unknown): ModelReply => ({ id: 'compaction', model: 'test', output: [], calls: [{ callId: 'result', name: 'submit_result', arguments: JSON.stringify(value) }], usage: null });

test('压缩使用受约束的短引用，落盘还原原始证据ID，错误反馈指出无效引用', async () => {
  const originalId = '40084ce2-9473-405c-ac7d-0ff7b0efc025';
  const store = new MemorySessionStore(); let calls = 0;
  const port: MatchPort = {
    async observe(matchId, playerId) { return { matchId, playerId, revision: 1, cursor: '1', status: 'waiting', snapshot: {}, observations: [{ id: originalId, revision: 1, data: { seen: '曾看到的秘密', positionExpired: true } }], tools: [] }; },
    async execute() { throw Error('不应执行牌桌操作'); },
  };
  const runtime = new AgentRuntime({ store, match: port, trace: { async append() {} }, prompts: await loadPrompts(), model: { async generate(request) {
    const input = JSON.parse(request.input[0]!.content as string);
    assert.equal(input.observations[0].id, 'e1');
    assert.deepEqual(input.evidenceSources, { e1: originalId });
    const schema = request.tools[0]!.inputSchema;
    assert.equal(validationError(schema, { text: '保留秘密，旧位置已失效。', evidenceRefs: ['e1'] }), null);
    assert.equal(validationError(schema, { text: '保留秘密', evidenceRefs: ['e999'] }), null, '动态允许集合由宿主校验，工具定义保持固定');
    assert.deepEqual(input.allowedEvidenceRefs, ['e1']);
    if (++calls === 1) return reply({ text: '保留秘密，旧位置已失效。', evidenceRefs: ['e999'] });
    const feedback = request.input.find(m => m.type === 'function_call_output')!.output as string;
    assert.match(feedback, /e999/); assert.match(feedback, /e1/);
    return reply({ text: '保留秘密，旧位置已失效。', evidenceRefs: ['e1'] });
  } } });
  await runtime.create({ matchId: 'memory', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  await runtime.activate('memory', 'A'); await runtime.compact('memory', 'A');
  const session = (await store.load('memory', 'A'))!;
  assert.deepEqual(session.summary?.evidenceRefs, [originalId]);
  assert.equal(session.observations[0]!.id, originalId); assert.equal(session.compactions, 1);
  assert.match(session.summary!.text, /旧位置已失效/);
});

test('流式片段批量写盘，关键记录返回前持久保存全部前缀', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-buffer-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const redactor = new SecretRedactor(); redactor.add('secret-for-test');
  // 长定时器和高阈值让断言不依赖机器速度。
  const trace = new JsonlTrace(join(dir, 'trace.jsonl'), redactor, { streamBatchBytes: 1_000_000, streamFlushIntervalMs: 60_000 });
  await trace.append({ kind: 'model_started', index: 0 });
  for (let n = 1; n <= 100; n++) await trace.append({ kind: 'model_stream', index: n, text: 'secret-for-test' });
  const early = (await readFile(trace.path, 'utf8')).trim().split('\n');
  assert.equal(early.length, 1, '等待片段不能逐条同步写盘');
  await trace.append({ kind: 'tool_started', index: 101 });
  const raw = await readFile(trace.path, 'utf8'), rows = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.index), Array.from({ length: 102 }, (_, n) => n));
  assert.ok(!raw.includes('secret-for-test'));
});

test('短引用跨压缩保持稳定，只提供旧摘要引用与新增观察的来源', async () => {
  const store = new MemorySessionStore(), ids = ['source-first', 'source-new']; let current = 0;
  const port: MatchPort = { async observe(matchId, playerId, after) { return { matchId, playerId, revision: current, cursor: String(current), status: 'waiting', snapshot: {}, observations: after === String(current) ? [] : [{ id: ids[current]!, revision: current, data: { turn: current } }], tools: [] }; }, async execute() { throw Error('unexpected'); } };
  let calls = 0;
  const runtime = new AgentRuntime({ store, match: port, trace: { async append() {} }, prompts: await loadPrompts(), model: { async generate(request) {
    const input = JSON.parse(request.input[0]!.content as string);
    if (++calls === 1) return reply({ text: '保留第一条私人事实。', evidenceRefs: ['e1'] });
    assert.equal(input.observations[0].id, 'e2'); assert.deepEqual(input.previousSummary.evidenceRefs, ['e1']);
    assert.deepEqual(input.evidenceSources, { e1: ids[0], e2: ids[1] });
    return reply({ text: '第一条私人事实仍在，新增第二条。', evidenceRefs: ['e1', 'e2'] });
  } } });
  await runtime.create({ matchId: 'stable', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  await runtime.activate('stable', 'A'); await runtime.compact('stable', 'A'); current++;
  await runtime.activate('stable', 'A'); await runtime.compact('stable', 'A');
  assert.deepEqual((await store.load('stable', 'A'))!.summary!.evidenceRefs, ids);
});

test('按需读取重新带回的旧观察仍可作为压缩证据', async () => {
  const store = new MemorySessionStore(); let calls = 0;
  const port: MatchPort = { async observe(matchId, playerId) { return { matchId, playerId, revision: 1, cursor: '1', status: 'waiting', snapshot: {}, observations: [{ id: 'old-seen-event', revision: 1, data: { seen: '旧的私人事实' } }], tools: [] }; }, async execute() { throw Error('unexpected'); } };
  const runtime = new AgentRuntime({ store, match: port, trace: { async append() {} }, prompts: await loadPrompts(), model: { async generate(request) {
    const input = JSON.parse(request.input[0]!.content as string);
    if (++calls === 1) return reply({ text: '普通摘要，没有保留该事实的引用。', evidenceRefs: [] });
    assert.deepEqual(input.observations, []); assert.equal(input.evidenceSources.e1, 'old-seen-event');
    return reply({ text: '按需读回旧的私人事实。', evidenceRefs: ['e1'] });
  } } });
  await runtime.create({ matchId: 'retrieved', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  await runtime.activate('retrieved', 'A'); await runtime.compact('retrieved', 'A');
  const session = (await store.load('retrieved', 'A'))!;
  session.toolHistory.push({ request: { tool: 'read_history' }, receipt: { status: 'read', data: { entries: [{ id: 'old-seen-event', seen: '旧的私人事实' }] } } });
  await store.save(session); await runtime.compact('retrieved', 'A');
  assert.deepEqual((await store.load('retrieved', 'A'))!.summary!.evidenceRefs, ['old-seen-event']);
});

test('流式刷盘失败后阻止后续关键记录，不能吞掉异步写入错误', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-trace-fail-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const trace = new JsonlTrace(join(dir, 'logs/trace.jsonl'));
  await trace.append({ kind: 'model_started' });
  await rm(join(dir, 'logs'), { recursive: true }); await writeFile(join(dir, 'logs'), 'blocked');
  await trace.append({ kind: 'model_stream', event: { type: 'delta' } });
  await assert.rejects(trace.flush());
  await assert.rejects(trace.append({ kind: 'tool_started' }));
});

test('低流量片段也会由定时器落盘，无需等待模型结束', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-trace-timer-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const trace = new JsonlTrace(join(dir, 'trace.jsonl'), new SecretRedactor(), { streamFlushIntervalMs: 5 });
  await trace.append({ kind: 'model_started' }); await trace.append({ kind: 'model_stream', note: 'partial' });
  const deadline = Date.now() + 2000;
  for (;;) {
    if ((await readFile(trace.path, 'utf8')).includes('partial')) break;
    assert.ok(Date.now() < deadline, '定时刷新没有写入');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await trace.flush();
});

test('批量记录遇流中断仍完整落盘失败轨迹，半截参数不能触发牌桌副作用', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-stream-fail-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"type":"response.function_call_arguments.delta","delta":"{\\"step\\":"}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const trace = new JsonlTrace(join(dir, 'trace.jsonl'));
  const model = new HttpModelGateway({ baseUrl: `http://127.0.0.1:${address.port}`, credentials: { async headers() { return {}; } }, protocol: 'responses', model: 'test', reasoningEffort: 'medium', fast: false, maxRetries: 0, trace });
  let effects = 0;
  const port: MatchPort = { async observe(matchId, playerId) { return { matchId, playerId, revision: 0, cursor: '0', status: 'active', snapshot: {}, observations: [], tools: [{ name: 'advance', description: 'advance', effect: 'command', inputSchema: Type.Object({}) }] }; }, async execute() { effects++; throw Error('unexpected effect'); } };
  const runtime = new AgentRuntime({ model, trace, store: new MemorySessionStore(), match: port, prompts: await loadPrompts() });
  await runtime.create({ matchId: 'partial', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  const result = await runtime.activate('partial', 'A'); assert.equal(result.status, 'aborted'); assert.match(result.reason!, /response.completed/); assert.equal(effects, 0);
  const events = (await readFile(trace.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.kind), ['context_created', 'context_segment_started', 'model_started', 'model_stream', 'model_failed', 'runtime_aborted']);
});
