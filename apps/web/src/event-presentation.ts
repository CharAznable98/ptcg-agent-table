import type {
  Container,
  ObjectView,
  Position,
  PublicEvent,
  TableView,
} from "../../../packages/protocol/src/index.ts";
import {
  conditionNames,
  objectAt,
  phaseNames,
  positionKey,
  zoneNames,
} from "./table-utils.ts";

export interface EventPresentation {
  title: string;
  detail?: string;
  actor: string;
  turnLabel: string;
  /** 历史位置只用于定位区域，不代表相同卡牌现在仍在该位置。 */
  positions: Position[];
}
type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function eventTable(
  event: PublicEvent | undefined,
): TableView | undefined {
  const table = fields(fields(event?.data).table);
  return Array.isArray(table.zones) &&
    Array.isArray(table.players) &&
    table.flow
    ? (table as unknown as TableView)
    : undefined;
}
function position(value: unknown): Position | undefined {
  const item = fields(value);
  if (
    typeof item.zoneId !== "string" ||
    !Number.isInteger(item.index) ||
    Number(item.index) < 0
  )
    return;
  return item as unknown as Position;
}
function container(value: unknown): Container | undefined {
  const item = fields(value);
  if (item.kind === "zone" && typeof item.zoneId === "string")
    return item as unknown as Container;
  if (
    item.kind === "group" &&
    position(item.position) &&
    ["stack", "attached"].includes(string(item.relation))
  )
    return item as unknown as Container;
}
function namedObject(object: ObjectView | null | undefined): string {
  if (object?.kind === "card") return object.card.name;
  if (object?.kind === "group") {
    const top = object.stack.at(-1);
    return top?.kind === "card" ? top.card.name : "卡牌组";
  }
  return "隐藏卡牌";
}
function object(view: TableView | undefined, at: Position | undefined) {
  return view && at ? objectAt(view, at) : null;
}
function zoneLabel(id: string): string {
  const [seat, kind] = id.includes(":") ? id.split(":") : ["", id];
  return `${seat ? `${seat} 的` : ""}${zoneNames[kind!] ?? "区域"}`;
}
function containerLabel(
  value: Container | undefined,
  view?: TableView,
): string {
  if (!value) return "所选区域";
  if (value.kind === "zone") return zoneLabel(value.zoneId);
  const name = namedObject(object(view, value.position));
  return `${name}的${value.relation === "attached" ? "附着卡" : "叠牌"}`;
}
function containerItems(
  value: Container | undefined,
  view?: TableView,
): (ObjectView | null)[] {
  if (!value || !view) return [];
  if (value.kind === "zone")
    return view.zones.find((zone) => zone.id === value.zoneId)?.items ?? [];
  const parent = object(view, value.position);
  return parent?.kind === "group" ? parent[value.relation] : [];
}
function selectionPositions(value: unknown, view?: TableView): Position[] {
  const selected = fields(value),
    source = container(selected.container);
  if (!source) return [];
  const range = fields(selected.range),
    items = containerItems(source, view);
  const indexes =
    range.mode === "all"
      ? items.flatMap((item, index) => (item ? [index] : []))
      : range.mode === "indices"
        ? list(range.indices).filter(
            (index): index is number =>
              Number.isInteger(index) && Number(index) >= 0,
          )
        : range.mode === "range"
          ? Array.from(
              { length: Math.min(number(range.count) ?? 0, 1000) },
              (_, index) => (number(range.start) ?? 0) + index,
            )
          : [];
  return indexes.map((index) =>
    source.kind === "zone"
      ? { zoneId: source.zoneId, index }
      : { ...source.position, member: { relation: source.relation, index } },
  );
}
function names(positions: Position[], view?: TableView): string {
  if (!view || !positions.length) return "";
  const visible = positions.map((at) => namedObject(object(view, at)));
  if (visible.every((name) => name === "隐藏卡牌")) return "";
  return (
    visible.slice(0, 3).join("、") +
    (visible.length > 3 ? `等 ${visible.length} 张` : "")
  );
}
function unique(positions: Position[]): Position[] {
  return [...new Map(positions.map((at) => [positionKey(at), at])).values()];
}
function flowDescription(view?: TableView): string {
  const flow = view?.flow;
  if (!flow) return "更新对局进度";
  if (flow.choice) {
    const choice: Record<string, string> = {
      choose_first: "选择先攻方",
      initial_placement: "摆放初始宝可梦",
      mulligan_draw: "选择补抽数量",
      additional_bench: "追加备战宝可梦",
      result_confirm: "确认对局结果",
      handoff: "完成选择",
      dispute_response: "回应异议",
    };
    return `等待 ${flow.choice.playerId} ${choice[flow.choice.kind] ?? "作出选择"}`;
  }
  if (flow.phase === "turn")
    return `${flow.turnOwner ?? ""} 的第 ${flow.turnNumber} 回合`;
  return phaseNames[flow.phase] ?? "更新对局进度";
}

