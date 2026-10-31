import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Ajv } from 'ajv';
import { StrategyPolicySchema } from '../../protocol/src/strategy.ts';
export { StrategyEvidenceSchema, StrategyEntrySchema, StrategyPolicySchema, StrategyPatchSchema } from '../../protocol/src/strategy.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap<TSchema, ReturnType<Ajv['compile']>>();

/** 返回不包含输入值的校验错误，避免把隐藏数据拼到错误字符串中。 */
export function validationError(schema: TSchema, data: unknown): string | null {
  let validator = validators.get(schema);
  if (!validator) {
    validator = ajv.compile(schema);
    validators.set(schema, validator);
  }
  return validator(data) ? null : ajv.errorsText(validator.errors, { dataVar: 'arguments' });
}

export function parseStructured<T>(schema: TSchema, data: unknown): T {
  const error = validationError(schema, data);
  if (error) throw new Error(`STRUCTURED_OUTPUT_INVALID: ${error}`);
  return data as T;
}

const EvidenceRefs = Type.Array(Type.String({ minLength: 1 }), { maxItems: 256 });
export const CompressionSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 12_000 }),
  evidenceRefs: EvidenceRefs,
}, { additionalProperties: false });
export type Compression = Static<typeof CompressionSchema>;

const Identifier = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$' });
const StringRefs = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64, uniqueItems: true });
/** 仅宿主产生 strategy 投影，模型最终输出使用 StrategyPatchSchema。 */
export const StrategyUpdateSchema = Type.Object({
  strategy: Type.String(), changeSummary: Type.String({ minLength: 1, maxLength: 3000 }), evidenceRefs: EvidenceRefs,
  policy: Type.Optional(StrategyPolicySchema),
}, { additionalProperties: false });
export type StrategyUpdate = Static<typeof StrategyUpdateSchema>;

/** 初始化仅生成整体计划，不能伪造对局证据或收益。 */
export const StrategyInitializationSchema = Type.Object({
  plan: Type.String({ minLength: 1, maxLength: 12000 }),
  changeSummary: Type.String({ minLength: 1, maxLength: 3000 }),
}, { additionalProperties: false });
export type StrategyInitialization = Static<typeof StrategyInitializationSchema>;

const FactKind = Type.Union((['event', 'claim', 'inference'] as const).map(value => Type.Literal(value)));
const FactStatus = Type.Union((['supported', 'refuted', 'unresolved'] as const).map(value => Type.Literal(value)));
export const ReviewFactSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 96, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$' }), kind: FactKind, status: FactStatus, statement: Type.String({ minLength: 1, maxLength: 1600 }),
  subjectRefs: StringRefs, conflictKey: Type.String({ minLength: 1, maxLength: 256 }), evidenceRefs: StringRefs,
  publicRefs: StringRefs, relatedEntryIds: StringRefs,
}, { additionalProperties: false });
export type ReviewFact = Static<typeof ReviewFactSchema>;
export const FactExtractionSchema = Type.Object({ facts: Type.Array(ReviewFactSchema, { maxItems: 8 }) }, { additionalProperties: false });
export type FactExtraction = Static<typeof FactExtractionSchema>;
export const FactAssessmentSchema = Type.Object({
  factId: Identifier, status: FactStatus, evidenceRefs: StringRefs, publicRefs: StringRefs,
  explanation: Type.String({ minLength: 1, maxLength: 1600 }),
}, { additionalProperties: false });
export type FactAssessment = Static<typeof FactAssessmentSchema>;
export const FactReviewSchema = Type.Object({ assessments: Type.Array(FactAssessmentSchema, { maxItems: 256 }) }, { additionalProperties: false });
export type FactReview = Static<typeof FactReviewSchema>;

const Restore = Type.Object({ kind: Type.Literal('restore'), targetEventId: Type.String() }, { additionalProperties: false });
const Shuffle = Type.Object({ kind: Type.Literal('shuffle'), zoneId: Type.String(), indices: Type.Array(Type.Integer({ minimum: 0 }), { uniqueItems: true }) }, { additionalProperties: false });
const EndMatch = Type.Object({ kind: Type.Literal('end_match'), result: Type.Union([
  Type.Object({ kind: Type.Literal('abnormal'), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('confirm_reported_result'), reportEventId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]) }, { additionalProperties: false });
/** 这里声明裁判建议的有限处置；能否执行仍由 MatchRuntime 校验与授权。 */
export const JudgeDecisionSchema = Type.Object({
  verdict: Type.Union([Type.Literal('uphold'), Type.Literal('dismiss')]),
  explanation: Type.String({ minLength: 1, maxLength: 4_000 }),
  evidenceRefs: EvidenceRefs,
  ruleRefs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 }),
  steps: Type.Array(Type.Union([Restore, Shuffle, EndMatch]), { maxItems: 16 }),
}, { additionalProperties: false });
export type JudgeDecision = Static<typeof JudgeDecisionSchema>;
