import { Type } from '@sinclair/typebox';

/** 条件策略与单局事实分开保存；正文是这些条目的阅读投影。 */
export interface StrategyEvidence {
  matchId: string;
  eventIds: string[];
  factIds: string[];
  direction: 'support' | 'counter';
}

export interface StrategyEntry {
  id: string;
  revision: number;
  status: 'candidate' | 'active' | 'suspended' | 'retired';
  when: string;
  prefer: string;
  because: string;
  unless: string[];
  benefit: 'untested' | 'observational' | 'evaluated';
  evidence: StrategyEvidence[];
}

export interface StrategyPolicy {
  schemaVersion: 1;
  scope: { deckHash: string; rulesHash: string };
  /** 完整长期计划，由 AI 自主组织；旧版本可缺省，初始化后必须提供。 */
  plan?: string;
  entries: StrategyEntry[];
}

export type StrategyChange =
  | { kind: 'add'; entry: StrategyEntry }
  | { kind: 'revise'; id: string; expectedRevision: number; entry: StrategyEntry }
  | { kind: 'suspend' | 'retire'; id: string; expectedRevision: number; reason: string; factIds: string[] };

export interface StrategyPatch {
  baseVersion: number;
  plan?: string;
  changes: StrategyChange[];
  changeSummary: string;
}

const Identifier = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$' });
const StringRefs = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64, uniqueItems: true });
const Status = Type.Union((['candidate', 'active', 'suspended', 'retired'] as const).map(value => Type.Literal(value)));
const Benefit = Type.Union((['untested', 'observational', 'evaluated'] as const).map(value => Type.Literal(value)));
export const StrategyEvidenceSchema = Type.Object({
  matchId: Type.String({ minLength: 1, maxLength: 256 }), eventIds: StringRefs, factIds: StringRefs,
  direction: Type.Union([Type.Literal('support'), Type.Literal('counter')]),
}, { additionalProperties: false });
export const StrategyEntrySchema = Type.Object({
  id: Identifier, revision: Type.Integer({ minimum: 1 }), status: Status,
  when: Type.String({ minLength: 1, maxLength: 1200 }), prefer: Type.String({ minLength: 1, maxLength: 1200 }),
  because: Type.String({ minLength: 1, maxLength: 1600 }), unless: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), { maxItems: 12 }),
  benefit: Benefit, evidence: Type.Array(StrategyEvidenceSchema, { maxItems: 256 }),
}, { additionalProperties: false });
export const StrategyPolicySchema = Type.Object({
  schemaVersion: Type.Literal(1), scope: Type.Object({ deckHash: Type.String({ minLength: 1, maxLength: 256 }), rulesHash: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
  plan: Type.Optional(Type.String({ minLength: 1, maxLength: 12000 })), entries: Type.Array(StrategyEntrySchema),
}, { additionalProperties: false });
export const StrategyPatchSchema = Type.Object({
  baseVersion: Type.Integer({ minimum: 1 }), plan: Type.Optional(Type.String({ minLength: 1, maxLength: 12000 })), changes: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal('add'), entry: StrategyEntrySchema }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('revise'), id: Identifier, expectedRevision: Type.Integer({ minimum: 1 }), entry: StrategyEntrySchema }, { additionalProperties: false }),
    Type.Object({ kind: Type.Union([Type.Literal('suspend'), Type.Literal('retire')]), id: Identifier, expectedRevision: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1, maxLength: 1600 }), factIds: StringRefs }, { additionalProperties: false }),
  ]), { maxItems: 16 }), changeSummary: Type.String({ minLength: 1, maxLength: 3000 }),
}, { additionalProperties: false });
