import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ModelGateway, ModelItem, ModelReply, ModelRequest, TraceSink } from './types.ts';
import { SecretRedactor } from './storage.ts';
import { ToolArgumentStream } from './json-stream.ts';
import { tokenUsage } from './usage.ts';
import type { ReasoningEffort } from '../../protocol/src/index.ts';

/** 认证仅供 HTTP 层使用，不传给 agent 或研究记录。 */
export interface CredentialSource {
  headers(): Promise<Record<string, string>>;
}

export class LocalCodexCredentials implements CredentialSource {
  readonly path: string;
  readonly redactor: SecretRedactor;
  constructor(path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), redactor = new SecretRedactor()) {
    this.path = path; this.redactor = redactor;
  }
  async headers(): Promise<Record<string, string>> {
    let auth: { tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string } };
    try { auth = JSON.parse(await readFile(this.path, 'utf8')) as typeof auth; }
    catch { throw new ModelError('AUTH_UNAVAILABLE', '无法读取本地登录凭证', false); }
    const token = auth.tokens?.access_token;
    if (!token) throw new ModelError('AUTH_UNAVAILABLE', '本地文件没有 ChatGPT access token', false);
    for (const value of Object.values(auth.tokens ?? {})) this.redactor.add(value);
    // 仅用未验证的 exp 做过期预检；真实身份与权限始终由服务端认证。
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: number };
      if (payload.exp && payload.exp * 1000 <= Date.now()) throw new ModelError('AUTH_EXPIRED', '本地凭证已过期，请更新凭证后重试', false);
    } catch (error) { if (error instanceof ModelError) throw error; }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (auth.tokens?.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
    return headers;
  }
}

export class EnvironmentCredentials implements CredentialSource {
  readonly variable: string;
  readonly redactor: SecretRedactor;
  constructor(variable: string, redactor = new SecretRedactor()) { this.variable = variable; this.redactor = redactor; }
  async headers(): Promise<Record<string, string>> {
    const token = process.env[this.variable];
    if (!token) throw new ModelError('AUTH_UNAVAILABLE', `缺少环境变量 ${this.variable}`, false);
    this.redactor.add(token);
    return { Authorization: `Bearer ${token}` };
  }
}

/** 设置页草稿只在本次请求内使用。 */
export class DirectApiKeyCredentials implements CredentialSource {
  #token: string;
  readonly redactor: SecretRedactor;
  constructor(token: string, redactor = new SecretRedactor()) {
    this.#token = token; this.redactor = redactor; redactor.add(token);
  }
  async headers(): Promise<Record<string, string>> {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }
}

/** 对局快照保存文件引用；密钥正文仅在发起请求时读取。 */
export class FileApiKeyCredentials implements CredentialSource {
  readonly path: string;
  readonly redactor: SecretRedactor;
  constructor(path: string, redactor = new SecretRedactor()) { this.path = path; this.redactor = redactor; }
  async headers(): Promise<Record<string, string>> {
    let value: { apiKey?: unknown };
    try { value = JSON.parse(await readFile(this.path, 'utf8')) as typeof value; }
    catch { throw new ModelError('AUTH_UNAVAILABLE', '无法读取已保存的 API Key，请在系统配置中重新填写', false); }
    if (typeof value?.apiKey !== 'string' || !value.apiKey.trim()) throw new ModelError('AUTH_UNAVAILABLE', '已保存的 API Key 无效，请重新填写', false);
    return new DirectApiKeyCredentials(value.apiKey, this.redactor).headers();
  }
}

export class ModelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) { super(message); this.code = code; this.retryable = retryable; }
}

