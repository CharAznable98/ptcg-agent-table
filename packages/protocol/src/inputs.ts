import { Type } from '@sinclair/typebox';
import { DeckSchema } from './cards.ts';
import { StrategyPolicySchema } from './strategy.ts';

const obj = <T extends Record<string, import('@sinclair/typebox').TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const id = Type.String({ minLength: 1 });
const player = obj({
  name: Type.String(), kind: Type.Union([Type.Literal('human'), Type.Literal('ai')]),
  deckId: Type.Optional(id), deck: Type.Optional(DeckSchema), opponentId: Type.Optional(id),
});
export const CreateMatchInputSchema = obj({
  mode: Type.Union([Type.Literal('local'), Type.Literal('human_ai'), Type.Literal('ai_ai')]),
  players: Type.Tuple([player, player]), autoRun: Type.Optional(Type.Boolean()),
});
export const CreateOpponentInputSchema = obj({ name: Type.Optional(Type.String()), deckId: Type.Optional(id), deck: Type.Optional(DeckSchema), strategy: Type.Optional(Type.String()) });
export const UpdateOpponentInputSchema = obj({ name: Type.Optional(Type.String()), deck: Type.Optional(DeckSchema), strategy: Type.Optional(Type.String()) });
const source = Type.Union([
  obj({ kind: Type.Literal('migration'), fromVersion: Type.Integer({ minimum: 1 }) }),
  obj({ kind: Type.Literal('initial') }), obj({ kind: Type.Literal('user_edit') }),
  obj({ kind: Type.Literal('match'), matchId: id, playerId: Type.Union([Type.Literal('A'), Type.Literal('B')]) }),
]);
export const StrategyVersionSchema = obj({
  version: Type.Integer({ minimum: 1 }), content: Type.String(), createdAt: id, source,
  updateId: Type.Optional(id), previousVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  policy: Type.Optional(StrategyPolicySchema), changeSummary: Type.Optional(Type.String()), evidenceRefs: Type.Optional(Type.Array(id)),
});
export const OpponentRecordSchema = obj({
  schemaVersion: Type.Literal(1), id, name: Type.Optional(Type.String()), deck: DeckSchema,
  strategies: Type.Array(StrategyVersionSchema, { minItems: 1 }), origin: Type.Optional(obj({ opponentId: id })),
});
