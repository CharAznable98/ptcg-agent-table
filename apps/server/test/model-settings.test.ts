import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { buildApp } from '../src/app.ts';
import type { ModelConfig, ModelSettings, ModelSettingsInput } from '../../../packages/protocol/src/index.ts';

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-model-settings-'));
  const app = await buildApp({ dataDir: join(dir, 'data'), systemDir: join(dir, 'system') });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, app };
}
async function upstream(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}
function config(baseUrl = 'https://example.com/v1'): ModelConfig {
  return { schemaVersion: 1, model: 'provider-model', reasoningEffort: 'high', fast: false, maxRetries: 0, connection: { kind: 'openai_compatible', baseUrl, protocol: 'chat_completions' } };
}

test('前端提交 API Key 只写独立本地凭证；读取与配置快照不含正文，留空保留密钥', async t => {
  const { dir, app } = await setup(t);
  const key = 'synthetic-setting-secret-001';
  const result = await app.inject({ method: 'PUT', url: '/api/settings/model', payload: { ...config(), apiKey: key } });
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json<ModelSettings>().apiKeyConfigured, true);
  assert.ok(!result.body.includes(key));
  const saved = await app.gameService.modelConfig();
  assert.ok(!JSON.stringify(saved).includes(key)); assert.equal(saved.reasoningEffort, 'high');
  assert.equal(saved.connection.kind, 'openai_compatible');
  if (saved.connection.kind !== 'openai_compatible') throw new Error('unexpected connection');
  assert.ok(saved.connection.apiKeyFile);
  assert.equal(JSON.parse(await readFile(saved.connection.apiKeyFile, 'utf8')).apiKey, key);
  assert.equal((await stat(saved.connection.apiKeyFile)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(join(dir, 'system', 'agent.json'), 'utf8'))).includes(key));
  const read = await app.inject('/api/settings/model'); assert.equal(read.json<ModelSettings>().apiKeyConfigured, true); assert.ok(!read.body.includes(key));
  const { apiKeyConfigured: _configured, ...again } = read.json<ModelSettings>();
  const kept = await app.inject({ method: 'PUT', url: '/api/settings/model', payload: { ...again, apiKey: '' } });
  assert.equal(kept.statusCode, 200); assert.equal(kept.json<ModelSettings>().apiKeyConfigured, true);
  assert.equal((await readdir(join(dir, 'data', 'model-credentials'))).length, 1);
});

test('更换接口地址不会复用旧密钥，草稿不能伪造任意文件凭证引用', async t => {
  const { app } = await setup(t);
  await app.inject({ method: 'PUT', url: '/api/settings/model', payload: { ...config(), apiKey: 'synthetic-secret-old' } });
  const saved = await app.gameService.modelConfig();
  if (saved.connection.kind !== 'openai_compatible') throw new Error('unexpected connection');
  const wrongFile = await app.inject({ method: 'PUT', url: '/api/settings/model', payload: { ...saved, connection: { ...saved.connection, apiKeyFile: '/tmp/not-a-project-key.json' } } });
  assert.equal(wrongFile.statusCode, 400); assert.equal(wrongFile.json().error.code, 'INVALID_MODEL_CONFIG');
  const moved = await app.inject({ method: 'PUT', url: '/api/settings/model', payload: { ...saved, connection: { ...saved.connection, baseUrl: 'https://another.example/v1' } } });
  assert.equal(moved.statusCode, 200); assert.equal(moved.json<ModelSettings>().apiKeyConfigured, false);
  assert.equal(moved.json<ModelSettings>().connection.kind, 'openai_compatible'); assert.ok(!moved.body.includes('apiKeyFile'));
});