export interface HttpModelOptions {
  /** 本地旧版 Codex 凭证与新 ChatGPT 直连授权可能需要不同地址，显式配置。 */
  baseUrl: string;
  credentials: CredentialSource;
  protocol: 'responses' | 'chat_completions';
  model: string;
  reasoningEffort: ReasoningEffort;
  /** 本轮固定关闭 fast；请求明确使用 default，绝不静默改成 priority。 */
  fast: false;
  /** 同一席位和角色复用稳定key；不按调用ID、回合或复盘分页变化。 */
  cacheKeyStrategy?: 'session' | 'disabled';
  timeoutMs?: number;
  maxRetries?: number;
  trace: TraceSink;
  redactor?: SecretRedactor;
}

function functionTools(request: ModelRequest, chat: boolean): unknown[] {
  return request.tools.map(tool => {
    const fn = { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false };
    return chat ? { type: 'function', function: fn } : { type: 'function', ...fn };
  });
}

/** 将项目保存的 Responses 项转为兼容接口消息，不改变席位资料。 */
export function toChatMessages(instructions: string, input: ModelItem[]): ModelItem[] {
  const messages: ModelItem[] = [{ role: 'system', content: instructions }];
  let assistant: ModelItem | null = null;
  for (const item of input) {
    if (item.type === 'reasoning' && item.format === 'chat-reasoning-v1' && typeof item.reasoning_content === 'string') {
      assistant = { role: 'assistant', content: null, reasoning_content: item.reasoning_content };
      messages.push(assistant);
    } else if (item.type === 'function_call') {
      if (!assistant) { assistant = { role: 'assistant', content: null }; messages.push(assistant); }
      const calls = (assistant.tool_calls ??= []) as ModelItem[];
      calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'function_call_output') {
      assistant = null;
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    } else if (typeof item.role === 'string') {
      let content = item.content;
      if (Array.isArray(content)) content = content.map(c => typeof c === 'object' && c && 'text' in c ? String(c.text) : '').join('');
      if (item.role === 'assistant' && assistant && assistant.content === null) assistant.content = content;
      else { assistant = null; messages.push({ role: item.role, content }); }
    }
    // reasoning 密文属于提供方专属恢复项；不能假装是公开文字跨协议传递。
  }
  return messages;
}

function wireBody(options: HttpModelOptions, request: ModelRequest): Record<string, unknown> {
  const chat = options.protocol === 'chat_completions';
  const deepseekChat = chat && new URL(options.baseUrl).hostname === 'api.deepseek.com';
  // 官方 DeepSeek 开启思考后拒绝指定函数；调用结果仍由运行器检查数量和权限。
  const canForceTool = new URL(options.baseUrl).hostname !== 'api.deepseek.com' || options.reasoningEffort === 'none';
  const choice = request.toolChoice && canForceTool
    ? chat ? { type: 'function', function: { name: request.toolChoice } } : { type: 'function', name: request.toolChoice }
    : 'auto';
  const session = request.role === 'summary' && request.sessionId.startsWith('summary:') ? request.sessionId.split(':').slice(0, 2).join(':') : request.sessionId;
  const cache = options.cacheKeyStrategy === 'session' ? { prompt_cache_key: 'ptcg:' + createHash('sha256').update(JSON.stringify([request.role, session])).digest('hex').slice(0, 48) } : {};
  const common = { model: options.model, tools: functionTools(request, chat), tool_choice: choice, parallel_tool_calls: false, service_tier: 'default', ...cache };
  const effort = deepseekChat && options.reasoningEffort === 'none' ? { thinking: { type: 'disabled' } }
    : options.reasoningEffort === 'default' ? {} : chat
    ? { reasoning_effort: options.reasoningEffort }
    : { reasoning: { effort: options.reasoningEffort } };
  return chat
    ? { ...common, messages: toChatMessages(request.instructions, request.input), ...(deepseekChat && options.reasoningEffort !== 'none' && options.reasoningEffort !== 'default' ? { thinking: { type: 'enabled' } } : {}), ...effort, stream: false }
    : { ...common, instructions: request.instructions, input: request.input, ...effort, stream: true, store: false };
}