/** 仅使用该条和上一条事件的历史投影。禁止用当前牌桌补充旧记录的牌面。 */
export function presentEvent(
  event: PublicEvent,
  previous?: PublicEvent,
): EventPresentation {
  const data = fields(event.data),
    command = fields(data.command),
    result = fields(data.result);
  const after = eventTable(event),
    before = eventTable(previous);
  const kind = string(command.kind) || event.commandKind;
  const flow = after?.flow;
  const base: EventPresentation = {
    title: "对局操作已记录",
    actor: event.actor === "system" ? "系统" : event.actor,
    turnLabel:
      flow?.phase === "setup"
        ? "开局准备"
        : flow?.turnNumber
          ? `第 ${flow.turnNumber} 回合${flow.turnOwner ? ` / ${flow.turnOwner}` : ""}`
          : "对局记录",
    positions: [],
  };
  switch (kind) {
    case "move": {
      const source = fields(command.source),
        from = container(source.container);
      const destination = fields(command.destination),
        originalTarget = container(destination.container);
      const sourcePositions = selectionPositions(command.source, before);
      const count = number(result.count) ?? sourcePositions.length;
      let target = originalTarget;
      // 组容器按请求前的位置绑定；同区散牌移出后，组的区域下标可能前移。
      if (
        target?.kind === "group" &&
        from?.kind === "zone" &&
        from.zoneId === target.position.zoneId &&
        before?.zones.find((zone) => zone.id === from.zoneId)?.layout ===
          "sequence"
      ) {
        const shifted = sourcePositions.filter(
          (at) =>
            at.index <
            (target as Extract<Container, { kind: "group" }>).position.index,
        ).length;
        target = {
          ...target,
          position: {
            ...target.position,
            index: target.position.index - shifted,
          },
        };
      }
      const start = number(result.destinationIndex) ?? number(destination.index) ?? 0;
      const targets: Position[] = target
        ? Array.from({ length: Math.min(count, 1000) }, (_, offset) =>
            target.kind === "zone"
              ? { zoneId: target.zoneId, index: start + offset }
              : {
                  ...target.position,
                  member: { relation: target.relation, index: start + offset },
                },
          )
        : [];
      const named = names(sourcePositions, before) || names(targets, after);
      const fromLabel = containerLabel(from, before),
        toLabel = containerLabel(target, after);
      if (target?.kind === "group" && target.relation === "attached") {
        base.title = `将${named || `${count} 张卡牌`}附着给${namedObject(object(after, target.position))}`;
        base.detail = `来自${fromLabel}`;
      } else if (
        from?.kind === "zone" &&
        target?.kind === "zone" &&
        from.zoneId.endsWith(":deck") &&
        target.zoneId === from.zoneId.replace(/:deck$/, ":hand") &&
        sourcePositions.every((at, index) => at.index === index)
      ) {
        base.title = `从${fromLabel}抽取 ${count} 张牌`;
        base.detail = named || undefined;
      } else if (
        count === 1 &&
        (object(before, sourcePositions[0])?.kind === "group" ||
          object(after, targets[0])?.kind === "group")
      ) {
        base.title = `将${named || "卡牌组"}移至${toLabel}`;
        base.detail = `来自${fromLabel}`;
      } else {
        base.title = `从${fromLabel}移入${toLabel} ${count} 张牌`;
        base.detail = named || undefined;
      }
      // 目的位置用于区域定位；不把已移出的来源当作当前卡牌位置。
      base.positions = unique(targets);
      break;
    }
    case "set_state": {
      const target = fields(command.target),
        field = fields(command.field);
      const at = position(target.position),
        old = object(before, at),
        current = object(after, at);
      const name =
        target.kind === "player"
          ? `${string(target.playerId)} 玩家`
          : target.kind === "zone"
            ? zoneLabel(string(target.zoneId))
            : namedObject(current || old);
      base.positions = at
        ? [at]
        : typeof target.zoneId === "string"
          ? [{ zoneId: target.zoneId, index: 0 }]
          : [];
      if (field.key === "slotCount") {
        const zoneId = string(target.zoneId);
        const previousCount = number(result.previousCount) ?? before?.zones.find((zone) => zone.id === zoneId)?.items.length;
        const count = number(result.count) ?? after?.zones.find((zone) => zone.id === zoneId)?.items.length ?? number(field.value);
        base.title = `${name}槽位：${previousCount === undefined ? "" : `${previousCount} → `}${count ?? "已调整"}`;
      } else if (field.key === "damageCounters") {
        const next = (number(field.value) ?? 0) * 10;
        base.title = `${name}累计伤害：${old?.kind === "group" ? `${old.state.damageCounters * 10} → ` : ""}${next}`;
      } else if (field.key === "specialConditions") {
        const conditions = list(field.value).map(
          (value) => conditionNames[string(value)] ?? string(value),
        );
        base.title = `${name}：${conditions.length ? conditions.join("、") : "清除特殊状态"}`;
      } else if (field.key === "visibility") {
        const visibility = fields(field.value);
        const label =
          field.value === null
            ? "恢复默认可见范围"
            : visibility.mode === "public"
              ? "公开牌面"
              : visibility.mode === "hidden"
                ? "隐藏牌面"
                : "设置玩家可见范围";
        base.title = `${name}：${label}`;
      } else if (field.key === "marker") {
        base.title = `${name}：${field.value === null ? "清除" : "更新"}标记「${string(field.name)}」`;
        if (field.value !== null) base.detail = String(field.value);
      } else base.title = `${name}状态已更新`;
      break;
    }
    case "declare":
      base.title = "宣告";
      base.detail = string(command.text);
      break;
    case "set_turn":
      base.title =
        command.phase === "check"
          ? "进入宝可梦检查"
          : `${string(command.playerId)} 开始回合`;
      break;
    case "handoff":
      base.title = `${command.returning ? "归还" : "交出"}操作权给 ${string(command.to)}`;
      base.detail = string(command.reason);
      break;
    case "shuffle": {
      const chosen = container(fields(command.selection).container);
      base.title = `洗牌：${containerLabel(chosen, before || after)}`;
      base.detail =
        number(result.count) !== undefined
          ? `${result.count} 个对象`
          : undefined;
      base.positions = selectionPositions(command.selection, after).slice(0, 1);
      break;
    }
    case "look":
    case "show": {
      base.title = `${kind === "look" ? "查看" : "向双方展示"}${containerLabel(container(fields(command.selection).container), before || after)}`;
      base.positions = selectionPositions(command.selection, after);
      const reveals = list(data.reveals).flatMap((reveal) =>
        list(fields(reveal).cards),
      );
      const revealedNames = reveals
        .map((reveal) => string(fields(fields(reveal).card).name))
        .filter(Boolean);
      base.detail = revealedNames.length
        ? [...new Set(revealedNames)].join("、")
        : number(result.count) !== undefined
          ? `${result.count} 张牌`
          : undefined;
      break;
    }
    case "random": {
      const coins = list(result.coins).map((coin) =>
        coin === "heads" ? "正面" : coin === "tails" ? "反面" : string(coin),
      );
      base.title =
        command.mode === "selection"
          ? "随机选择卡牌"
          : `投掷硬币${coins.length ? ` ${coins.length} 次` : ""}`;
      base.detail = coins.length
        ? coins.slice(0, 12).join("、") +
          (coins.length > 12 ? `，共 ${coins.length} 次` : "")
        : undefined;
      base.positions = list(result.positions)
        .map(position)
        .filter((at): at is Position => Boolean(at));
      break;
    }
    case "create_group": {
      const destination = fields(command.destination),
        target = container(destination.container);
      base.title = `在${containerLabel(target, after)}创建卡牌组`;
      if (target?.kind === "zone")
        base.positions = [
          { zoneId: target.zoneId, index: number(destination.index) ?? 0 },
        ];
      break;
    }
    case "remove_group": {
      const at = position(command.position);
      base.title = `移除${at ? zoneLabel(at.zoneId) : "所选位置"}的空卡牌组`;
      base.positions = at ? [at] : [];
      break;
    }
    case "choose_first":
      base.title = `选择 ${string(command.firstPlayer)} 先攻`;
      break;
    case "initial_placement":
      base.title = "选择初始战斗与备战宝可梦";
      break;
    case "mulligan_draw":
      base.title = `选择补抽 ${number(command.count) ?? 0} 张牌`;
      break;
    case "additional_bench":
      base.title = `选择追加 ${list(command.bench).length} 只备战宝可梦`;
      break;
    case "report_result": {
      const outcome = fields(command.result);
      base.title =
        outcome.kind === "win"
          ? `报告 ${string(outcome.winner)} 获胜`
          : outcome.kind === "draw"
            ? "报告平局"
            : "报告异常结束";
      base.detail = string(outcome.reason);
      break;
    }
    case "confirm_result":
      base.title = "确认对局结果";
      break;
    case "concede":
      base.title = "认输";
      break;
    case "object":
      base.title = "提出异议";
      base.detail = string(command.reason);
      break;
    case "respond": {
      const response = fields(command.response);
      base.title =
        response.kind === "accept" ? "认可异议及处置" : "提交异议辩护";
      base.detail = string(response.reason) || undefined;
      break;
    }
    case "system_progress":
      base.title = flowDescription(after);
      break;
    case "setup_coin_mapping":
      base.title = "确定先攻选择权映射";
      base.detail = "正面 A，反面 B";
      break;
    case "setup_schedule":
      base.title = "安排开局准备操作";
      break;
    case "system_restore":
    case "debug_restore":
      base.title = "恢复牌桌与流程";
      base.detail = "原记录保留，后续受影响操作标记为撤销";
      break;
    case "close_dispute":
      base.title = "异议处置完成";
      break;
    case "judge_ruling":
      base.title = "裁判作出裁决";
      break;
    case "judge_end":
      base.title = "裁判判定对局结束";
      break;
    case "debug_abort":
      base.title = "中止运行";
      base.detail = string(result.reason) || undefined;
      break;
    default:
      if (/[\u4e00-\u9fff]/u.test(event.label)) base.title = event.label;
  }
  return base;
}
