import type { CardData, ObjectView, Position, PublicEvent, TableView } from "../../../packages/protocol/src/index.ts";
import { eventTable, presentEvent } from "./event-presentation.ts";
import { positionKey } from "./table-utils.ts";

export interface ActionStep {
  id: string;
  title: string;
  detail?: string;
  actor: string;
  turnKey: string;
  turnLabel: string;
  /** 原子回放游标：行动开始前和结束后的已执行事件数。 */
  startIndex: number;
  endIndex: number;
  events: PublicEvent[];
  positions: Position[];
  revoked: boolean;
  motion?: "swap";
}

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const command = (event: PublicEvent) => fields(fields(event.data).command);
const kind = (event: PublicEvent) => text(command(event).kind) || event.commandKind;
const branchCommands = new Set(["system_restore", "debug_restore", "judge_ruling", "judge_end", "debug_abort", "object", "respond", "close_dispute"]);
const mechanical = new Set(["move", "set_state", "create_group", "remove_group", "random", "look", "show", "shuffle"]);
const clean = (value: string) => value.trim().replace(/[。；;]+$/u, "");

interface EventContext {
  event: PublicEvent;
  before?: TableView;
  after?: TableView;
  turnKey: string;
  turnLabel: string;
  phase: string;
}

function topCard(object: ObjectView | null | undefined): CardData | undefined {
  const top = object?.kind === "group" ? object.stack.at(-1) : object;
  return top?.kind === "card" ? top.card : undefined;
}

function selectionCards(selection: unknown, table?: TableView): CardData[] {
  if (!table) return [];
  const chosen = fields(selection), container = fields(chosen.container), range = fields(chosen.range);
  if (container.kind !== "zone" || typeof container.zoneId !== "string") return [];
  const items = table.zones.find(zone => zone.id === container.zoneId)?.items ?? [];
  const indexes = range.mode === "all" ? items.map((_, index) => index)
    : range.mode === "indices" && Array.isArray(range.indices) ? range.indices.filter((value): value is number => Number.isInteger(value) && Number(value) >= 0)
      : range.mode === "range" && Number.isInteger(range.start) && Number.isInteger(range.count)
        ? Array.from({ length: Math.min(Math.max(Number(range.count), 0), items.length) }, (_, offset) => Number(range.start) + offset) : [];
  return indexes.flatMap(index => { const card = topCard(items[index]); return card ? [card] : []; });
}

function containerZone(value: unknown): string {
  const container = fields(value);
  return container.kind === "zone" ? text(container.zoneId) : text(fields(container.position).zoneId);
}

type Declaration = { scope: "effect" | "attach" | "pokemon" | "attack" | "end"; name?: string };
function declaration(context: EventContext): Declaration | undefined {
  const wording = text(command(context.event).text);
  if (/^(?:宣告)?结束(?:自己的)?回合[。！!]?$/u.test(wording.trim())) return { scope: "end" };
  const table = context.before;
  if (!table) return;
  // 只从当时该席位可读的卡面匹配名称，不依据未来牌桌或固定卡名解释卡文。
  for (const zone of table.zones.filter(zone => zone.playerId === context.event.actor && ["active", "bench"].includes(zone.kind))) {
    for (const item of zone.items) {
      const card = topCard(item);
      if (card?.kind !== "pokemon") continue;
      if (card.attacks.some(attack => attack.name && wording.includes(attack.name))) return { scope: "attack" };
      if (card.abilities.some(ability => ability.name && wording.includes(ability.name))) return { scope: "effect" };
    }
  }
  const matching = table.zones.filter(zone => zone.playerId === context.event.actor && zone.kind === "hand")
    .flatMap(zone => zone.items.flatMap(item => { const card = topCard(item); return card && wording.includes(card.name) ? [card] : []; }));
  const names = [...new Set(matching.map(card => card.name))];
  if (names.length !== 1) return;
  const card = matching[0]!;
  return { scope: card.kind === "trainer" ? "effect" : card.kind === "energy" ? "attach" : "pokemon", name: card.name };
}

function sameSegment(first: EventContext, next: EventContext, sameActor = true): boolean {
  return (!sameActor || first.event.actor === next.event.actor)
    && first.turnKey === next.turnKey
    && first.event.revokedBy === next.event.revokedBy
    && !next.event.action
    && !branchCommands.has(kind(next.event));
}

function isOwnNewHandAction(next: EventContext, declarationName?: string): boolean {
  if (kind(next.event) !== "move") return false;
  const source = fields(command(next.event).source);
  if (!containerZone(source.container).endsWith(":hand")) return false;
  const cards = selectionCards(source, next.before);
  return !declarationName || !cards.length || cards.some(card => card.name !== declarationName);
}

