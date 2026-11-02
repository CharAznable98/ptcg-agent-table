import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DirectApiKeyCredentials, EnvironmentCredentials, FileApiKeyCredentials, LocalCodexCredentials, SecretRedactor, validationError } from '../../../packages/agent/src/index.ts';
import type { CredentialSource } from '../../../packages/agent/src/index.ts';
import { ModelConfigSchema, ModelSettingsInputSchema, ReasoningEffortSchema, STANDARD_REASONING_EFFORTS } from '../../../packages/protocol/src/index.ts';
import type { ModelConfig, ModelOption, ModelOptionsResponse, ModelSettings, ModelSettingsInput, ReasoningEffort } from '../../../packages/protocol/src/index.ts';
import { ApiError, atomicJson, clone, readJson, uid } from './storage.ts';

function sameAddress(a: string, b: string): boolean { return a.replace(/\/+$/, '') === b.replace(/\/+$/, ''); }

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && value !== 'default' && !validationError(ReasoningEffortSchema, value) ? value : undefined;
}

/** 能力只来自当前模型的返回值；不根据模型名称补猜档位。 */
function modelReasoning(value: Record<string, unknown>): Omit<ModelOption, 'id'> {
  const metadata = value.reasoning && typeof value.reasoning === 'object' && !Array.isArray(value.reasoning)
    ? value.reasoning as Record<string, unknown> : undefined;
  const required = typeof metadata?.mandatory === 'boolean' ? metadata.mandatory : undefined;
  const levels = metadata ? metadata.supported_efforts : value.reasoningEfforts ?? value.supported_reasoning_levels;
  const reported = metadata !== undefined || levels !== undefined;
  const all = metadata !== undefined && levels === null;
  const candidates = all ? STANDARD_REASONING_EFFORTS : Array.isArray(levels) ? levels : [];
  const efforts = [...new Set(candidates.flatMap(level => {
    const effort = reasoningEffort(typeof level === 'object' && level !== null ? level.effort : level);
    return effort && !(required && effort === 'none') ? [effort] : [];
  }))];
  const advertisedDefault = reasoningEffort(metadata ? metadata.default_effort : value.defaultReasoningEffort ?? value.default_reasoning_level);
  const defaultEffort = metadata?.default_enabled === false && required !== true ? 'none' : advertisedDefault;
  return {
    ...(reported ? { reasoningEfforts: efforts } : {}),
    ...(defaultEffort && !(required && defaultEffort === 'none') ? { defaultReasoningEffort: defaultEffort } : {}),
    ...(required === undefined ? {} : { reasoningRequired: required }),
  };
}

export class ModelSettingsStore {
  readonly dataDir: string;
  readonly systemDir: string;
  constructor(dataDir: string, systemDir: string) { this.dataDir = dataDir; this.systemDir = systemDir; }

  async config(): Promise<ModelConfig> {
    const config = await readJson<ModelConfig>(join(this.systemDir, 'agent.json'))
      ?? await readJson<ModelConfig>(join(this.systemDir, 'agent.example.json'))
      ?? { schemaVersion: 1, model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, connection: { kind: 'local_codex_credentials' } };
    const error = validationError(ModelConfigSchema, config);
    if (error) throw new ApiError('INVALID_MODEL_CONFIG', error);
    return config;
  }

  async settings(value?: ModelConfig): Promise<ModelSettings> {
    const config = value ?? await this.config();
    const connection = config.connection;
    let apiKeyConfigured = false;
    if (connection.kind === 'openai_compatible') {
      if (connection.apiKeyFile) {
        const credential = await readJson<{ apiKey?: string }>(connection.apiKeyFile);
        apiKeyConfigured = Boolean(credential?.apiKey);
      } else if (connection.apiKeyEnv) apiKeyConfigured = Boolean(process.env[connection.apiKeyEnv]);
    }
    return { ...clone(config), apiKeyConfigured };
  }

