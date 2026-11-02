import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectApiKeyCredentials, FileApiKeyCredentials, JsonlTrace, SecretRedactor, atomicJson, createModel } from '../src/index.ts';
import type { ModelRequest } from '../src/types.ts';
import type { ModelConfig, ReasoningEffort } from '../../protocol/src/index.ts';

const request: ModelRequest = { role: 'player', sessionId: 'model-settings', instructions: 'sys', input: [{ role: 'user', content: 'test' }], tools: [] };

test('两种协议发送所选思考强度；接口默认省略参数并接受提供方实际强度', async t => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    bodies.push(body);
    const effort = body.reasoning_effort ?? (body.reasoning as { effort?: string })?.effort ?? 'medium';
    if (req.url === '/chat/completions') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'r', model: 'test', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
    } else {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', model: 'test', status: 'completed', reasoning: { effort }, output: [] } })}\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  for (const protocol of ['responses', 'chat_completions'] as const) {
    for (const reasoningEffort of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] satisfies ReasoningEffort[]) {
      const config: ModelConfig = { schemaVersion: 1, model: 'test', reasoningEffort, fast: false, connection: { kind: 'openai_compatible', protocol, baseUrl: `http://127.0.0.1:${address.port}` } };
      await createModel(config, { async append() {} }).generate(request);
      const body = bodies.at(-1)!;
      if (reasoningEffort === 'default') {
        assert.equal(Object.hasOwn(body, 'reasoning'), false);
        assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
      } else assert.equal(body.reasoning_effort ?? (body.reasoning as { effort?: string })?.effort, reasoningEffort);
    }
  }
});

test('API Key 文件每次读取，草稿密钥与回显不进入调用轨迹', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-model-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'key.json');
  const redactor = new SecretRedactor();
  const credentials = new FileApiKeyCredentials(path, redactor);
  await atomicJson(path, { apiKey: 'first-private-key-12345' });
  assert.equal((await credentials.headers()).Authorization, 'Bearer first-private-key-12345');
  await atomicJson(path, { apiKey: 'second-private-key-67890' });
  assert.equal((await credentials.headers()).Authorization, 'Bearer second-private-key-67890');
  const direct = new DirectApiKeyCredentials('draft-private-key-23456', redactor);
  assert.equal((await direct.headers()).Authorization, 'Bearer draft-private-key-23456');
  const trace = new JsonlTrace(join(directory, 'trace.jsonl'), redactor);
  await trace.append({ apiKey: 'unregistered-secret', echoed: 'first-private-key-12345 second-private-key-67890 draft-private-key-23456' });
  const content = await readFile(trace.path, 'utf8');
  assert.doesNotMatch(content, /private-key|unregistered-secret/);
  const short = new SecretRedactor(); short.add('1'); short.add('"');
  assert.deepEqual(short.clean({ count: 1, text: 'key"1', apiKey: 'x' }), { count: 1, text: 'key[REDACTED][REDACTED]', apiKey: '[REDACTED]' });
});
