import { readFile } from 'node:fs/promises';
import { Type, type Static } from '@sinclair/typebox';
import { parseStructured } from './schema.ts';
import { EnvironmentCredentials, HttpModelGateway, LocalCodexCredentials } from './model.ts';
import { SecretRedactor } from './storage.ts';
import type { TraceSink } from './types.ts';

/** 系统配置只保存凭证引用，不接受明文 API Key／token 字段。 */
export const ModelConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  model: Type.String({ minLength: 1 }),
  reasoningEffort: Type.Literal('medium'),
  fast: Type.Literal(false),
  cacheKeyStrategy: Type.Optional(Type.Union([Type.Literal('session'), Type.Literal('disabled')])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
  maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
  connection: Type.Union([
    Type.Object({ kind: Type.Literal('local_codex_credentials'), authFile: Type.Optional(Type.String({ minLength: 1 })), baseUrl: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('openai_compatible'), baseUrl: Type.String({ minLength: 1 }), apiKeyEnv: Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), protocol: Type.Union([Type.Literal('responses'), Type.Literal('chat_completions')]) }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export type ModelConfig = Static<typeof ModelConfigSchema>;

export async function loadModelConfig(path: string): Promise<ModelConfig> {
  return parseStructured<ModelConfig>(ModelConfigSchema, JSON.parse(await readFile(path, 'utf8')));
}

export function createModel(config: ModelConfig, trace: TraceSink, redactor = new SecretRedactor()): HttpModelGateway {
  parseStructured<ModelConfig>(ModelConfigSchema, config);
  const credentials = config.connection.kind === 'local_codex_credentials'
    ? new LocalCodexCredentials(config.connection.authFile, redactor)
    : new EnvironmentCredentials(config.connection.apiKeyEnv, redactor);
  const baseUrl = config.connection.baseUrl ?? 'https://chatgpt.com/backend-api/codex';
  return new HttpModelGateway({ baseUrl, credentials, protocol: config.connection.kind === 'local_codex_credentials' ? 'responses' : config.connection.protocol,
    model: config.model, reasoningEffort: config.reasoningEffort, fast: config.fast, trace, redactor,
    cacheKeyStrategy: config.cacheKeyStrategy ?? (config.connection.kind === 'local_codex_credentials' ? 'session' : 'disabled'),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }) });
}