function declaredEnd(contexts: EventContext[], start: number, declared: Declaration): number {
  const first = contexts[start]!;
  let end = start + 1;
  for (; end < contexts.length; end++) {
    const next = contexts[end]!, operation = command(next.event), nextKind = kind(next.event);
    if (!sameSegment(first, next) || nextKind === "declare") break;
    if (nextKind === "set_turn") {
      if ((declared.scope === "end" || declared.scope === "attack") && operation.phase === "check") end++;
      break;
    }
    if (next.phase !== first.phase || !mechanical.has(nextKind) || declared.scope === "end") break;
    if (declared.scope !== "attack" && isOwnNewHandAction(next, declared.name)) break;
    if (declared.scope === "attach" || declared.scope === "pokemon") {
      // 附着/放置只收纳对应牌的机械准备；牌实际移入目标后立即结束。
      if (nextKind === "move") {
        const cards = selectionCards(operation.source, next.before);
        if (!cards.length || cards.some(card => card.name !== declared.name)) break;
        end++;
        break;
      }
      if (!["create_group", "set_state"].includes(nextKind)) break;
    }
    // 洗牌明确收尾。后续无宣告附能/放置必须保持独立，不能吞到检索行动里。
    if (nextKind === "shuffle") { end++; break; }
  }
  return end;
}

function readEnd(contexts: EventContext[], start: number): number {
  const first = contexts[start]!, zone = containerZone(fields(command(first.event).selection).container);
  if (!zone) return start + 1;
  let end = start + 1;
  for (; end < contexts.length; end++) {
    const next = contexts[end]!, operation = command(next.event), nextKind = kind(next.event);
    if (!sameSegment(first, next) || next.phase !== first.phase) break;
    if (nextKind === "create_group") continue;
    if (nextKind === "move" && containerZone(fields(operation.source).container) === zone) continue;
    if (nextKind === "show" && containerZone(fields(operation.selection).container) === zone) continue;
    if (nextKind === "shuffle" && containerZone(fields(operation.selection).container) === zone) end++;
    break;
  }
  return end;
}

function createEnd(contexts: EventContext[], start: number): number {
  const next = contexts[start + 1], first = contexts[start]!;
  if (!next || !sameSegment(first, next) || kind(next.event) !== "move") return start + 1;
  const destination = fields(command(first.event).destination), container = fields(destination.container);
  const nextContainer = fields(fields(command(next.event).destination).container), position = fields(nextContainer.position);
  return container.kind === "zone" && nextContainer.kind === "group" && nextContainer.relation === "stack"
    && container.zoneId === position.zoneId && destination.index === position.index ? start + 2 : start + 1;
}

function moveSource(context: EventContext): Position | undefined {
  const source = fields(command(context.event).source), container = fields(source.container), range = fields(source.range);
  if (container.kind !== "zone" || typeof container.zoneId !== "string") return;
  const index = range.mode === "indices" && Array.isArray(range.indices) && range.indices.length === 1 ? range.indices[0]
    : range.mode === "range" && range.count === 1 ? range.start : undefined;
  return Number.isInteger(index) && Number(index) >= 0 ? { zoneId: container.zoneId, index: Number(index) } : undefined;
}
function moveDestination(context: EventContext): Position | undefined {
  const destination = fields(command(context.event).destination), container = fields(destination.container), result = fields(fields(context.event.data).result);
  const index = Number.isInteger(result.destinationIndex) ? result.destinationIndex : destination.index;
  return container.kind === "zone" && typeof container.zoneId === "string" && Number.isInteger(index) && Number(index) >= 0 ? { zoneId: container.zoneId, index: Number(index) } : undefined;
}
function swapEnd(contexts: EventContext[], start: number): number {
  const first = contexts[start], middle = contexts[start + 1], last = contexts[start + 2];
  if (!first || !middle || !last || [first, middle, last].some(context => kind(context.event) !== "move") || !sameSegment(first, middle) || !sameSegment(first, last)) return start + 1;
  const from = moveSource(first), temporary = moveDestination(first), other = moveSource(middle), intoFirst = moveDestination(middle), fromTemporary = moveSource(last), intoOther = moveDestination(last);
  if (!from || !temporary || !other || !intoFirst || !fromTemporary || !intoOther) return start + 1;
  return /:(active|bench)$/u.test(from.zoneId) && /:(active|bench)$/u.test(other.zoneId)
    && temporary.zoneId.endsWith(":staging") && positionKey(from) !== positionKey(other)
    && positionKey(intoFirst) === positionKey(from) && positionKey(fromTemporary) === positionKey(temporary) && positionKey(intoOther) === positionKey(other)
    ? start + 3 : start + 1;
}

