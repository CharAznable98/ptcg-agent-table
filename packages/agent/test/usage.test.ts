import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenUsage, UsageAccumulator } from '../src/usage.ts';

test('Responses和兼容Chat usage统一，缓存与推理不重复加到输入输出', () => {
  const responses = tokenUsage({ input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 } });
  assert.deepEqual(responses, tokenUsage({ prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } }));
  assert.equal(responses.inputTokens, 100); assert.equal(responses.outputTokens, 30);
});
test('缺失usage不是零，明确报告0才是零，无效子集不会生成错误命中率', () => {
  assert.equal(tokenUsage(null).inputTokens, null); assert.equal(tokenUsage({ output_tokens: 0 }).outputTokens, 0);
  const value = tokenUsage({ input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 101 }, output_tokens_details: { reasoning_tokens: 6 } });
  assert.equal(value.cachedInputTokens, null); assert.equal(value.reasoningOutputTokens, null); assert.equal(value.issues.length, 2);
});
test('缓存写入属于输入，普通输入扣除读取和写入，缺失写入字段保持未知', () => {
  const a = new UsageAccumulator();
  a.add({ kind: 'model_finished', callId: 'one', response: { usage: { input_tokens: 100, output_tokens: 3, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 } } } });
  a.add({ kind: 'model_finished', callId: 'two', response: { usage: { input_tokens: 50, output_tokens: 2, input_tokens_details: { cached_tokens: 10 } } } });
  const r = a.report().totals;
  assert.equal(r.inputTokens, 150); assert.equal(r.cachedInputTokens, 50); assert.equal(r.cacheWriteInputTokens, 30);
  assert.equal(r.uncachedInputTokens, 100); assert.equal(r.ordinaryInputTokens, 30);
  assert.equal(r.coverage.cacheWrite.missing, 1); assert.equal(r.coverage.inputAndCacheAndWrite.reported, 1);
  assert.equal(tokenUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 61 } }).cacheWriteInputTokens, null);
  assert.equal(tokenUsage({ input_tokens: 100, input_tokens_details: { cache_write_tokens: 0 } }).cacheWriteInputTokens, 0);
});
test('请求重试分开计数，流式与完成usage去重，失败和缓存缺失显式呈现', () => {
  const a = new UsageAccumulator(); a.add({ kind: 'context_created', sessionId: 's', playerId: 'A' });
  a.add({ kind: 'model_started', callId: 'p', attempt: 0, role: 'player', sessionId: 's' });
  a.add({ kind: 'model_failed', callId: 'p', attempt: 0, role: 'player', sessionId: 's' });
  a.add({ kind: 'model_started', callId: 'p', attempt: 1, role: 'player', sessionId: 's' });
  const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } };
  a.add({ kind: 'model_stream', callId: 'p', attempt: 1, event: { response: { usage } } });
  a.add({ kind: 'model_finished', callId: 'p', attempt: 1, response: { usage } });
  a.add({ kind: 'model_started', callId: 'q', attempt: 0, role: 'summary', sessionId: 'summary:s:page-1' });
  a.add({ kind: 'model_finished', callId: 'q', attempt: 0, response: { usage: { input_tokens: 50, output_tokens: 10 } } });
  const r = a.report(); assert.equal(r.totals.attempts, 3); assert.equal(r.totals.failed, 1);
  assert.equal(r.totals.inputTokens, 150); assert.equal(r.totals.outputTokens, 30);
  assert.equal(r.totals.cachedInputTokens, 40); assert.equal(r.totals.uncachedInputTokens, 60);
  assert.equal(r.totals.cacheTokenHitRate, 0.4); assert.equal(r.totals.cacheRequestHitRate, 1);
  assert.equal(r.totals.coverage.cached.missing, 2); assert.equal(r.totals.cacheAccountedInputTokens, 100);
  assert.equal(r.byPlayer.A!.attempts, 3); assert.equal(r.byRole.summary!.inputTokens, 50);
});
test('失败响应中的已报告usage保留，重复终态不重复计费', () => {
  const a = new UsageAccumulator(); a.add({ kind: 'model_started', callId: 'p', attempt: 0, role: 'compactor' });
  a.add({ kind: 'model_stream', callId: 'p', event: { response: { usage: { input_tokens: 80, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } } });
  a.add({ kind: 'model_failed', callId: 'p', attempt: 0 }); a.add({ kind: 'model_failed', callId: 'p', attempt: 0 });
  const r = a.report(); assert.equal(r.totals.inputTokens, 80); assert.equal(r.totals.outputTokens, 4); assert.equal(r.totals.cacheTokenHitRate, 0); assert.equal(r.issues.length, 1);
});

test('已完成会话独立复盘加载事件保留双方token归属，不伪造创建', () => {
  const usage = new UsageAccumulator();
  usage.add({ kind: 'context_loaded', sessionId: 'restored-A', playerId: 'A' });
  usage.add({ kind: 'model_started', callId: 'replay', attempt: 0, role: 'summary', sessionId: 'summary:restored-A:facts_review' });
  usage.add({ kind: 'model_finished', callId: 'replay', attempt: 0, response: { usage: { input_tokens: 80, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } } });
  assert.equal(usage.report().byPlayer.A!.inputTokens, 80); assert.equal(usage.report().byPlayer.unassigned, undefined);
});
