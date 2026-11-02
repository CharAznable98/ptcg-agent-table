import { Type, type Static } from '@sinclair/typebox';

/** 档位来自模型能力；default 是本项目保留的“不发送参数”。 */
export const ReasoningEffortSchema = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_-]*(?![\\s\\S])' });
export type ReasoningEffort = Static<typeof ReasoningEffortSchema>;
/** 仅用于接口明确声明支持全部标准档位的情况，不是模型能力兜底。 */
export const STANDARD_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 持久配置只保留凭证引用，密钥通过设置接口单独提交。 */
export const ModelConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  model: Type.String({ minLength: 1 }),
  reasoningEffort: ReasoningEffortSchema,
  fast: Type.Literal(false),
  cacheKeyStrategy: Type.Optional(Type.Union([Type.Literal('session'), Type.Literal('disabled')])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
  maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
  connection: Type.Union([
    Type.Object({ kind: Type.Literal('local_codex_credentials'), authFile: Type.Optional(Type.String({ minLength: 1 })), baseUrl: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('openai_compatible'), baseUrl: Type.String({ minLength: 1 }),
      apiKeyEnv: Type.Optional(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' })),
      apiKeyFile: Type.Optional(Type.String({ minLength: 1 })),
      protocol: Type.Union([Type.Literal('responses'), Type.Literal('chat_completions')]),
    }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export type ModelConfig = Static<typeof ModelConfigSchema>;

export const ModelSettingsInputSchema = Type.Object({
  ...ModelConfigSchema.properties,
  apiKey: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type ModelSettingsInput = Static<typeof ModelSettingsInputSchema>;
export type ModelSettings = ModelConfig & { apiKeyConfigured: boolean };
export interface ModelOption {
  id: string;
  /** undefined：未报告；[]：未开放档位选择。 */
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  reasoningRequired?: boolean;
}
export interface ModelOptionsResponse { models: ModelOption[] }
export interface ModelTestResult {
  ok: boolean;
  model?: string;
  effort?: ReasoningEffort;
  serviceTier?: string;
  elapsedMs: number;
  error?: string;
}