test('刷新模型和测试连接使用未保存表单，密钥不落盘，实际请求携带所选模型和思考强度', async t => {
  const { dir, app } = await setup(t);
  const key = 'synthetic-draft-secret-002'; const calls: { url: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const baseUrl = await upstream(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      calls.push({ url: request.url, authorization: request.headers.authorization, body });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url?.endsWith('/models')
        ? { data: [{ id: 'provider-model' }, { id: 'other-model', reasoningEfforts: ['low', 'high', 'unrecognized'] }, { id: 'provider-model' }, { broken: true }] }
        : { id: 'test-draft', model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '连接成功' } }], usage: null }));
    });
  });
  const draft: ModelSettingsInput = { ...config(baseUrl), apiKey: key };
  const models = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: draft });
  assert.equal(models.statusCode, 200, models.body);
  assert.deepEqual(models.json(), { models: [{ id: 'other-model', reasoningEfforts: ['low', 'high', 'unrecognized'] }, { id: 'provider-model' }] });
  const result = await app.inject({ method: 'POST', url: '/api/settings/model/test', payload: draft });
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().ok, true); assert.equal(result.json().effort, 'high');
  assert.equal(calls.length, 2); assert.equal(calls[0]!.authorization, `Bearer ${key}`); assert.equal(calls[1]!.authorization, `Bearer ${key}`);
  assert.equal(calls[1]!.body.model, 'provider-model'); assert.equal(calls[1]!.body.reasoning_effort, 'high');
  assert.equal((await app.gameService.modelConfig()).connection.kind, 'local_codex_credentials');
  await assert.rejects(stat(join(dir, 'system', 'agent.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(dir, 'data', 'model-credentials')), { code: 'ENOENT' });
  assert.ok(!(await readFile(join(dir, 'data', 'model-tests.jsonl'), 'utf8')).includes(key));
});

test('已保存 API Key 在重启后可读取并用于模型列表与连接测试；接口默认思考不传参数', async t => {
  const { dir, app } = await setup(t);
  const key = 'synthetic-persistent-secret-003'; const seen: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const baseUrl = await upstream(t, (request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      seen.push({ authorization: request.headers.authorization, body }); response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url?.endsWith('/models') ? { data: [{ id: 'provider-model' }] } : { id: 'restart', model: body.model, choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
    });
  });
  const saved = await app.inject({ method: 'PUT', url: '/api/settings/model', payload: { ...config(baseUrl), reasoningEffort: 'default', apiKey: key } });
  assert.equal(saved.statusCode, 200, saved.body);
  const restored = await buildApp({ dataDir: join(dir, 'data'), systemDir: join(dir, 'system') }); t.after(() => restored.close());
  assert.equal((await restored.inject('/api/settings/model')).json<ModelSettings>().apiKeyConfigured, true);
  const models = await restored.inject({ method: 'POST', url: '/api/settings/model/models' }); assert.equal(models.statusCode, 200, models.body);
  const result = await restored.inject({ method: 'POST', url: '/api/settings/model/test' }); assert.equal(result.json().ok, true, result.body);
  assert.ok(seen.every(call => call.authorization === `Bearer ${key}`)); assert.ok(!('reasoning_effort' in seen[1]!.body));
});

test('本地凭证从对应缓存提供动态思考档位与默认值，保留上游新增的合法档位', async t => {
  const { dir, app } = await setup(t); const authDirectory = join(dir, 'local-auth'); await mkdir(authDirectory);
  await writeFile(join(authDirectory, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'local-model', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'xhigh' }, { effort: 'ultra' }, { effort: 'bad value' }] }] }));
  const draft = { schemaVersion: 1, model: 'local-model', reasoningEffort: 'medium', fast: false, connection: { kind: 'local_codex_credentials', authFile: join(authDirectory, 'auth.json') } };
  const response = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: draft });
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { models: [{ id: 'local-model', reasoningEfforts: ['medium', 'xhigh', 'ultra'], defaultReasoningEffort: 'medium' }] });
});

test('模型列表读取 OpenRouter 的支持档位与默认强度，不按固定枚举丢弃新档位', async t => {
  const { app } = await setup(t);
  const baseUrl = await upstream(t, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'deepseek-model', reasoning: {
      supported_efforts: ['max', 'high', 'low', 'none', 'low', 'future_mode', 'default', 'BAD VALUE', 'high\n', 'a'.repeat(65), 12, {}, null],
      default_effort: 'high', default_enabled: true, mandatory: false,
    } }] }));
  });
  const result = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: config(baseUrl) });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { models: [{ id: 'deepseek-model', reasoningEfforts: ['max', 'high', 'low', 'none', 'future_mode'], defaultReasoningEffort: 'high', reasoningRequired: false }] });
});

