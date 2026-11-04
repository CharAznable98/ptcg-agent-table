import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { HttpModelGateway } from '../src/model.ts';
import type { ModelRequest } from '../src/types.ts';

const request: ModelRequest = {
  role: 'compactor', sessionId: 'compatibility', instructions: '返回工具结果',
  input: [{ role: 'user', content: '只调用 next' }], toolChoice: 'next',
  tools: [{ name: 'next', description: '提交结果', effect: 'read', inputSchema: Type.Object({}, { additionalProperties: false }) }],
};

test('DeepSeek 官方思考模式可完成强制工具任务，其他连接仍保留指定工具', async t => {
  const seen: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); seen.push(body);
    const thinking = body.reasoning?.effort !== 'none';
    if (new URL(url).hostname === 'api.deepseek.com' && thinking && body.tool_choice !== 'auto') {
      return new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Thinking mode does not support this tool_choice' } }), { status: 400 });
    }
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'response', model: body.model, status: 'completed', reasoning: body.reasoning,
      output: [{ type: 'function_call', call_id: 'next-1', name: 'next', arguments: '{}' }],
    } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const cases = [
    ['https://api.deepseek.com', 'deepseek-flash', 'low', 'auto'],
    ['https://api.deepseek.com/v1', 'deepseek-flash', 'high', 'auto'],
    ['https://api.deepseek.com', 'deepseek-flash', 'default', 'auto'],
    ['https://api.deepseek.com', 'deepseek-flash', 'none', { type: 'function', name: 'next' }],
    ['https://example.com/v1', 'gpt-6.1-terra', 'medium', { type: 'function', name: 'next' }],
    ['https://openrouter.ai/api/v1', 'deepseek/deepseek-v4.1-flash-1017', 'low', { type: 'function', name: 'next' }],
  ] as const;
  for (const [baseUrl, model, reasoningEffort, expected] of cases) {
    const gateway = new HttpModelGateway({ baseUrl, model, reasoningEffort, protocol: 'responses',
      credentials: { async headers() { return {}; } }, fast: false, maxRetries: 0, trace: { async append() {} } });
    assert.equal((await gateway.generate(request)).calls[0]?.name, 'next');
    assert.deepEqual(seen.at(-1)?.tool_choice, expected);
  }
});
