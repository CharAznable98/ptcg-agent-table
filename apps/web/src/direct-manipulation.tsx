import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type HTMLAttributes, type KeyboardEvent } from "react";
import type { GameCommand, GroupView, HumanActionIntent, MatchView, ObjectView, Position, Viewer } from "../../../packages/protocol/src/index.ts";
import { objectAt, positionKey } from "./table-utils.ts";

type DragSource = { position: Position; kind: "card" | "attack" | "ability"; index?: number };
type StateField = Extract<GameCommand, { kind: "set_state" }>["field"];
type TargetProps = HTMLAttributes<HTMLElement> & { "data-drop-target"?: "ready" | "blocked" };
export interface SetupPlacement { active?: Position; bench: Position[]; benchSlots?: number[] }
export interface DirectTableState {
  active: DragSource | null;
  enabled: boolean;
  manual: boolean;
  viewer: Viewer;
  dragging: boolean;
  setup: boolean;
  handoff: boolean;
  sourcePosition: (position: Position) => Position;
  isGhost: (position: Position) => boolean;
  canPick: (object: ObjectView) => boolean;
  sourceProps: (source: DragSource, available: boolean) => HTMLAttributes<HTMLElement>;
  targetProps: (position: Position) => TargetProps;
  drop: (position?: Position) => boolean;
  cancel: () => void;
  onState?: (target: Position, field: StateField) => void;
}
export const DirectTableContext = createContext<DirectTableState | null>(null);
export const useDirectTable = () => useContext(DirectTableContext);

/** 开局草稿只做本地投影；来源始终是用户实际选择的手牌位置。 */
export function projectSetupPlacement(view: MatchView, viewer: Viewer, placement?: SetupPlacement) {
  const ghosts = new Map<string, Position>();
  if (!placement || viewer === "omniscient") return { view, ghosts };
  const zones = view.zones.map((zone) => ({ ...zone, items: [...zone.items] }));
  const selected = new Set<string>();
  const eligible = new Set(view.flow.choice?.eligible?.map(positionKey) ?? []);
  function put(source: Position | undefined, zoneId: string, index: number) {
    if (!source || !eligible.has(positionKey(source)) || selected.has(positionKey(source))) return;
    const card = objectAt(view, source), zone = zones.find((zone) => zone.id === zoneId);
    if (card?.kind !== "card" || card.card.kind !== "pokemon" || card.card.stage !== "基础" || !zone || index < 0 || index >= zone.items.length || zone.items[index]) return;
    const position = { zoneId, index };
    const ghost: GroupView = { kind: "group", position, stack: [{ ...card, position: { ...position, member: { relation: "stack", index: 0 } } }], attached: [], state: { damageCounters: 0, specialConditions: [], markers: {} } };
    zone.items[index] = ghost; ghosts.set(positionKey(position), source); selected.add(positionKey(source));
  }
  if (view.flow.choice?.kind === "initial_placement") put(placement.active, `${viewer}:active`, 0);
  const free = view.zones.find((zone) => zone.id === `${viewer}:bench`)?.items.flatMap((item, index) => item ? [] : [index]) ?? [];
  placement.bench.forEach((source, index) => put(source, `${viewer}:bench`, placement.benchSlots?.[index] ?? free[index] ?? -1));
  for (const zone of zones) if (zone.kind === "hand" && zone.playerId === viewer) zone.items = zone.items.filter((item) => !item || !selected.has(positionKey(item.position)));
  return { view: { ...view, zones }, ghosts };
}

/** 只将手势翻译为用户意图；卡文条件和结算不在前端实现。 */
export function gestureIntent(view: MatchView, viewer: Viewer, source: DragSource, target?: Position): HumanActionIntent | null {
  const zone = view.zones.find((item) => item.id === source.position.zoneId);
  const destination = target && view.zones.find((item) => item.id === target.zoneId);
  const object = objectAt(view, source.position);
  const targetObject = target && objectAt(view, target);
  if (!zone || zone.playerId !== viewer || !object) return null;
  if (view.flow.choice?.kind === "handoff" && view.flow.choice.playerId === viewer) {
    return source.kind === "card" && zone.kind === "bench" && object.kind === "group"
      && target && destination?.kind === "active" && destination.playerId === viewer && target.index >= 0 && target.index < destination.items.length && !targetObject
      ? { kind: "resolve_handoff", source: source.position, target } : null;
  }
  if (source.kind === "attack") return target && targetObject?.kind === "group"
    ? { kind: "attack", source: source.position, attackIndex: source.index!, target } : null;
  if (source.kind === "ability") return { kind: "ability", source: source.position, abilityIndex: source.index!, ...(target ? { target } : {}) };
  if (zone.kind === "deck" && source.position.index === 0 && destination?.kind === "hand" && destination.playerId === viewer)
    return { kind: "draw" };
  if (object.kind === "group" && zone.kind === "active" && destination?.kind === "bench" && destination.playerId === viewer && targetObject?.kind === "group")
    return { kind: "retreat", source: source.position, target: target! };
  if (zone.kind !== "hand" || object.kind !== "card") return null;
  if (object.card.kind === "energy") return target && targetObject?.kind === "group" && destination?.playerId === viewer
    ? { kind: "attach", source: source.position, target } : null;
  if (object.card.kind === "trainer") {
    // 目标是玩家明确拖入的区域或宝可梦；桌面中央落牌没有隐含选择。
    if (destination?.kind === "hand" || destination?.kind === "deck" || destination?.kind === "prizes") return null;
    return { kind: "play", source: source.position, ...(target ? { target } : {}) };
  }
  if (object.card.stage !== "基础" && targetObject?.kind === "group" && destination?.playerId === viewer)
    return { kind: "evolve", source: source.position, target: target! };
  return target && destination?.kind === "bench" && destination.playerId === viewer && !targetObject
    ? { kind: "play", source: source.position, target } : null;
}

