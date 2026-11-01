import { Type, type Static } from '@sinclair/typebox';
import type { CardData } from './cards.ts';
import { PlayerIdSchema, PositionSchema } from './commands.ts';
import type { Position } from './commands.ts';

const object = <T extends Record<string, import('@sinclair/typebox').TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 200 });
const index = Type.Integer({ minimum: 0 });

/** 用户通过牌桌手势明确给出的意图；执行代理不得替换或补选游戏决策。 */
export const HumanActionIntentSchema = Type.Union([
  object({ kind: Type.Literal('play'), source: PositionSchema, target: Type.Optional(PositionSchema) }),
  object({ kind: Type.Literal('attach'), source: PositionSchema, target: PositionSchema }),
  object({ kind: Type.Literal('evolve'), source: PositionSchema, target: PositionSchema }),
  object({ kind: Type.Literal('attack'), source: PositionSchema, attackIndex: index, target: PositionSchema }),
  object({ kind: Type.Literal('ability'), source: PositionSchema, abilityIndex: index, target: Type.Optional(PositionSchema) }),
  object({ kind: Type.Literal('retreat'), source: PositionSchema, target: PositionSchema }),
  object({ kind: Type.Literal('draw') }),
  object({ kind: Type.Literal('end_turn') }),
  /** 由服务在进入人类回合时发起；处理强制流程，遇到选择仍交还玩家。 */
  object({ kind: Type.Literal('turn_start') }),
  object({ kind: Type.Literal('resolve_handoff'), source: Type.Optional(PositionSchema), target: Type.Optional(PositionSchema) }),
]);
export type HumanActionIntent = Static<typeof HumanActionIntentSchema>;
export const HumanActionInputSchema = object({ playerId: PlayerIdSchema, requestId: id, revision: index, intent: HumanActionIntentSchema });
export type HumanActionInput = Static<typeof HumanActionInputSchema>;
/** 打开实时人类牌桌时显式激活自动流程；读取对局与回放保持只读。 */
export const HumanTurnActivationSchema = object({ playerId: PlayerIdSchema });
export type HumanTurnActivation = Static<typeof HumanTurnActivationSchema>;

/** 选项由执行端按该席位实际可读信息投影，牌面不得由模型自行填写。 */
export interface HumanChoiceOption { id: string; label: string; position?: Position; card?: CardData }
export interface HumanActionChoice {
  id: string;
  kind: 'select' | 'order' | 'number';
  title: string;
  options: HumanChoiceOption[];
  minimum: number;
  maximum: number;
}
export const HumanChoiceAnswerSchema = object({
  playerId: PlayerIdSchema, requestId: id, revision: index, choiceId: id,
  selected: Type.Array(id, { uniqueItems: true, maxItems: 200 }),
  number: Type.Optional(Type.Integer()),
});
export type HumanChoiceAnswer = Static<typeof HumanChoiceAnswerSchema>;
export const HumanActionControlSchema = object({ playerId: PlayerIdSchema, action: Type.Union([Type.Literal('retry'), Type.Literal('cancel'), Type.Literal('repair'), Type.Literal('manual')]) });
export type HumanActionControl = Static<typeof HumanActionControlSchema>;

/** 修正覆盖原行动及其后续结算；回滚仍追加历史记录。 */
export interface HumanActionRecovery {
  phase: 'reviewing' | 'continuing' | 'rolling_back';
  attempt: number;
  restoredBeforeEventId?: string;
}

/** 一次完整人类行动的公开进度；choice 仅返回给行动所属席位。 */
export interface HumanActionView {
  id: string;
  playerId: 'A' | 'B';
  intent: HumanActionIntent;
  label: string;
  status: 'running' | 'awaiting_choice' | 'completed' | 'failed' | 'cancelled';
  revision: number;
  eventIds: string[];
  choice?: HumanActionChoice;
  error?: string;
  recovery?: HumanActionRecovery;
  /** 尚有已提交效果或结果待确认；完成修正或回滚前禁止发起新行动。 */
  requiresResolution?: boolean;
}

/** 仅供展示聚合，底层命令、历史顺序与恢复点仍逐条保留。 */
export interface ActionReference { id: string; label: string }
