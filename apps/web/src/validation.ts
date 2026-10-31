import Ajv from "ajv";
import {
  CardSchema,
  DeckSchema,
  type CardData,
  type DeckData,
} from "../../../packages/protocol/src/index.ts";
const validator = new Ajv({ allErrors: true, strict: false });
const deckCheck = validator.compile(DeckSchema);
const cardCheck = validator.compile(CardSchema);
export function parseDeck(text: string): DeckData {
  const value: unknown = JSON.parse(text);
  if (!deckCheck(value))
    throw new Error(
      `卡组结构无效：${validator.errorsText(deckCheck.errors, { separator: "；" })}`,
    );
  return value as DeckData;
}
export function parseCard(text: string): CardData {
  const value: unknown = JSON.parse(text);
  if (!cardCheck(value))
    throw new Error(
      `卡牌结构无效：${validator.errorsText(cardCheck.errors, { separator: "；" })}`,
    );
  return value as CardData;
}