test('上游新增档位从能力列表到保存重读再到 Responses 请求原样传递，保存不额外请求上游', async t => {
  const { app } = await setup(t);
  const seen: { url: string | undefined; body: Record<string, unknown> }[] = [];
  const baseUrl = await upstream(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      seen.push({ url: request.url, body });
      if (request.url?.endsWith('/models')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'provider-model', reasoning: { supported_efforts: ['adaptive'], default_effort: 'adaptive' } }] }));
      } else {
        response.setHeader('Content-Type', 'text/event-stream');
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'dynamic-effort', model: body.model, status: 'completed', reasoning: body.reasoning, output: [] } })}\n\n`);
      }
    });
  });
  const draft: ModelConfig = { ...config(baseUrl), reasoningEffort: 'adaptive', connection: { kind: 'openai_compatible', baseUrl, protocol: 'responses' } };
  const models = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: draft });
  assert.equal(models.statusCode, 200, models.body);
  assert.deepEqual(models.json(), { models: [{ id: 'provider-model', reasoningEfforts: ['adaptive'], defaultReasoningEffort: 'adaptive' }] });
  const saved = await app.inject({ method: 'PUT', url: '/api/settings/model', payload: draft });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json<ModelSettings>().reasoningEffort, 'adaptive');
  const read = await app.inject('/api/settings/model');
  assert.equal(read.json<ModelSettings>().reasoningEffort, 'adaptive');
  assert.equal(seen.length, 1, '保存与读取配置不请求模型能力');
  const tested = await app.inject({ method: 'POST', url: '/api/settings/model/test' });
  assert.equal(tested.json().ok, true, tested.body);
  assert.equal(tested.json().effort, 'adaptive');
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.url, '/v1/responses');
  assert.deepEqual(seen[1]!.body.reasoning, { effort: 'adaptive' });
});

test('模型能力区分未报告、未开放选择与全标准档位，必需推理时过滤关闭选项', async t => {
  const { app } = await setup(t);
  const baseUrl = await upstream(t, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [
      { id: 'unknown' },
      { id: 'no-selector', reasoning: { default_effort: 'high', mandatory: true } },
      { id: 'all', reasoning: { supported_efforts: null, default_effort: 'high', default_enabled: false, mandatory: true } },
      { id: 'off', reasoning: { supported_efforts: [], default_effort: 'high', default_enabled: false, mandatory: false } },
      { id: 'required', reasoning: { supported_efforts: ['none', 'low', 'low'], default_effort: 'none', mandatory: true } },
      { id: 'invalid', reasoning: { supported_efforts: 'high', default_effort: 'BAD VALUE', mandatory: 'false' } },
    ] }));
  });
  const result = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: config(baseUrl) });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { models: [
    { id: 'all', reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', reasoningRequired: true },
    { id: 'invalid', reasoningEfforts: [] },
    { id: 'no-selector', reasoningEfforts: [], defaultReasoningEffort: 'high', reasoningRequired: true },
    { id: 'off', reasoningEfforts: [], defaultReasoningEffort: 'none', reasoningRequired: false },
    { id: 'required', reasoningEfforts: ['low'], reasoningRequired: true },
    { id: 'unknown' },
  ] });
});

test('模型列表上游错误只返回状态，拒绝正文中的密钥不会出现在 API 错误里', async t => {
  const { app } = await setup(t); const key = 'synthetic-error-secret-004';
  const baseUrl = await upstream(t, (_request, response) => { response.statusCode = 401; response.end(JSON.stringify({ error: { message: `invalid token ${key}` } })); });
  const response = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: { ...config(baseUrl), apiKey: key } });
  assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'MODEL_LIST_FAILED'); assert.ok(response.json().error.message.includes('401')); assert.ok(!response.body.includes(key));
});

test('模型列表与模型请求统一拒绝远程明文 HTTP、地址凭证、查询参数和片段', async t => {
  const { app } = await setup(t);
  for (const baseUrl of ['http://remote.example/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=value', 'https://example.com/v1#fragment', 'file:///tmp/models']) {
    const response = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: config(baseUrl) });
    assert.equal(response.statusCode, 400, baseUrl); assert.equal(response.json().error.code, 'MODEL_LIST_FAILED');
    assert.ok(response.json().error.message.includes('HTTPS'), response.body);
  }
});

test('草稿只允许复用同地址的既有环境变量引用，拒绝任意环境变量，换地址不携带旧值', async t => {
  const { dir, app } = await setup(t);
  const environmentName = 'PTCG_MODEL_SETTINGS_LEGACY_TEST'; const foreignName = 'PTCG_MODEL_SETTINGS_FOREIGN_TEST';
  const previous = process.env[environmentName]; const foreignPrevious = process.env[foreignName];
  process.env[environmentName] = 'synthetic-legacy-environment-key'; process.env[foreignName] = 'synthetic-foreign-environment-key';
  t.after(() => {
    if (previous === undefined) delete process.env[environmentName]; else process.env[environmentName] = previous;
    if (foreignPrevious === undefined) delete process.env[foreignName]; else process.env[foreignName] = foreignPrevious;
  });
  const headers: (string | undefined)[] = [];
  const baseUrl = await upstream(t, (request, response) => { headers.push(request.headers.authorization); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'legacy-model' }] })); });
  const nextUrl = await upstream(t, (request, response) => { headers.push(request.headers.authorization); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'new-model' }] })); });
  const legacy: ModelConfig = { ...config(baseUrl), connection: { kind: 'openai_compatible', baseUrl, protocol: 'chat_completions', apiKeyEnv: environmentName } };
  await writeFile(join(dir, 'system', 'agent.json'), JSON.stringify(legacy));
  const unchanged = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: legacy });
  assert.equal(unchanged.statusCode, 200, unchanged.body); assert.equal(headers[0], `Bearer ${process.env[environmentName]}`);
  const foreign = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: { ...legacy, connection: { ...legacy.connection, apiKeyEnv: foreignName } } });
  assert.equal(foreign.statusCode, 400); assert.equal(foreign.json().error.code, 'INVALID_MODEL_CONFIG'); assert.equal(headers.length, 1);
  const changed = await app.inject({ method: 'POST', url: '/api/settings/model/models', payload: { ...legacy, connection: { ...legacy.connection, baseUrl: nextUrl } } });
  assert.equal(changed.statusCode, 200, changed.body); assert.equal(headers[1], undefined);
  const saved = await app.inject({ method: 'PUT', url: '/api/settings/model', payload: legacy });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json<ModelSettings>().apiKeyConfigured, true);
});