/** 逐段处理 SSE：支持 CRLF、多行 data 及任意网络分片；必须收到 completed。 */
export async function consumeResponses(response: Response, onEvent: (event: ModelItem) => Promise<void>): Promise<ModelItem> {
  if (!response.body) throw new ModelError('STREAM_EMPTY', '模型没有返回流', true);
  let pending = '';
  let completed: ModelItem | null = null;
  const decoder = new TextDecoder();
  const arguments_ = new Map<string, ToolArgumentStream>();
  const eventBlock = async (block: string): Promise<void> => {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event: ModelItem;
    try { event = JSON.parse(data) as ModelItem; } catch { throw new ModelError('STREAM_INVALID', '模型流包含无效 JSON', false); }
    await onEvent(event);
    if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      const key = String(event.item_id ?? event.output_index ?? 'tool');
      const prefix = arguments_.get(key) ?? new ToolArgumentStream(); arguments_.set(key, prefix);
      try { prefix.push(event.delta); } catch (error) {
        const repetitive = error instanceof Error && error.message === 'REPETITIVE_JSON_STREAM';
        throw new ModelError(repetitive ? 'REPETITIVE_TOOL_ARGUMENT_STREAM' : 'INVALID_TOOL_ARGUMENT_STREAM', repetitive ? '工具参数流出现极端周期重复' : '工具参数流已不可能组成合法JSON', true);
      }
    }
    if (event.type === 'response.completed') completed = event.response as ModelItem;
    if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
      const inner = (event.response as ModelItem | undefined)?.error as ModelItem | undefined;
      const code = String(inner?.code ?? (event.error as ModelItem | undefined)?.code ?? event.code ?? event.type);
      throw new ModelError(code, `模型流未成功完成：${code}`, /rate_limit|server|overload/.test(code));
    }
  };
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    pending = pending.replaceAll('\r\n', '\n');
    let index: number;
    while ((index = pending.indexOf('\n\n')) >= 0) { const block = pending.slice(0, index); pending = pending.slice(index + 2); await eventBlock(block); }
    if (pending.length > 8_000_000) throw new ModelError('STREAM_TOO_LARGE', '模型流单事件超过上限', false);
  }
  pending += decoder.decode();
  if (pending.trim()) await eventBlock(pending);
  if (!completed) throw new ModelError('STREAM_INTERRUPTED', '模型流未收到 response.completed', true);
  return completed;
}

