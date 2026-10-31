import { Type, type Static } from '@sinclair/typebox';
import { MoveDestinationSchema } from './commands.ts';

/** 已选牌面的位置解析，不提供条件分支；只匹配当前有权查看的散牌。 */
const fields = {
  zoneId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }),
  cardRef: Type.Optional(Type.String({ pattern: '^c_[a-f0-9]{16}$' })),
  occurrence: Type.Optional(Type.Integer({ minimum: 0 })),
};
export const ShowKnownInputSchema = Type.Object(fields, { additionalProperties: false });
export const MoveKnownInputSchema = Type.Object({ ...fields, destination: MoveDestinationSchema }, { additionalProperties: false });
export type ShowKnownInput = Static<typeof ShowKnownInputSchema>;
export type MoveKnownInput = Static<typeof MoveKnownInputSchema>;
