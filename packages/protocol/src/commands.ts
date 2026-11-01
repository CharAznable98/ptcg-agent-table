import { Type, type Static } from '@sinclair/typebox';
import { VisibilitySchema } from './cards.ts';

const obj = <T extends Record<string, import('@sinclair/typebox').TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const Id = Type.String({ minLength: 1 });
const N = Type.Integer({ minimum: 0 });
export const PlayerIdSchema = Type.Union([Type.Literal('A'), Type.Literal('B')]);
export const PositionSchema = obj({ zoneId: Id, index: N, member: Type.Optional(obj({ relation: Type.Union([Type.Literal('stack'), Type.Literal('attached')]), index: N })) });
export const ContainerSchema = Type.Union([
  obj({ kind: Type.Literal('zone'), zoneId: Id }),
  obj({ kind: Type.Literal('group'), position: obj({ zoneId: Id, index: N }), relation: Type.Union([Type.Literal('stack'), Type.Literal('attached')]) }),
]);
export const RangeSchema = Type.Union([obj({ mode: Type.Literal('all') }), obj({ mode: Type.Literal('range'), start: N, count: N }), obj({ mode: Type.Literal('indices'), indices: Type.Array(N, { uniqueItems: true }) })]);
export const SelectionSchema = obj({ container: ContainerSchema, range: RangeSchema });
export const DestinationSchema = obj({ container: ContainerSchema, index: N });
/** 末尾位置由执行端在移出来源后计算，避免客户端重复计数。 */
export const MoveDestinationSchema = obj({ container: ContainerSchema, index: Type.Union([N, Type.Literal('end')]) });
export const ConditionsSchema = Type.Array(Type.Union(['poisoned', 'burned', 'asleep', 'paralyzed', 'confused'].map(v => Type.Literal(v))), { uniqueItems: true });
export const MarkerValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
export const StateTargetSchema = Type.Union([obj({ kind: Type.Literal('card'), position: PositionSchema }), obj({ kind: Type.Literal('group'), position: obj({ zoneId: Id, index: N }) }), obj({ kind: Type.Literal('player'), playerId: PlayerIdSchema }), obj({ kind: Type.Literal('zone'), zoneId: Id })]);
export const StateFieldSchema = Type.Union([
  obj({ key: Type.Literal('damageCounters'), value: N }),
  obj({ key: Type.Literal('specialConditions'), value: ConditionsSchema }),
  obj({ key: Type.Literal('visibility'), value: Type.Union([VisibilitySchema, Type.Null()]) }),
  obj({ key: Type.Literal('marker'), name: Id, value: Type.Union([MarkerValueSchema, Type.Null()]) }),
]);
export const ResultSchema = Type.Union([
  obj({ kind: Type.Literal('win'), winner: PlayerIdSchema, reason: Type.String({ minLength: 1 }) }),
  obj({ kind: Type.Literal('draw'), reason: Type.String({ minLength: 1 }) }),
  obj({ kind: Type.Literal('abnormal'), reason: Type.String({ minLength: 1 }) }),
]);
export const ProposalSchema = obj({ restoreBeforeEventId: Type.Optional(Id), shuffles: Type.Array(SelectionSchema) });
export const GameCommandSchema = Type.Union([
  obj({ kind: Type.Literal('move'), source: SelectionSchema, destination: MoveDestinationSchema }),
  obj({ kind: Type.Literal('shuffle'), selection: SelectionSchema }),
  obj({ kind: Type.Literal('set_state'), target: StateTargetSchema, field: StateFieldSchema }),
  obj({ kind: Type.Literal('look'), selection: SelectionSchema }),
  obj({ kind: Type.Literal('show'), selection: SelectionSchema }),
  obj({ kind: Type.Literal('random'), mode: Type.Union([Type.Literal('coins'), Type.Literal('until_tails'), Type.Literal('selection')]), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), selection: Type.Optional(SelectionSchema) }),
  obj({ kind: Type.Literal('create_group'), destination: DestinationSchema }),
  obj({ kind: Type.Literal('remove_group'), position: PositionSchema }),
  obj({ kind: Type.Literal('declare'), text: Type.String({ minLength: 1, maxLength: 10_000 }) }),
  Type.Object({ kind: Type.Literal('set_turn'), phase: Type.Union([Type.Literal('turn'), Type.Literal('check')]), playerId: Type.Union([PlayerIdSchema, Type.Null()]) }, {
    additionalProperties: false,
    anyOf: [
      Type.Object({ phase: Type.Literal('turn'), playerId: PlayerIdSchema }),
      Type.Object({ phase: Type.Literal('check'), playerId: Type.Null() }),
    ],
  }),
  obj({ kind: Type.Literal('handoff'), to: PlayerIdSchema, reason: Type.String({ minLength: 1 }), returning: Type.Optional(Type.Boolean()) }),
  obj({ kind: Type.Literal('report_result'), result: ResultSchema }),
  obj({ kind: Type.Literal('confirm_result'), agree: Type.Literal(true) }),
  obj({ kind: Type.Literal('concede') }),
  obj({ kind: Type.Literal('choose_first'), firstPlayer: PlayerIdSchema }),
  obj({ kind: Type.Literal('initial_placement'), active: PositionSchema, bench: Type.Array(PositionSchema), benchSlots: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 4 }), { uniqueItems: true, maxItems: 5 })) }),
  obj({ kind: Type.Literal('mulligan_draw'), count: N }),
  obj({ kind: Type.Literal('additional_bench'), bench: Type.Array(PositionSchema), benchSlots: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 4 }), { uniqueItems: true, maxItems: 5 })) }),
  obj({ kind: Type.Literal('object'), targetEventId: Id, reason: Type.String({ minLength: 1 }), evidenceRefs: Type.Array(Id), proposal: Type.Optional(ProposalSchema) }),
  obj({ kind: Type.Literal('respond'), response: Type.Union([obj({ kind: Type.Literal('accept'), disputeId: Id, proposalId: Id }), obj({ kind: Type.Literal('defend'), disputeId: Id, reason: Type.String({ minLength: 1 }), evidenceRefs: Type.Array(Id) })]) }),
]);
export const CommandEnvelopeSchema = obj({ requestId: Id, revision: N, command: GameCommandSchema });
export type PlayerId = Static<typeof PlayerIdSchema>;
export type Position = Static<typeof PositionSchema>;
export type Container = Static<typeof ContainerSchema>;
export type Selection = Static<typeof SelectionSchema>;
export type Destination = Static<typeof DestinationSchema>;
export type MoveDestination = Static<typeof MoveDestinationSchema>;
export type GameCommand = Static<typeof GameCommandSchema>;
export type CommandEnvelope = Static<typeof CommandEnvelopeSchema>;
export type GameResult = Static<typeof ResultSchema>;
export type Proposal = Static<typeof ProposalSchema>;
