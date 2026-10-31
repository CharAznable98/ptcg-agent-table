import type { ModelItem } from './types.ts';

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningOutputTokens: number | null;
  issues: string[];
}
const object = (value: unknown): ModelItem => value && typeof value === 'object' && !Array.isArray(value) ? value as ModelItem : {};

/** 只统计提供方实际报告的字段；缓存是输入子集，推理是输出子集。 */
export function tokenUsage(raw: unknown): TokenUsage {
  const usage = object(raw), issues: string[] = [];
  const number = (value: unknown, field: string): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { issues.push('INVALID_' + field); return null; }
    return value;
  };
  const inputTokens = number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens, 'INPUT');
  const outputTokens = number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens, 'OUTPUT');
  let cachedInputTokens = number(object(usage.input_tokens_details ?? usage.prompt_tokens_details).cached_tokens ?? usage.cachedInputTokens, 'CACHED_INPUT');
  let cacheWriteInputTokens = number(object(usage.input_tokens_details ?? usage.prompt_tokens_details).cache_write_tokens ?? usage.cacheWriteInputTokens, 'CACHE_WRITE_INPUT');
  let reasoningOutputTokens = number(object(usage.output_tokens_details ?? usage.completion_tokens_details).reasoning_tokens ?? usage.reasoningOutputTokens, 'REASONING_OUTPUT');
  if (cachedInputTokens !== null && inputTokens !== null && cachedInputTokens > inputTokens) { issues.push('CACHED_EXCEEDS_INPUT'); cachedInputTokens = null; }
  if (cacheWriteInputTokens !== null && inputTokens !== null && cacheWriteInputTokens + (cachedInputTokens ?? 0) > inputTokens) { issues.push('CACHE_WRITE_EXCEEDS_REMAINING_INPUT'); cacheWriteInputTokens = null; }
  if (reasoningOutputTokens !== null && outputTokens !== null && reasoningOutputTokens > outputTokens) { issues.push('REASONING_EXCEEDS_OUTPUT'); reasoningOutputTokens = null; }
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens, issues };
}

export interface UsageAttempt {
  callId: string;
  attempt: number;
  role: string;
  player: string | null;
  status: 'pending' | 'completed' | 'failed';
  usage: TokenUsage;
}

export function usageTotals(attempts: UsageAttempt[]) {
  const sum = (key: keyof Omit<TokenUsage, 'issues'>) => {
    const values = attempts.flatMap(a => a.usage[key] === null ? [] : [a.usage[key]!]);
    return { value: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length, missing: attempts.length - values.length };
  };
  const input = sum('inputTokens'), output = sum('outputTokens'), cached = sum('cachedInputTokens'), cacheWrite = sum('cacheWriteInputTokens'), reasoning = sum('reasoningOutputTokens');
  const cacheKnown = attempts.filter(a => a.usage.cachedInputTokens !== null);
  const pairs = cacheKnown.filter(a => a.usage.inputTokens !== null);
  const accountedInput = pairs.reduce((n, a) => n + a.usage.inputTokens!, 0);
  const accountedCache = pairs.reduce((n, a) => n + a.usage.cachedInputTokens!, 0);
  const cacheHitRequests = cacheKnown.filter(a => a.usage.cachedInputTokens! > 0).length;
  const triples = pairs.filter(a => a.usage.cacheWriteInputTokens !== null);
  return {
    attempts: attempts.length, completed: attempts.filter(a => a.status === 'completed').length, failed: attempts.filter(a => a.status === 'failed').length, pending: attempts.filter(a => a.status === 'pending').length,
    inputTokens: input.value, outputTokens: output.value, cachedInputTokens: cached.value,
    cacheWriteInputTokens: cacheWrite.value,
    ordinaryInputTokens: triples.length ? triples.reduce((n, a) => n + a.usage.inputTokens! - a.usage.cachedInputTokens! - a.usage.cacheWriteInputTokens!, 0) : null,
    uncachedInputTokens: pairs.length ? accountedInput - accountedCache : null,
    reasoningOutputTokens: reasoning.value,
    cacheTokenHitRate: accountedInput ? accountedCache / accountedInput : null,
    cacheAccountedInputTokens: pairs.length ? accountedInput : null,
    cacheHitRequests, cacheUsageRequests: cacheKnown.length,
    cacheRequestHitRate: cacheKnown.length ? cacheHitRequests / cacheKnown.length : null,
    coverage: { input, output, cached, cacheWrite, reasoning, inputAndCache: { reported: pairs.length, missing: attempts.length - pairs.length }, inputAndCacheAndWrite: { reported: triples.length, missing: attempts.length - triples.length } },
  };
}

/** 流式统计轨迹，HTTP重试按真实attempt分开；同一attempt的流usage与完成usage只计一次。 */
export class UsageAccumulator {
  #seats = new Map<string, string>();
  #attempts = new Map<string, UsageAttempt>();
  #issues: string[] = [];
  add(event: ModelItem): void {
    if (event.kind === 'context_created' || event.kind === 'context_loaded') { this.#seats.set(String(event.sessionId), String(event.playerId)); return; }
    if (!['model_started', 'model_stream', 'model_finished', 'model_failed'].includes(String(event.kind)) || typeof event.callId !== 'string') return;
    const key = event.callId + ':' + String(event.attempt ?? 0);
    let entry = this.#attempts.get(key);
    if (!entry) {
      const id = String(event.sessionId ?? ''), base = id.startsWith('summary:') ? id.slice(8).split(':')[0]! : id;
      entry = { callId: event.callId, attempt: Number(event.attempt ?? 0), role: String(event.role ?? 'unknown'), player: this.#seats.get(base) ?? null, status: 'pending', usage: tokenUsage(null) };
      this.#attempts.set(key, entry);
    }
    if (event.kind === 'model_stream') {
      const stream = object(event.event), reported = object(stream.response).usage;
      if (reported) entry.usage = tokenUsage(reported);
      return;
    }
    if (event.kind === 'model_started') { entry.role = String(event.role ?? entry.role); return; }
    if (entry.status !== 'pending') { this.#issues.push('DUPLICATE_TERMINAL:' + key); return; }
    const raw = object(event.response).usage ?? event.tokenUsage;
    if (raw) entry.usage = tokenUsage(raw);
    entry.status = event.kind === 'model_finished' ? 'completed' : 'failed';
    if (entry.role === 'unknown') entry.role = String(event.role ?? 'unknown');
  }
  report() {
    const attempts = [...this.#attempts.values()];
    const group = (key: 'role' | 'player') => Object.fromEntries([...new Set(attempts.map(a => a[key] ?? 'unassigned'))].map(value => [value, usageTotals(attempts.filter(a => (a[key] ?? 'unassigned') === value))]));
    return { totals: usageTotals(attempts), byRole: group('role'), byPlayer: group('player'), attempts, issues: [...this.#issues, ...attempts.flatMap(a => a.usage.issues.map(issue => a.callId + ':' + a.attempt + ':' + issue))] };
  }
}
