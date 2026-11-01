import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Json, MatchView, PublicEvent, TableView } from "../../../packages/protocol/src/index.ts";
import { buildActionHistory } from "../src/action-history.ts";
import { MatchHistory } from "../src/MatchHistory.tsx";
import { card, view } from "./fixtures.ts";

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
function event(sequence: number, command: unknown, table: TableView | undefined = view, extra: Partial<PublicEvent> = {}): PublicEvent {
  return { id: `event-${sequence}`, sequence, revision: sequence, at: "2026-10-31T09:00:00.000Z", actor: "A", commandKind: String((command as { kind: string }).kind), label: "操作", data: json({ command, ...(table ? { table } : {}) }), ...extra };
}
function turn(number: number, phase: "turn" | "check" = "turn"): TableView {
  const next = structuredClone(view);
  next.flow = { ...next.flow, turnNumber: number, turnOwner: phase === "check" ? null : number % 2 ? "A" : "B", phase };
  return next;
}
const source = (zoneId: string, index = 0) => ({ container: { kind: "zone", zoneId }, range: { mode: "indices", indices: [index] } });
const move = (from: string, container: unknown) => ({ kind: "move", source: source(from), destination: { container, index: 0 } });
const callbacks = (current: MatchView) => ({ view: current, canObject: true, debug: true, onObject: vi.fn(), onRestore: vi.fn(), onLocate: vi.fn() });

