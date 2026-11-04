import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { HttpModelGateway, toChatMessages } from '../src/model.ts';
import type { ModelRequest } from '../src/types.ts';

test('DeepSeek Chat 明确关闭思考，并保留工具轮次中的原生思考内容', async t => {
  const bodies: Record<string, any>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    return new Response(JSON.stringify({ id: 'response', model: body.model, choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, reasoning_content: 'native-chat-thought',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'next', arguments: '{}' } }],
    } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const request: ModelRequest = { role: 'player', sessionId: 'chat', instructions: '返回工具', input: [{ role: 'user', content: '执行' }], toolChoice: 'next',
    tools: [{ name: 'next', description: '执行', effect: 'read', inputSchema: Type.Object({}) }] };
  const make = (reasoningEffort: string, baseUrl = 'https://api.deepseek.com') => new HttpModelGateway({ baseUrl, model: 'deepseek-flash', reasoningEffort, protocol: 'chat_completions', fast: false,
    maxRetries: 0, credentials: { async headers() { return {}; } }, trace: { async append() {} } });
  await make('none').generate(request);
  assert.deepEqual(bodies[0]!.thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(bodies[0]!, 'reasoning_effort'), false);
  assert.deepEqual(bodies[0]!.tool_choice, { type: 'function', function: { name: 'next' } });
  const gateway = make('high'), reply = await gateway.generate(request);
  assert.deepEqual(bodies[1]!.thinking, { type: 'enabled' });
  assert.equal(bodies[1]!.reasoning_effort, 'high');
  assert.equal(bodies[1]!.tool_choice, 'auto');
  await gateway.generate({ ...request, input: [...request.input, ...reply.output, { type: 'function_call_output', call_id: 'call-1', output: '完成' }] });
  const assistant = bodies[2]!.messages.find((item: Record<string, unknown>) => item.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'native-chat-thought');
  assert.equal(assistant.tool_calls[0].id, 'call-1');
  await make('none', 'https://example.com').generate(request);
  assert.equal(Object.hasOwn(bodies[3]!, 'thinking'), false);
  assert.equal(bodies[3]!.reasoning_effort, 'none');
});

test('Chat 适配不把其他提供方的思考密文或摘要当作原生思考内容', () => {
  const messages = toChatMessages('sys', [{ type: 'reasoning', encrypted_content: 'opaque-provider-state', summary: [{ text: 'summary' }] },
    { type: 'function_call', call_id: 'call', name: 'next', arguments: '{}' }]);
  assert.equal(JSON.stringify(messages).includes('opaque-provider-state'), false);
  assert.equal(JSON.stringify(messages).includes('summary'), false);
});

test('原生思考和并列工具调用属于同一assistant轮次，连续文字消息都保留', () => {
  const batch = toChatMessages('sys', [
    { type: 'reasoning', format: 'chat-reasoning-v1', reasoning_content: 'native' },
    { type: 'function_call', call_id: 'first', name: 'read_one', arguments: '{"index":1}' },
    { type: 'function_call', call_id: 'second', name: 'read_two', arguments: '{"index":2}' },
    { type: 'function_call_output', call_id: 'first', output: 'one' },
    { type: 'function_call_output', call_id: 'second', output: 'two' },
  ]);
  const assistant = batch.find(item => item.role === 'assistant')!;
  assert.equal(assistant.reasoning_content, 'native');
  assert.deepEqual((assistant.tool_calls as Record<string, unknown>[]).map(call => call.id), ['first', 'second']);
  assert.deepEqual(batch.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['first', 'second']);
  const text = toChatMessages('sys', [
    { type: 'reasoning', format: 'chat-reasoning-v1', reasoning_content: 'native' },
    { role: 'assistant', content: 'first message' },
    { role: 'assistant', content: 'second message' },
  ]);
  assert.deepEqual(text.filter(item => item.role === 'assistant').map(item => item.content), ['first message', 'second message']);
});
