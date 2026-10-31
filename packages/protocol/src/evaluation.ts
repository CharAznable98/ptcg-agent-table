import { Type } from '@sinclair/typebox';
import type { PlayerId, MatchSummary } from './types.ts';

/** 评估只由使用者发起；A/B 指策略版本，不是牌桌席位。 */
export interface EvaluationPlayer { opponentId: string; version: number }
export interface CreateEvaluationInput { players: [EvaluationPlayer, EvaluationPlayer]; evaluatedPlayer: PlayerId }
export interface CreateComparisonInput { version: number }
export interface EvaluationRun { matchId: string; version: number; match?: MatchSummary }
export interface EvaluationRecord {
  id: string; createdAt: string; evaluatedPlayer: PlayerId;
  players: [EvaluationPlayer, EvaluationPlayer]; baseline: EvaluationRun; comparisons: EvaluationRun[];
}
const player = Type.Object({ opponentId: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const CreateEvaluationInputSchema = Type.Object({
  players: Type.Tuple([player, player]), evaluatedPlayer: Type.Union([Type.Literal('A'), Type.Literal('B')]),
}, { additionalProperties: false });
export const CreateComparisonInputSchema = Type.Object({ version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