describe("完整行动的保守聚合", () => {
  it("已知三段暂存交换合成一个手势行动，错误收尾仍逐条保留", () => {
    const steps = [
      event(1, { kind: "move", source: source("A:active"), destination: { container: { kind: "zone", zoneId: "A:staging" }, index: 0 } }),
      event(2, { kind: "move", source: source("A:bench", 3), destination: { container: { kind: "zone", zoneId: "A:active" }, index: 0 } }),
      event(3, { kind: "move", source: source("A:staging"), destination: { container: { kind: "zone", zoneId: "A:bench" }, index: 3 } }),
    ];
    const actions = buildActionHistory(steps);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ title: "交换卡牌组位置", startIndex: 0, endIndex: 3, events: steps });
    const different = event(3, { kind: "move", source: source("A:staging"), destination: { container: { kind: "zone", zoneId: "A:bench" }, index: 2 } });
    expect(buildActionHistory([...steps.slice(0, 2), different])).toHaveLength(3);
  });
  it("人类行动标识优先，连续事件只生成一个完整范围", () => {
    const action = { id: "human-action", label: "附着合成能量" };
    const events = [event(1, { kind: "future_command" }), event(2, { kind: "declare", text: "开始执行" }, view, { action }), event(3, { kind: "set_state", target: { kind: "player", playerId: "A" }, field: { key: "marker", name: "附能", value: true } }, view, { action }), event(4, move("A:hand", { kind: "group", position: { zoneId: "A:bench", index: 0 }, relation: "attached" }), view, { action })];
    const steps = buildActionHistory(events);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ id: "human-action", title: "附着合成能量", startIndex: 1, endIndex: 4, events: events.slice(1), revoked: false });
    expect(steps.flatMap(step => step.events)).toEqual(events);
  });

  it("检索洗牌后立即收尾，不合并随后无宣告的附能", () => {
    const before = structuredClone(view);
    before.zones.find(zone => zone.id === "A:hand")!.items[0] = { kind: "card", card: { kind: "trainer", subtype: "item", name: "合成检索卡", text: "合成测试说明" }, position: { zoneId: "A:hand", index: 0 }, ownerId: "A", markers: {} };
    const events = [
      event(1, { kind: "future_command" }, before),
      event(2, { kind: "declare", text: "使用合成检索卡。" }, before),
      event(3, move("A:hand", { kind: "zone", zoneId: "A:discard" }), before),
      event(4, { kind: "look", selection: source("A:deck") }, before),
      event(5, move("A:deck", { kind: "zone", zoneId: "A:hand" }), before),
      event(6, { kind: "shuffle", selection: source("A:deck") }, before),
      event(7, move("A:hand", { kind: "group", position: { zoneId: "A:bench", index: 0 }, relation: "attached" }), before),
    ];
    const steps = buildActionHistory(events);
    expect(steps.map(step => [step.startIndex, step.endIndex])).toEqual([[0, 1], [1, 6], [6, 7]]);
    expect(steps[1]!.title).toBe("使用合成检索卡");
    expect(steps[2]!.title).toContain("附着");
  });

  it("无宣告创建空组后立即装入卡牌，作为同一次放置", () => {
    const events = [event(1, { kind: "create_group", destination: { container: { kind: "zone", zoneId: "A:bench" }, index: 1 } }), event(2, move("A:hand", { kind: "group", position: { zoneId: "A:bench", index: 1 }, relation: "stack" }))];
    const steps = buildActionHistory(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ startIndex: 0, endIndex: 2 });
    const unrelated = event(2, move("A:hand", { kind: "group", position: { zoneId: "A:bench", index: 2 }, relation: "stack" }));
    expect(buildActionHistory([events[0]!, unrelated])).toHaveLength(2);
  });

  it("同回合检查沿用此前回合归属，进入下一回合后才换分组", () => {
    const events = [event(1, { kind: "future_command" }, turn(2)), event(2, { kind: "set_turn", phase: "check", playerId: null }, turn(2, "check")), event(3, { kind: "random", mode: "coins" }, turn(2, "check")), event(4, { kind: "set_turn", phase: "turn", playerId: "A" }, turn(3))];
    const steps = buildActionHistory(events);
    expect(steps[0]!.turnKey).toBe(steps[1]!.turnKey);
    expect(steps[1]!.turnLabel).toBe("第 2 回合 / B");
    expect(steps[2]!.turnLabel).toBe("第 3 回合 / A");
    const { container } = render(<MatchHistory {...callbacks({ ...view, events })} />);
    expect(container.querySelectorAll(".history-round")).toHaveLength(2);
  });

  it("恢复点与撤销分支隔离，保留全部事件且游标没有遗漏", () => {
    const action = { id: "reused-action", label: "原行动" };
    const events = [event(1, { kind: "declare", text: "原行动" }, view, { action, revokedBy: "restore" }), event(2, { kind: "set_state" }, view, { action, revokedBy: "restore" }), event(3, { kind: "system_restore" }, view, { action }), event(4, { kind: "set_state" }, view, { action })];
    const original = structuredClone(events), steps = buildActionHistory(events);
    expect(steps.map(step => [step.startIndex, step.endIndex])).toEqual([[0, 2], [2, 3], [3, 4]]);
    expect(steps[0]!.revoked).toBe(true);
    expect(steps[1]!.revoked).toBe(false);
    expect(new Set(steps.map(step => step.id)).size).toBe(steps.length);
    expect(steps.flatMap(step => step.events)).toEqual(events);
    expect(events).toEqual(original);
    expect(steps[0]!.turnKey).not.toBe(steps[1]!.turnKey);
  });

  it("缺少历史快照时不沿用更早的牌位，也不读取未来牌面", () => {
    const hidden = structuredClone(view);
    hidden.zones.forEach(zone => { zone.items = zone.items.map((item, index) => item ? { kind: "hidden", position: { zoneId: zone.id, index } } : null); });
    const events = [event(1, { kind: "future_command" }, view), event(2, move("A:hand", { kind: "zone", zoneId: "A:discard" }), undefined), event(3, { kind: "declare", text: "使用一张牌" }, hidden), event(4, move("A:deck", { kind: "zone", zoneId: "A:hand" }), hidden), event(5, { kind: "future_command" }, view)];
    // event() 默认参数使用 view；显式移除第二条快照，模拟旧记录。
    events[1]!.data = json({ command: move("A:hand", { kind: "zone", zoneId: "A:discard" }) });
    const steps = buildActionHistory(events);
    expect(steps.find(step => step.startIndex === 2)).toMatchObject({ endIndex: 3, title: "使用一张牌" });
    expect(steps.find(step => step.startIndex === 3)!.detail).toBeUndefined();
    expect(steps.filter(step => step.startIndex >= 2 && step.startIndex <= 3).map(step => JSON.stringify(step)).join("")).not.toContain(card.name);
  });

  it("开局机械记录压缩但原件完整保留", () => {
    const setup = structuredClone(view);
    setup.flow = { ...setup.flow, phase: "setup", turnNumber: 0, turnOwner: null };
    const events = [event(1, { kind: "setup_coin_mapping" }, setup, { actor: "system" }), event(2, { kind: "random", mode: "coins" }, setup, { actor: "system" }), event(3, { kind: "choose_first", firstPlayer: "A" }, setup), event(4, { kind: "system_progress" }, turn(1), { actor: "system" })];
    const steps = buildActionHistory(events);
    expect(steps[0]).toMatchObject({ title: "开局准备", actor: "系统", startIndex: 0, endIndex: 3, events: events.slice(0, 3) });
    expect(steps[1]!.startIndex).toBe(3);
  });
});

