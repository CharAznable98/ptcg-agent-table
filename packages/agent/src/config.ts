import { readFile } from 'node:fs/promises';
import { parseStructured } from './schema.ts';
import { EnvironmentCredentials, FileApiKeyCredentials, HttpModelGateway, LocalCodexCredentials, type CredentialSource } from './model.ts';
import { SecretRedactor } from './storage.ts';
import type { TraceSink } from './types.ts';
import { ModelConfigSchema, type ModelConfig } from '../../protocol/src/index.ts';
export { ModelConfigSchema, type ModelConfig } from '../../protocol/src/index.ts';

export async function loadModelConfig(path: string): Promise<ModelConfig> {
  return parseStructured<ModelConfig>(ModelConfigSchema, JSON.parse(await readFile(path, 'utf8')));
}

export function createModel(config: ModelConfig, trace: TraceSink, redactor = new SecretRedactor(), credentialsOverride?: CredentialSource): HttpModelGateway {
  parseStructured<ModelConfig>(ModelConfigSchema, config);
  const credentials = credentialsOverride ?? (config.connection.kind === 'local_codex_credentials'
    ? new LocalCodexCredentials(config.connection.authFile, redactor)
    : config.connection.apiKeyFile ? new FileApiKeyCredentials(config.connection.apiKeyFile, redactor)
    : config.connection.apiKeyEnv ? new EnvironmentCredentials(config.connection.apiKeyEnv, redactor)
    : { async headers() { return {}; } });
  const baseUrl = config.connection.baseUrl ?? 'https://chatgpt.com/backend-api/codex';
  return new HttpModelGateway({ baseUrl, credentials, protocol: config.connection.kind === 'local_codex_credentials' ? 'responses' : config.connection.protocol,
    model: config.model, reasoningEffort: config.reasoningEffort, fast: config.fast, trace, redactor,
    cacheKeyStrategy: config.cacheKeyStrategy ?? (config.connection.kind === 'local_codex_credentials' ? 'session' : 'disabled'),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }) });
}
