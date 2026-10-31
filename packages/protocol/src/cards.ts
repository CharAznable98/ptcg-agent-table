import { Type, type Static } from '@sinclair/typebox';

const object = <T extends Record<string, import('@sinclair/typebox').TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const Text = Type.String();
const positive = Type.Integer({ minimum: 1 });
const nonnegative = Type.Integer({ minimum: 0 });
const common = {
  name: Type.String({ minLength: 1 }),
  imageUrl: Type.Optional(Type.String({ pattern: '^https?://' })),
  tags: Type.Optional(Type.Array(Text)),
  rulesText: Type.Optional(Text),
};
export const EnergyCostSchema = object({ type: Type.String({ minLength: 1 }), count: positive });
export const AttackSchema = object({ name: Text, energyCost: Type.Array(EnergyCostSchema), damageText: Text, text: Text, tags: Type.Optional(Type.Array(Text)) });
const Modifier = object({ type: Text, modifier: Text });
export const CardSchema = Type.Union([
  object({ ...common, kind: Type.Literal('pokemon'), hp: positive, types: Type.Array(Text), stage: Text, evolvesFrom: Type.Optional(Text), abilities: Type.Array(object({ name: Text, text: Text, tags: Type.Optional(Type.Array(Text)) })), attacks: Type.Array(AttackSchema), weaknesses: Type.Array(Modifier), resistances: Type.Array(Modifier), retreatCost: nonnegative }),
  object({ ...common, kind: Type.Literal('trainer'), subtype: Type.Union(['item', 'tool', 'supporter', 'stadium'].map(v => Type.Literal(v))), text: Text }),
  object({ ...common, kind: Type.Literal('energy'), subtype: Type.Literal('basic'), energyType: Text, text: Type.Optional(Text) }),
  object({ ...common, kind: Type.Literal('energy'), subtype: Type.Literal('special'), text: Text }),
]);
export const DeckSchema = object({ name: Type.Optional(Text), cards: Type.Array(object({ card: CardSchema, count: positive }), { minItems: 1 }) });
export type CardData = Static<typeof CardSchema>;
export type DeckData = Static<typeof DeckSchema>;

export const VisibilitySchema = Type.Union([
  object({ mode: Type.Literal('hidden') }),
  object({ mode: Type.Literal('public') }),
  object({ mode: Type.Literal('players'), playerIds: Type.Array(Type.Union([Type.Literal('A'), Type.Literal('B')]), { minItems: 1, uniqueItems: true }) }),
]);
export type Visibility = Static<typeof VisibilitySchema>;