describe("按回合展开与行动导航", () => {
  it("默认仅展开最新两个回合，手动覆盖在新回合到来后仍保留", () => {
    const events = [1, 2, 3].map(number => event(number, { kind: "declare", text: `第${number}次行动` }, turn(number)));
    const properties = callbacks({ ...view, events });
    const { rerender } = render(<MatchHistory {...properties} />);
    const round = (number: number) => screen.getByRole("button", { name: new RegExp(`第 ${number} 回合`) });
    expect(round(1)).toHaveAttribute("aria-expanded", "false");
    expect(round(2)).toHaveAttribute("aria-expanded", "true");
    expect(round(3)).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(round(1));
    fireEvent.click(round(2));
    rerender(<MatchHistory {...properties} view={{ ...view, events: [...events, event(4, { kind: "declare", text: "新行动" }, turn(4))] }} />);
    expect(round(1)).toHaveAttribute("aria-expanded", "true");
    expect(round(2)).toHaveAttribute("aria-expanded", "false");
    expect(round(3)).toHaveAttribute("aria-expanded", "true");
    expect(round(4)).toHaveAttribute("aria-expanded", "true");
  });

  it("完整行动导航和独立播放使用同一索引，原子元数据按需展开", () => {
    const action = { id: "human-action", label: "合成行动" };
    const events = [event(201, { kind: "declare", text: "合成行动" }, view, { action }), event(202, { kind: "set_state", target: { kind: "group", position: { zoneId: "A:bench", index: 0 } }, field: { key: "damageCounters", value: 4 } }, view, { action })];
    const properties = { ...callbacks({ ...view, events }), onReplay: vi.fn(), activeActionId: "human-action" };
    const { container } = render(<MatchHistory {...properties} />);
    expect(screen.queryByText("#201")).not.toBeInTheDocument();
    expect(screen.queryByText("提出异议")).not.toBeInTheDocument();
    const title = screen.getByRole("button", { name: "合成行动" });
    fireEvent.click(title);
    expect(properties.onReplay).toHaveBeenCalledWith(expect.objectContaining({ startIndex: 0, endIndex: 2 }));
    expect(properties.onLocate).toHaveBeenCalledWith([{ zoneId: "A:bench", index: 0 }]);
    fireEvent.click(screen.getByRole("button", { name: "回放：合成行动" }));
    expect(properties.onReplay).toHaveBeenCalledTimes(2);
    const details = container.querySelector<HTMLDetailsElement>(".history-action-details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("#201")).toBeInTheDocument();
    expect(within(details).getAllByText("提出异议")).toHaveLength(2);
    expect(container.querySelector(".history-action")).toHaveClass("is-active");
  });
});