export function useDirectManipulation({ view, viewer, enabled, manual = false, onIntent, onManualMove, onManualState, onPreview, setupPlacement, onSetupPlacement, ghosts = new Map() }: {
  view: MatchView; viewer: Viewer; enabled: boolean; manual?: boolean;
  onIntent?: (intent: HumanActionIntent) => void;
  onManualMove?: (source: Position, target: Position) => void;
  onManualState?: (target: Position, field: StateField) => void;
  onPreview: (object: ObjectView | null) => void;
  setupPlacement?: SetupPlacement;
  onSetupPlacement?: (placement: SetupPlacement) => void;
  ghosts?: Map<string, Position>;
}) {
  const [active, setActive] = useState<DragSource | null>(null);
  const [notice, setNotice] = useState("");
  const activeRef = useRef<DragSource | null>(null);
  const sourceRevision = useRef(view.revision);
  const inputMethod = useRef<"pointer" | "keyboard">("pointer");
  const pendingFocus = useRef<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const cancel = () => { activeRef.current = null; setActive(null); };
  const setup = Boolean(setupPlacement && onSetupPlacement && view.flow.choice?.playerId === viewer && ["initial_placement", "additional_bench"].includes(view.flow.choice.kind));
  const handoff = view.flow.choice?.kind === "handoff" && view.flow.choice.playerId === viewer;
  const live = Boolean(enabled && (onIntent || setup) && viewer !== "omniscient" && !view.replay);
  useEffect(() => { cancel(); }, [view.revision, live, manual, viewer]);
  // 草稿落牌会把空槽按钮替换为 ghost。布局提交后按原始来源找回同一张牌，
  // 而不是聚焦已被删除的目标；鼠标拖拽不设置 pendingFocus，也不抢键盘焦点。
  useLayoutEffect(() => {
    const source = pendingFocus.current;
    if (!source || !tableRef.current) return;
    pendingFocus.current = null;
    const cards = [...tableRef.current.querySelectorAll<HTMLElement>("[data-draft-source], [data-position-key]")];
    const moved = cards.find((card) => card.dataset.draftSource === source)
      ?? cards.find((card) => card.dataset.positionKey === source);
    (moved?.querySelector<HTMLElement>(".object-button") ?? tableRef.current).focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!active) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    return () => { document.removeEventListener("keydown", escape); window.removeEventListener("blur", cancel); };
  }, [Boolean(active)]);
  function pick(source: DragSource, method: "pointer" | "keyboard") {
    inputMethod.current = method;
    sourceRevision.current = view.revision; onPreview(null); activeRef.current = source; setActive(source); setNotice("");
  }
  const sourcePosition = (position: Position) => ghosts.get(positionKey(position)) ?? position;
  function setupCandidate(source: Position, target: Position): boolean {
    if (!setupPlacement || !setup) return false;
    const zone = view.zones.find((zone) => zone.id === target.zoneId);
    if (zone?.playerId !== viewer) return false;
    if (zone.kind === "hand") return true;
    if (zone.kind === "active") return view.flow.choice?.kind === "initial_placement" && !zone.items[target.index];
    if (zone.kind !== "bench" || target.index < 0 || target.index >= zone.items.length || zone.items[target.index]) return false;
    const occupant = ghosts.get(positionKey(target));
    return !occupant || positionKey(occupant) === positionKey(source);
  }
  function place(source: Position, target: Position) {
    if (!setupPlacement || !setupCandidate(source, target)) return false;
    const key = positionKey(source), previous = setupPlacement;
    const bench = previous.bench.filter((position) => positionKey(position) !== key);
    const oldFree = view.zones.find((zone) => zone.id === `${viewer}:bench`)?.items.flatMap((item, index) => item ? [] : [index]) ?? [];
    const benchSlots = previous.bench.flatMap((position, index) => positionKey(position) === key ? [] : [previous.benchSlots?.[index] ?? oldFree[index]!]);
    const active = previous.active && positionKey(previous.active) !== key ? previous.active : undefined;
    const zone = view.zones.find((zone) => zone.id === target.zoneId)!;
    if (inputMethod.current === "keyboard") pendingFocus.current = key;
    if (zone.kind === "hand") onSetupPlacement?.({ ...(active ? { active } : {}), bench, benchSlots });
    else if (zone.kind === "active") onSetupPlacement?.({ active: source, bench, benchSlots });
    else onSetupPlacement?.({ ...(active ? { active } : {}), bench: [...bench, source], benchSlots: [...benchSlots, target.index] });
    return true;
  }
  function drop(position?: Position): boolean {
    const source = activeRef.current;
    if (!live || !source) return false;
    if (sourceRevision.current !== view.revision) { cancel(); setNotice("牌桌已更新，请重新拖动"); return false; }
    if (setup) {
      const placed = Boolean(position && place(source.position, position));
      cancel(); if (!placed) setNotice("请拖入自己的空位或手牌"); return placed;
    }
    if (position && positionKey(position) === positionKey(source.position) && source.kind === "card") { cancel(); return false; }
    if (manual && position && source.kind === "card") {
      cancel(); onManualMove?.(source.position, position); return true;
    }
    const intent = gestureIntent(view, viewer, source, position);
    cancel();
    if (intent) { onIntent?.(intent); return true; }
    setNotice("未识别的落点，牌桌未改变"); return false;
  }
  const canPick = (object: ObjectView) => {
    if (!live) return false;
    if (setup) {
      const at = sourcePosition(object.position), original = objectAt(view, at);
      return Boolean(view.flow.choice?.eligible?.some((position) => positionKey(position) === positionKey(at)) && original?.kind === "card" && original.card.kind === "pokemon" && original.card.stage === "基础");
    }
    const zone = view.zones.find((zone) => zone.id === object.position.zoneId);
    if (manual) return object.kind !== "hidden" || zone?.playerId === viewer && zone.kind === "deck" && object.position.index === 0;
    if (zone?.playerId !== viewer) return false;
    if (handoff) return zone.kind === "bench" && object.kind === "group"
      && Boolean(view.zones.find((candidate) => candidate.playerId === viewer && candidate.kind === "active")?.items.every((item) => !item));
    if (zone.kind === "hand") return object.kind === "card";
    if (zone.kind === "deck") return object.position.index === 0 && !object.position.member;
    return zone.kind === "active" && object.kind === "group";
  };
  function sourceProps(source: DragSource, available: boolean): HTMLAttributes<HTMLElement> {
    const originalSource = setup ? { ...source, position: sourcePosition(source.position) } : source;
    return {
      draggable: Boolean(live && available),
      "aria-grabbed": live && available ? active && positionKey(active.position) === positionKey(originalSource.position) && active.kind === source.kind && active.index === source.index || false : undefined,
      onDragStart(event: DragEvent<HTMLElement>) {
        if (!live || !available) { event.preventDefault(); return; }
        event.stopPropagation(); event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-ptcg-card", positionKey(originalSource.position)); pick(originalSource, "pointer");
      },
      onDragEnd: cancel,
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
        if (event.key !== " " && event.key !== "Enter") return;
        if (activeRef.current) { event.preventDefault(); event.stopPropagation(); drop(source.position); }
        else if (event.key === " " && live && available) { event.preventDefault(); event.stopPropagation(); pick(originalSource, "keyboard"); }
      },
    };
  }
  function accepts(source: DragSource | null, position: Position): boolean {
    if (!source) return false;
    return setup ? setupCandidate(source.position, position) : manual ? positionKey(source.position) !== positionKey(position) : Boolean(gestureIntent(view, viewer, source, position));
  }
  function acceptsSurface(): boolean {
    const source = activeRef.current;
    return Boolean(live && source && !setup && !manual && gestureIntent(view, viewer, source));
  }
  function targetProps(position: Position): TargetProps {
    const candidate = accepts(active, position);
    const acceptDrag = (event: DragEvent<HTMLElement>) => {
      if (!live || !activeRef.current) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = accepts(activeRef.current, position) ? "move" : "none";
    };
    return {
      "data-drop-target": active ? candidate ? "ready" : "blocked" : undefined,
      // 原生事件可能连续到达；事件判断不能等待 React 提交拖动高亮。
      onDragEnter: acceptDrag,
      onDragOver: acceptDrag,
      onDrop(event) { if (activeRef.current) { event.preventDefault(); event.stopPropagation(); drop(position); } },
      onKeyDown(event) {
        if ((event.key === "Enter" || event.key === " ") && activeRef.current) { event.preventDefault(); event.stopPropagation(); drop(position); }
      },
    };
  }
  const context: DirectTableState = { active, enabled: live, manual, viewer, dragging: Boolean(active), setup, handoff, sourcePosition, isGhost: (position) => ghosts.has(positionKey(position)), canPick, sourceProps, targetProps, drop, cancel, onState: onManualState };
  return { context, notice, setNotice, tableRef, acceptsSurface };
}