function contextsFor(events: PublicEvent[]): EventContext[] {
  let previous: TableView | undefined, currentTurn = 0, currentOwner = "", branch = "";
  return events.map(event => {
    const after = eventTable(event), flow = fields(after?.flow ?? fields(event.data).flow);
    const phase = text(flow.phase);
    if (kind(event) === "system_restore" || kind(event) === "debug_restore") branch = `:${event.id}`;
    const turn = Number.isInteger(flow.turnNumber) ? Number(flow.turnNumber) : currentTurn;
    const owner = text(flow.turnOwner) || (turn === currentTurn ? currentOwner : "");
    const setup = phase === "setup", history = !setup && turn <= 0;
    const context = { event, before: previous, after, phase,
      turnKey: `${setup ? "setup" : history ? "history" : `turn:${turn}:${owner}`}${branch}`,
      turnLabel: setup ? "开局准备" : history ? "对局记录" : `第 ${turn} 回合${owner ? ` / ${owner}` : ""}` };
    currentTurn = turn; currentOwner = owner;
    previous = after;
    return context;
  });
}

function presentationFor(contexts: EventContext[], start: number, end: number, events: PublicEvent[], id: string): ActionStep {
  const first = contexts[start]!, group = contexts.slice(start, end);
  const presentations = group.map((context, offset) => presentEvent(context.event, events[start + offset - 1]));
  const declarationText = kind(first.event) === "declare" ? clean(text(command(first.event).text)) : "";
  let title = clean(first.event.action?.label ?? "") || declarationText || presentations[0]!.title;
  if (!first.event.action && first.phase === "setup" && group.length > 1) title = "开局准备";
  if (!first.event.action && kind(first.event) === "create_group" && group.length === 2) title = presentations[1]!.title;
  if (!first.event.action && kind(first.event) === "look" && group.some(context => kind(context.event) === "move")) title = presentations[0]!.title.replace(/^查看/u, "检索");
  const swap = !first.event.action && end - start === 3 && swapEnd(contexts, start) === end;
  if (swap) title = "交换卡牌组位置";
  const effects = presentations.filter((_, index) => ["move", "set_state", "random"].includes(kind(group[index]!.event)));
  const lastEffect = effects.at(-1);
  const detail = group.length > 1 ? (lastEffect && lastEffect.title !== title ? lastEffect.title : presentations.at(-1)?.detail) : presentations[0]!.detail;
  return { id, title, ...(detail ? { detail } : {}), actor: first.phase === "setup" && group.some(context => context.event.actor !== first.event.actor) ? "系统" : presentations[0]!.actor,
    turnKey: first.turnKey, turnLabel: first.turnLabel, startIndex: start, endIndex: end,
    events: group.map(context => context.event), positions: [...new Map(presentations.flatMap(item => item.positions).map(position => [positionKey(position), position])).values()],
    revoked: group.some(context => Boolean(context.event.revokedBy)), ...(swap ? { motion: "swap" as const } : {}) };
}

/** 确定、可复现的展示投影。每个原事件恰好属于一个连续范围，不改写历史。 */
export function buildActionHistory(events: PublicEvent[]): ActionStep[] {
  const contexts = contextsFor(events), steps: ActionStep[] = [], usedIds = new Set<string>();
  for (let start = 0; start < contexts.length;) {
    const first = contexts[start]!, firstKind = kind(first.event);
    let end = start + 1;
    if (!branchCommands.has(firstKind)) {
      if (first.event.action) {
        // 新行动的确切标识优先于旧记录的保守识别；绝不跨恢复点或撤销分支拼接。
        while (end < contexts.length && contexts[end]!.event.action?.id === first.event.action.id
          && contexts[end]!.event.revokedBy === first.event.revokedBy && !branchCommands.has(kind(contexts[end]!.event))) end++;
      } else if (first.phase === "setup") {
        while (end < contexts.length && contexts[end]!.phase === "setup" && sameSegment(first, contexts[end]!, false)) end++;
      } else if (firstKind === "declare") {
        const declared = declaration(first);
        if (declared) end = declaredEnd(contexts, start, declared);
      } else if (firstKind === "look") end = readEnd(contexts, start);
      else if (firstKind === "create_group") end = createEnd(contexts, start);
      else if (firstKind === "move") end = swapEnd(contexts, start);
      else if (first.phase === "check") {
        while (end < contexts.length && contexts[end]!.phase === "check" && sameSegment(first, contexts[end]!) && mechanical.has(kind(contexts[end]!.event))) end++;
      }
    }
    const preferred = first.event.action?.id ?? first.event.id;
    const id = usedIds.has(preferred) ? `${preferred}:${first.event.id}` : preferred;
    usedIds.add(id);
    steps.push(presentationFor(contexts, start, end, events, id));
    start = end;
  }
  return steps;
}