function normalizeReply(raw: ModelItem, chat: boolean): ModelReply {
  if (chat) {
    const choices = raw.choices as { finish_reason?: string; message?: { content?: string; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] | undefined;
    const choice = choices?.[0];
    if (!choice?.message || !['tool_calls', 'stop'].includes(choice.finish_reason ?? '')) throw new ModelError('INFERENCE_INCOMPLETE', '兼容接口没有完整完成推理', false);
    const calls = (choice.message.tool_calls ?? []).map(c => ({ callId: c.id, name: c.function.name, arguments: c.function.arguments }));
    const output: ModelItem[] = calls.map(c => ({ type: 'function_call', call_id: c.callId, name: c.name, arguments: c.arguments }));
    if (choice.message.reasoning_content) output.unshift({ type: 'reasoning', format: 'chat-reasoning-v1', reasoning_content: choice.message.reasoning_content });
    if (choice.message.content) output.push({ role: 'assistant', content: choice.message.content });
    return { id: String(raw.id), model: String(raw.model), output, calls, usage: raw.usage as Record<string, unknown> ?? null };
  }
  const output = raw.output as ModelItem[];
  if (!Array.isArray(output) || raw.status !== 'completed') throw new ModelError('INFERENCE_INCOMPLETE', '模型没有返回已完成结果', false);
  const calls = output.filter(i => i.type === 'function_call').map(i => ({ callId: String(i.call_id), name: String(i.name), arguments: String(i.arguments) }));
  return { id: String(raw.id), model: String(raw.model), output, calls, usage: raw.usage as Record<string, unknown> ?? null };
}

/** 两种认证、两种 HTTP 协议共享一次推理接口；项目自己管理 agent loop。 */
export class HttpModelGateway implements ModelGateway {
  readonly options: HttpModelOptions;
  readonly redactor: SecretRedactor;
  constructor(options: HttpModelOptions) {
    const url = new URL(options.baseUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
      throw new Error('MODEL_URL_INVALID: 接口须为 HTTPS 或本机 HTTP，且不能夹带凭证／查询参数');
    }
    if (options.fast !== false) throw new Error('FAST_DISABLED: 本轮必须使用非 fast 服务');
    this.options = options;
    this.redactor = options.redactor ?? new SecretRedactor();
  }
  async #record(event: Record<string, unknown>): Promise<void> {
    await this.options.trace.append(this.redactor.clean(event));
  }
  async generate(request: ModelRequest): Promise<ModelReply> {
    const body = wireBody(this.options, request);
    const endpoint = this.options.baseUrl.replace(/\/$/, '') + (this.options.protocol === 'responses' ? '/responses' : '/chat/completions');
    const callId = randomUUID();
    for (let attempt = 0; attempt <= (this.options.maxRetries ?? 2); attempt++) {
      const started = Date.now();
      await this.#record({ kind: 'model_started', callId, attempt, role: request.role, sessionId: request.sessionId, endpoint, request: body, requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
      try {
        // 每次重新读取，允许外部凭证管理者更新；不旋转或覆盖他人的 refresh token。
        const auth = await this.options.credentials.headers();
        for (const value of Object.values(auth)) this.redactor.add(value.replace(/^Bearer /, ''));
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 120_000);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ptcg-agent/0.1', ...auth }, body: JSON.stringify(body), signal });
        if (!response.ok) {
          const raw = await response.text();
          let code = `HTTP_${response.status}`;
          try { const parsed = JSON.parse(raw) as { error?: { code?: string } }; code = parsed.error?.code ?? code; } catch {}
          throw new ModelError(code, `模型请求失败（HTTP ${response.status}）`, response.status === 429 || response.status >= 500 || (response.status === 401 && attempt === 0));
        }
        const raw = this.options.protocol === 'responses'
          ? await consumeResponses(response, event => this.#record({ kind: 'model_stream', callId, attempt, event }))
          : await response.json() as ModelItem;
        const reply = normalizeReply(raw, this.options.protocol === 'chat_completions');
        if (reply.model !== this.options.model) throw new ModelError('MODEL_MISMATCH', '服务端返回的模型与请求不一致', false);
        if (this.options.protocol === 'responses') {
          const reasoning = raw.reasoning as ModelItem | undefined;
          if (this.options.reasoningEffort !== 'default' && reasoning?.effort && reasoning.effort !== this.options.reasoningEffort) throw new ModelError('EFFORT_MISMATCH', '服务端未使用指定思考强度', false);
          if (raw.service_tier && raw.service_tier !== 'default') throw new ModelError('SERVICE_TIER_MISMATCH', '服务端未使用非 fast 的 default 服务', false);
        }
        await this.#record({ kind: 'model_finished', callId, attempt, role: request.role, sessionId: request.sessionId, elapsedMs: Date.now() - started, tokenUsage: tokenUsage(raw.usage), response: raw });
        return reply;
      } catch (error) {
        const failure = error instanceof ModelError ? error : new ModelError('TRANSPORT_ERROR', '模型连接中断或超时', !request.signal?.aborted);
        await this.#record({ kind: 'model_failed', callId, attempt, role: request.role, sessionId: request.sessionId, code: failure.code, message: failure.message, elapsedMs: Date.now() - started });
        if (!failure.retryable || attempt >= (this.options.maxRetries ?? 2) || request.signal?.aborted) throw failure;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 4000)));
      }
    }
    throw new Error('UNREACHABLE');
  }
}
