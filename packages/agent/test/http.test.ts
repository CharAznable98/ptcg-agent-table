import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Type } from '@sinclair/typebox';
import { HttpModelGateway, SecretRedactor, createModel } from '../src/index.ts';
import type { ModelRequest, TraceSink } from '../src/types.ts';

const request: ModelRequest = { role: 'player', sessionId: 'test', instructions: 'sys', input: [{ role: 'user', content: 'next' }], tools: [{ name: 'next', description: '选择下一步', effect: 'command', inputSchema: Type.Object({}, { additionalProperties: false }) }] };
const completed = { type: 'response.completed', response: { id: 'r', model: 'gpt-6.1-terra', status: 'completed', service_tier: 'default', reasoning: { effort: 'medium' }, output: [{ type: 'function_call', call_id: 'c', name: 'next', arguments: '{}' }] } };
function finish(res: ServerResponse, event = completed): void { res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify(event)}\n\n`); }
async function listen(server: Server): Promise<string> { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
const noTrace: TraceSink = { async append() {} };

test('会话缓存key跨决策和复盘分页稳定，按角色和玩家隔离，可关闭兼容接口参数', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); bodies.push(JSON.parse(Buffer.concat(chunks).toString())); finish(res); });
  const baseUrl = await listen(server);
  try {
    const model = new HttpModelGateway({ baseUrl, credentials: { async headers() { return {}; } }, protocol: 'responses', model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, trace: noTrace, cacheKeyStrategy: 'session' });
    for (const [role, sessionId] of [['player', 'A'], ['player', 'A'], ['player', 'B'], ['compactor', 'A'], ['summary', 'summary:A:chunk-1'], ['summary', 'summary:A:chunk-2'], ['summary', 'summary:A']] as const) await model.generate({ ...request, role, sessionId });
    const keys = bodies.map(body => body.prompt_cache_key);
    assert.equal(typeof keys[0], 'string', 'SESSION_CACHE_KEY_MISSING');
    assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]); assert.notEqual(keys[0], keys[3]);
    assert.equal(keys[4], keys[5]); assert.equal(keys[4], keys[6]);
    assert.match(keys[0] as string, /^ptcg:[a-f0-9]{48}$/);
    const common = { schemaVersion: 1 as const, model: 'gpt-6.1-terra', reasoningEffort: 'medium' as const, fast: false as const };
    assert.equal(createModel({ ...common, connection: { kind: 'local_codex_credentials' } }, noTrace).options.cacheKeyStrategy, 'session');
    assert.equal(createModel({ ...common, cacheKeyStrategy: 'disabled', connection: { kind: 'local_codex_credentials' } }, noTrace).options.cacheKeyStrategy, 'disabled');
    const compatible = createModel({ ...common, connection: { kind: 'openai_compatible', baseUrl, apiKeyEnv: 'PTCG_UNUSED_TEST_KEY', protocol: 'responses' } }, noTrace);
    assert.equal(compatible.options.cacheKeyStrategy, 'disabled');
    const disabled = new HttpModelGateway({ ...model.options, cacheKeyStrategy: 'disabled' });
    await disabled.generate(request); assert.equal(Object.hasOwn(bodies.at(-1)!, 'prompt_cache_key'), false);
  } finally { await close(server); }
});

test('参数流退化为重复数字时立即终止并重试，不能等满总时限或执行半截参数', async () => {
  let attempts = 0; const events: Record<string, unknown>[] = [];
  const server = createServer((_, res) => {
    if (++attempts > 1) { finish(res); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    for (const delta of ['{"index":2', '  2  2  2']) res.write(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'bad', delta })}\n\n`);
  });
  const baseUrl = await listen(server);
  try {
    const model = new HttpModelGateway({ baseUrl, credentials: { async headers() { return {}; } }, protocol: 'responses', model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, timeoutMs: 300, maxRetries: 1, trace: { async append(event) { events.push(event); } } });
    assert.equal((await model.generate(request)).calls.length, 1);
    const failure = events.find(event => event.kind === 'model_failed')!;
    assert.equal(failure.code, 'INVALID_TOOL_ARGUMENT_STREAM');
    assert.ok((failure.elapsedMs as number) < 250);
    assert.equal(attempts, 2);
  } finally { await close(server); }
});

test('HTTP 503 安全重试，发送固定 Terra／medium／default 参数，无 Codex 进程', async () => {
  let attempts = 0;
  const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString())); attempts++;
    assert.equal(req.headers.authorization, 'Bearer test-secret-123');
    if (attempts === 1) { res.writeHead(503); res.end('{"error":{"code":"busy"}}'); } else finish(res);
  });
  const baseUrl = await listen(server);
  try {
    const model = new HttpModelGateway({ baseUrl, credentials: { async headers() { return { Authorization: 'Bearer test-secret-123' }; } }, protocol: 'responses', model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, trace: noTrace });
    assert.equal((await model.generate(request)).calls[0]?.name, 'next');
    assert.equal(attempts, 2); assert.deepEqual(bodies[0], bodies[1]);
    assert.equal((bodies[0] as { service_tier: string }).service_tier, 'default');
  } finally { await close(server); }
});

test('流未完成时重试不直接返回半截工具参数', async () => {
  let attempts = 0;
  const server = createServer((_, res) => { attempts++; if (attempts === 1) res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); else finish(res); });
  const baseUrl = await listen(server);
  try {
    const model = new HttpModelGateway({ baseUrl, credentials: { async headers() { return {}; } }, protocol: 'responses', model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, trace: noTrace });
    assert.equal((await model.generate(request)).calls.length, 1); assert.equal(attempts, 2);
  } finally { await close(server); }
});

test('模型不匹配时失败，绝不静默替换模型', async () => {
  const server = createServer((_, res) => finish(res, { ...completed, response: { ...completed.response, model: 'wrong-model' } }));
  const baseUrl = await listen(server);
  try {
    const model = new HttpModelGateway({ baseUrl, credentials: { async headers() { return {}; } }, protocol: 'responses', model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, trace: noTrace });
    await assert.rejects(model.generate(request), /模型与请求不一致/);
  } finally { await close(server); }
});

test('即使 TraceSink 没有共享 redactor，提供方回显凭证也会被模型层屏蔽', async () => {
  const token = 'test-private-access-9841'; const events: Record<string, unknown>[] = [];
  const server = createServer((_, res) => finish(res, { ...completed, response: { ...completed.response, output: [{ type: 'message', call_id: 'unused', name: 'unused', arguments: token }] } }));
  const baseUrl = await listen(server);
  try {
    const model = new HttpModelGateway({ baseUrl, credentials: { async headers() { return { Authorization: `Bearer ${token}` }; } }, protocol: 'responses', model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, trace: { async append(event) { events.push(event); } }, redactor: new SecretRedactor() });
    await model.generate(request);
    assert.ok(!JSON.stringify(events).includes(token));
  } finally { await close(server); }
});
