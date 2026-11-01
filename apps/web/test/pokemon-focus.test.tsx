import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupView, MatchView } from "../../../packages/protocol/src/index.ts";
import { PokemonFocus } from "../src/PokemonFocus.tsx";
import { Match } from "../src/Match.tsx";
import { view } from "./fixtures.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
export function focusTable(): MatchView {
  const current = structuredClone(view), base = current.zones[2]!.items[0] as GroupView;
  for (const playerId of ["A", "B"] as const) {
    const group = structuredClone(base), zoneId = `${playerId}:active`;
    group.position = { zoneId, index: 0 };
    group.stack.forEach((card, index) => { card.position = { zoneId, index: 0, member: { relation: "stack", index } }; });
    current.zones.push({ id: zoneId, playerId, kind: "active", layout: "slots", defaultVisibility: { mode: "public" }, items: [group] });
  }
  const source = current.zones.find(zone => zone.id === "A:active")!.items[0] as GroupView;
  const card = source.stack[0]; if (card?.kind !== "card" || card.card.kind !== "pokemon") throw new Error("fixture");
  card.card.abilities = [{ name: "补给", text: "自己的回合时可以使用1次。从自己的牌库抽1张牌。" }];
  card.card.attacks.push({ name: "第二招式", energyCost: [{ type: "草", count: 2 }], damageText: "60+", text: "完整显示第二招式的效果说明。" });
  return current;
}
function panel(current = focusTable(), enabled = true) {
  const callbacks = { onIntent: vi.fn(), onInspectMember: vi.fn(), close: vi.fn() };
  const object = current.zones.find(zone => zone.id === "A:active")!.items[0] as GroupView;
  return { ...render(<PokemonFocus object={object} view={current} enabled={enabled} {...callbacks} />), ...callbacks, object, current };
}
describe("宝可梦放大行动视图", () => {
  it("完整展示费用、伤害与说明，第二招式保持实际编号和普通对象", () => {
    const result = panel();
    expect(screen.getByText("完整显示第二招式的效果说明。")).toBeVisible();
    expect(screen.getByLabelText("草能量 2")).toHaveTextContent("草 ×2");
    expect(screen.getByText("60+")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "使用招式第二招式" }));
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "attack", source: result.object.position, attackIndex: 1, target: { zoneId: "B:active", index: 0 } });
  });
  it("使用特性不代选目标；执行锁定时按钮仍显示但不可提交", () => {
    const result = panel();
    fireEvent.click(screen.getByRole("button", { name: "使用特性补给" }));
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "ability", source: result.object.position, abilityIndex: 0 });
    result.rerender(<PokemonFocus object={result.object} view={result.current} enabled={false} onIntent={result.onIntent} onInspectMember={result.onInspectMember} close={result.close} />);
    expect(screen.getByRole("button", { name: "使用特性补给" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "使用特性补给" }));
    expect(result.onIntent).toHaveBeenCalledOnce();
  });
  it("撤退明确选择换上的宝可梦，不默认选第一只", () => {
    const result = panel();
    fireEvent.click(screen.getByRole("button", { name: /撤退/ }));
    expect(result.onIntent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /叶芽.*备战区/ }));
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "retreat", source: result.object.position, target: { zoneId: "A:bench", index: 0 } });
  });
  it("历史和全知观察只阅读卡文，不出现可使用的行动", () => {
    const current = focusTable(); current.viewer = "omniscient"; current.replay = { index: 0, total: 0 };
    const result = panel(current, false);
    expect(screen.queryByRole("button", { name: /使用招式|使用特性/ })).toBeNull();
    expect(screen.getByText("第二招式")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(result.close).toHaveBeenCalledOnce();
    expect(result.onIntent).not.toHaveBeenCalled();
  });
  it("记录仍可获得焦点，从记录按Escape也能关闭卡牌", () => {
    const current = focusTable(), close = vi.fn();
    render(<><button type="button">读取对局记录</button><PokemonFocus object={current.zones.find(zone => zone.id === "A:active")!.items[0] as GroupView} view={current} enabled close={close} onIntent={() => {}} onInspectMember={() => {}} /></>);
    const record = screen.getByRole("button", { name: "读取对局记录" });
    act(() => record.focus());
    fireEvent.keyDown(record, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("查看附着卡只切换详情，不产生游戏选择或行动", () => {
    const current = focusTable(), source = current.zones.find(zone => zone.id === "A:active")!.items[0] as GroupView;
    const member = { kind: "card" as const, position: { ...source.position, member: { relation: "attached" as const, index: 0 } }, ownerId: "A" as const, markers: {}, card: { kind: "energy" as const, subtype: "basic" as const, name: "合成草能量", energyType: "草" } };
    source.attached.push(member);
    const result = panel(current);
    fireEvent.click(screen.getByText("叠牌与附着 1"));
    fireEvent.click(screen.getByRole("button", { name: /合成草能量/ }));
    expect(result.onInspectMember).toHaveBeenCalledExactlyOnceWith(member);
    expect(result.onIntent).not.toHaveBeenCalled();
  });
  it("真实Match从点卡进入行动，提交失败在中央显示完整原因且不自动重试", async () => {
    const current = focusTable();
    const message = "没有附着足够的能量，无法满足第二招式的费用。请先附着能量，再重新使用。";
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.includes("/events?")) return new Response("");
      if (path.endsWith("/actions/activate")) return new Response("null");
      if (path.endsWith("/actions") && options?.method === "POST") return new Response(JSON.stringify({ error: { code: "INVALID_ACTION", message } }), { status: 409 });
      return new Response(JSON.stringify(current));
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => { render(<Match id={current.id} back={() => {}} />); });
    expect(screen.queryByRole("button", { name: "使用招式第二招式" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看A · 战斗场 第 1 位卡牌组" }));
    expect(screen.getByRole("dialog", { name: "叶芽的卡牌与行动" })).toBeVisible();
    expect(screen.getByLabelText("对战牌桌")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "使用招式第二招式" }));
    const warning = await screen.findByRole("alertdialog", { name: "操作失败" });
    expect(warning).toHaveTextContent(message);
    fireEvent.keyDown(screen.getByRole("button", { name: "确认" }), { key: "Escape" });
    fireEvent.mouseDown(warning.parentElement!);
    expect(warning).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/actions"))).toHaveLength(1);
  });
});