  async draft(input?: unknown): Promise<{ config: ModelConfig; apiKey?: string }> {
    const saved = await this.config();
    if (input === undefined) return { config: saved };
    const error = validationError(ModelSettingsInputSchema, input);
    if (error) throw new ApiError('INVALID_MODEL_CONFIG', error);
    const { apiKey, ...config } = clone(input as ModelSettingsInput);
    if (config.connection.kind === 'openai_compatible') {
      const previous = saved.connection;
      if (config.connection.apiKeyFile && (previous.kind !== 'openai_compatible' || config.connection.apiKeyFile !== previous.apiKeyFile)) {
        throw new ApiError('INVALID_MODEL_CONFIG', 'API Key 引用无效，请在页面重新填写');
      }
      if (config.connection.apiKeyEnv && (previous.kind !== 'openai_compatible' || config.connection.apiKeyEnv !== previous.apiKeyEnv)) {
        throw new ApiError('INVALID_MODEL_CONFIG', 'API Key 环境变量引用无效，请在页面填写 API Key');
      }
      if (previous.kind === 'openai_compatible') {
        if (sameAddress(previous.baseUrl, config.connection.baseUrl)) {
          if (!config.connection.apiKeyFile && !config.connection.apiKeyEnv) {
            if (previous.apiKeyFile) config.connection.apiKeyFile = previous.apiKeyFile;
            else if (previous.apiKeyEnv) config.connection.apiKeyEnv = previous.apiKeyEnv;
          }
        } else {
          if (config.connection.apiKeyFile === previous.apiKeyFile) delete config.connection.apiKeyFile;
          if (config.connection.apiKeyEnv === previous.apiKeyEnv) delete config.connection.apiKeyEnv;
        }
      }
    } else if (apiKey?.trim()) throw new ApiError('INVALID_MODEL_CONFIG', '本地凭证连接无需填写 API Key');
    return { config, ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}) };
  }

  async save(input: unknown): Promise<ModelSettings> {
    const { config, apiKey } = await this.draft(input);
    if (config.connection.kind === 'openai_compatible' && apiKey) {
      const path = join(this.dataDir, 'model-credentials', `${uid()}.json`);
      await atomicJson(path, { apiKey });
      config.connection.apiKeyFile = path;
      delete config.connection.apiKeyEnv;
    }
    await atomicJson(join(this.systemDir, 'agent.json'), config);
    return this.settings(config);
  }

  credentials(config: ModelConfig, redactor: SecretRedactor, apiKey?: string): CredentialSource {
    if (config.connection.kind === 'local_codex_credentials') return new LocalCodexCredentials(config.connection.authFile, redactor);
    if (apiKey) return new DirectApiKeyCredentials(apiKey, redactor);
    if (config.connection.apiKeyFile) return new FileApiKeyCredentials(config.connection.apiKeyFile, redactor);
    if (config.connection.apiKeyEnv) return new EnvironmentCredentials(config.connection.apiKeyEnv, redactor);
    return { async headers() { return {}; } };
  }

  async models(input?: unknown): Promise<ModelOptionsResponse> {
    const { config, apiKey } = await this.draft(input);
    const local = config.connection.kind === 'local_codex_credentials';
    if (config.connection.kind === 'local_codex_credentials' && !config.connection.baseUrl) {
      const authFile = config.connection.authFile ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
      let cache: { models?: unknown[] } | null = null;
      try { cache = await readJson<{ models?: unknown[] }>(join(dirname(authFile), 'models_cache.json')); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      const models = this.#options(cache?.models);
      if (models.length) return { models };
    }
    const redactor = new SecretRedactor();
    if (apiKey) redactor.add(apiKey);
    try {
      const baseUrl = config.connection.baseUrl ?? 'https://chatgpt.com/backend-api/codex';
      const base = new URL(baseUrl);
      if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) {
        throw new Error('接口须为 HTTPS 或本机 HTTP，且不能夹带凭证或查询参数');
      }
      const url = new URL(baseUrl.replace(/\/+$/, '') + '/models');
      if (local) url.searchParams.set('client_version', '0.1.0');
      const headers = await this.credentials(config, redactor, apiKey).headers();
      const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(Math.min(config.timeoutMs ?? 15_000, 30_000)) });
      if (!response.ok) throw new Error(`读取模型列表失败（HTTP ${response.status}）`);
      const body = await response.json() as { data?: unknown[]; models?: unknown[] };
      const models = this.#options(body.data ?? body.models);
      if (!models.length) throw new Error('接口未返回可选模型');
      return { models };
    } catch (error) {
      throw new ApiError('MODEL_LIST_FAILED', redactor.clean(error instanceof Error ? error.message : '读取模型列表失败'));
    }
  }

  #options(values: unknown): ModelOption[] {
    if (!Array.isArray(values)) return [];
    const options = new Map<string, ModelOption>();
    for (const item of values) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const id = value.id ?? value.slug;
      if (typeof id !== 'string' || !id.trim()) continue;
      options.set(id, { id, ...modelReasoning(value) });
    }
    return [...options.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
