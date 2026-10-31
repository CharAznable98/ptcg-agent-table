import type {
  Container,
  Destination,
  ObjectView,
  Position,
  Selection,
  TableView,
  ZoneView,
} from "../../../packages/protocol/src/index.ts";
export const zoneNames: Record<string, string> = {
  deck: "牌库",
  hand: "手牌",
  prizes: "奖赏卡",
  discard: "弃牌区",
  lost: "放逐区",
  active: "战斗场",
  bench: "备战区",
  stadium: "竞技场",
  staging: "暂存区",
};
export const conditionNames: Record<string, string> = {
  poisoned: "中毒",
  burned: "灼伤",
  asleep: "睡眠",
  paralyzed: "麻痹",
  confused: "混乱",
};
export const phaseNames: Record<string, string> = {
  setup: "开局准备",
  turn: "回合中",
  check: "宝可梦检查",
  result_pending: "等待结果确认",
  finished: "对局结束",
};
export const statusNames: Record<string, string> = {
  idle: "尚未运行",
  running: "AI 正在思考",
  waiting: "等待操作",
  paused: "已暂停",
  aborted: "运行中止",
  completed: "运行完成",
};
export function positionKey(position: Position) {
  return `${position.zoneId}/${position.index}${position.member ? `/${position.member.relation}/${position.member.index}` : ""}`;
}
export function positionLabel(position: Position) {
  const [seat, zone] = position.zoneId.includes(":")
    ? position.zoneId.split(":")
    : ["", position.zoneId];
  return `${seat ? `${seat} · ` : ""}${zoneNames[zone!] ?? zone} 第 ${position.index + 1} 位${position.member ? ` · ${position.member.relation === "stack" ? "叠牌" : "附着"} ${position.member.index + 1}` : ""}`;
}
export function containerFor(position: Position): Container {
  return position.member
    ? {
        kind: "group",
        position: { zoneId: position.zoneId, index: position.index },
        relation: position.member.relation,
      }
    : { kind: "zone", zoneId: position.zoneId };
}
export function containerKey(container: Container) {
  return container.kind === "zone"
    ? container.zoneId
    : `${container.position.zoneId}/${container.position.index}/${container.relation}`;
}
export function selectionFromPositions(positions: Position[]): Selection {
  if (!positions.length) throw new Error("请先点选牌桌上的卡牌或卡牌组");
  const container = containerFor(positions[0]!);
  if (
    positions.some(
      (position) =>
        containerKey(containerFor(position)) !== containerKey(container),
    )
  )
    throw new Error("一次批量操作只能选择同一来源中的对象");
  return {
    container,
    range: {
      mode: "indices",
      indices: positions
        .map((position) => position.member?.index ?? position.index)
        .sort((a, b) => a - b),
    },
  };
}
export function containers(
  view: TableView,
): {
  key: string;
  label: string;
  container: Container;
  size: number;
  zone?: ZoneView;
}[] {
  return view.zones.flatMap((zone) => [
    {
      key: zone.id,
      label: `${zone.playerId ? `${zone.playerId} · ` : ""}${zoneNames[zone.kind]}`,
      container: { kind: "zone", zoneId: zone.id } as Container,
      size: zone.items.length,
      zone,
    },
    ...zone.items.flatMap((object, index) =>
      object?.kind === "group"
        ? (["stack", "attached"] as const).map((relation) => ({
            key: `${zone.id}/${index}/${relation}`,
            label: `${positionLabel({ zoneId: zone.id, index })} · ${relation === "stack" ? "叠牌" : "附着卡"}`,
            container: {
              kind: "group",
              position: { zoneId: zone.id, index },
              relation,
            } as Container,
            size: object[relation].length,
          }))
        : [],
    ),
  ]);
}
export function objectAt(
  view: TableView,
  position: Position,
): ObjectView | null {
  const object =
    view.zones.find((zone) => zone.id === position.zoneId)?.items[
      position.index
    ] ?? null;
  return position.member && object?.kind === "group"
    ? (object[position.member.relation][position.member.index] ?? null)
    : object;
}
export function destinationFor(
  key: string,
  index: number,
  view: TableView,
): Destination {
  const container = containers(view).find(
    (item) => item.key === key,
  )?.container;
  if (!container) throw new Error("请选择有效目标区域");
  return { container, index };
}
export function togglePosition(
  selected: Position[],
  position: Position,
): Position[] {
  const key = positionKey(position);
  if (selected.some((item) => positionKey(item) === key))
    return selected.filter((item) => positionKey(item) !== key);
  if (
    selected.length &&
    containerKey(containerFor(selected[0]!)) !==
      containerKey(containerFor(position))
  )
    return [position];
  return [...selected, position];
}
