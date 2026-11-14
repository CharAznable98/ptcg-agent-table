import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupView, MatchView } from "../../../packages/protocol/src/index.ts";
import { PokemonFocus } from "../src/PokemonFocus.tsx";
import { ObjectInspector } from "../src/Cards.tsx";
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
  it("当前玩家可请求使用对手可见宝可梦的效果，由代理核对卡文", () => {
    const current = focusTable(), onIntent = vi.fn(), object = current.zones.find(zone => zone.id === "B:active")!.items[0] as GroupView;
    render(<PokemonFocus object={object} view={current} enabled onIntent={onIntent} onInspectMember={vi.fn()} close={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "使用效果" }));
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "activate_effect", source: object.position });
  });
  it("竞技场详情通用使用入口支持对手持有的公共卡牌", () => {
    const current = focusTable(), onIntent = vi.fn();
    const stadium = { kind: "card" as const, position: { zoneId: "stadium", index: 0 }, ownerId: "B" as const, markers: {}, card: { kind: "trainer" as const, subtype: "stadium" as const, name: "合成竞技场", text: "双方可以使用此效果。" } };
    const result = render(<ObjectInspector object={stadium} actionView={current} actionEnabled onIntent={onIntent} selected={[]} onSelect={vi.fn()} close={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "使用" }));
    fireEvent.click(screen.getByRole("button", { name: "使用", hidden: false }));
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "activate_effect", source: stadium.position });
    result.rerender(<ObjectInspector object={stadium} actionView={current} actionEnabled={false} onIntent={onIntent} selected={[]} onSelect={vi.fn()} close={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "使用" })).toBeNull();
  });
  it("卡牌通用入口可明确输入招式并绑定当前来源", () => {
    const current = focusTable(), onIntent = vi.fn();
    const attached = { kind: "card" as const, position: { zoneId: "A:active", index: 0, member: { relation: "attached" as const, index: 0 } }, ownerId: "A" as const, markers: {}, card: { kind: "trainer" as const, subtype: "tool" as const, name: "合成道具", text: "合成说明。" } };
    render(<ObjectInspector object={attached} actionView={current} actionEnabled onIntent={onIntent} selected={[]} onSelect={vi.fn()} close={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "使用" }));
    fireEvent.change(screen.getByLabelText("操作"), { target: { value: "attack" } });
    expect(screen.getByRole("button", { name: "使用" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("招式名称"), { target: { value: "合成招式" } });
    fireEvent.click(screen.getByRole("button", { name: "使用" }));
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "other_attack", source: { zoneId: "A:active", index: 0 }, target: { zoneId: "B:active", index: 0 }, attackName: "合成招式", origin: { kind: "card", position: attached.position } });
  });
  it("卡牌使用表单可用 Escape 返回，预览和回放不显示入口", async () => {
    const current = focusTable(), close = vi.fn();
    const stadium = { kind: "card" as const, position: { zoneId: "stadium", index: 0 }, ownerId: "B" as const, markers: {}, card: { kind: "trainer" as const, subtype: "stadium" as const, name: "合成竞技场", text: "合成说明。" } };
    const result = render(<ObjectInspector object={stadium} actionView={current} actionEnabled onIntent={vi.fn()} selected={[]} onSelect={vi.fn()} close={close} />);
    fireEvent.click(screen.getByRole("button", { name: "使用" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "使用卡牌" })).toBeNull();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "使用" })).toHaveFocus();
    current.replay = { index: 0, total: 0 };
    result.rerender(<ObjectInspector object={stadium} actionView={current} actionEnabled onIntent={vi.fn()} selected={[]} onSelect={vi.fn()} close={close} />);
    expect(screen.queryByRole("button", { name: "使用" })).toBeNull();
    delete current.replay;
    result.rerender(<ObjectInspector object={stadium} actionView={current} actionEnabled onIntent={vi.fn()} selected={[]} onSelect={vi.fn()} close={close} pinned={false} />);
    expect(screen.queryByRole("button", { name: "使用" })).toBeNull();
  });
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
  it("其他招式由玩家指定名称和具体来源，多个同名附着卡区分位置", () => {
    const current = focusTable(), source = current.zones.find(zone => zone.id === "A:active")!.items[0] as GroupView;
    const provider = { ...source.position, member: { relation: "attached" as const, index: 0 } };
    source.attached.push({ kind: "card", position: provider, ownerId: "A", markers: {}, card: { kind: "trainer", subtype: "tool", name: "合成道具", text: "附着的宝可梦可以使用此卡上的招式。完整招式说明。" } });
    source.attached.push({ kind: "card", position: { ...provider, member: { relation: "attached", index: 1 } }, ownerId: "A", markers: {}, card: { kind: "trainer", subtype: "tool", name: "合成道具", text: "另一张卡。" } });
    const result = panel(current);
    expect(screen.queryByRole("button", { name: "使用合成道具的招式" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "使用其他招式" }));
    expect(screen.getByRole("button", { name: "使用" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("招式名称"), { target: { value: " 进化 " } });
    fireEvent.change(screen.getByLabelText("来源"), { target: { value: "A:active/0/attached/0" } });
    expect(screen.getByText("附着的宝可梦可以使用此卡上的招式。完整招式说明。")).toBeVisible();
    expect(screen.getAllByRole("option", { name: /合成道具/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "使用" }));
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "other_attack", source: source.position, origin: { kind: "card", position: provider }, attackName: "进化", target: { zoneId: "B:active", index: 0 } });
    result.rerender(<PokemonFocus object={result.object} view={result.current} enabled={false} onIntent={result.onIntent} onInspectMember={result.onInspectMember} close={result.close} />);
    expect(screen.getByRole("button", { name: "使用其他招式" })).toBeDisabled();
  });
  it("其他来源可用文字指定，必须输入来源，返回或 Escape 不提交", () => {
    const result = panel();
    fireEvent.click(screen.getByRole("button", { name: "使用其他招式" }));
    fireEvent.change(screen.getByLabelText("招式名称"), { target: { value: "传承" } });
    fireEvent.change(screen.getByLabelText("来源"), { target: { value: "description" } });
    expect(screen.getByRole("button", { name: "使用" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("来源卡名称"), { target: { value: "上回合效果" } });
    fireEvent.click(screen.getByRole("button", { name: "使用" }));
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "other_attack", source: result.object.position, target: { zoneId: "B:active", index: 0 }, attackName: "传承", origin: { kind: "description", text: "上回合效果" } });
    fireEvent.keyDown(screen.getByLabelText("招式名称"), { key: "Escape" });
    expect(result.close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "使用其他招式" })).toHaveFocus();
  });
  it("无招式的附着卡不会产生独立按钮，取消操作不会提交", () => {
    const current = focusTable(), source = current.zones.find(zone => zone.id === "A:active")!.items[0] as GroupView;
    source.attached.push({ kind: "card", position: { ...source.position, member: { relation: "attached", index: 0 } }, ownerId: "A", markers: {}, card: { kind: "energy", subtype: "basic", name: "合成草能量", energyType: "草" } });
    const result = panel(current);
    expect(screen.queryByRole("button", { name: "使用合成草能量的招式" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "使用其他招式" }));
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("button", { name: "使用其他招式" })).toHaveFocus();
    expect(result.onIntent).not.toHaveBeenCalled();
  });
  it("选择宝可梦来源显示招式内容，牌桌版本变化后必须重新选择来源", () => {
    const result = panel();
    fireEvent.click(screen.getByRole("button", { name: "使用其他招式" }));
    fireEvent.change(screen.getByLabelText("招式名称"), { target: { value: "第二招式" } });
    fireEvent.change(screen.getByLabelText("来源"), { target: { value: "A:active/0/stack/0" } });
    expect(screen.getByText(/草 ×2.*60\+/)).toHaveTextContent("完整显示第二招式的效果说明");
    expect(screen.getByRole("button", { name: "使用" })).toBeEnabled();
    const next = { ...result.current, revision: result.current.revision + 1 };
    result.rerender(<PokemonFocus object={result.object} view={next} enabled onIntent={result.onIntent} onInspectMember={result.onInspectMember} close={result.close} />);
    expect(screen.getByRole("button", { name: "使用" })).toBeDisabled();
    expect(result.onIntent).not.toHaveBeenCalled();
  });
  it("非本人或回放视角不提供其他招式入口", () => {
    const current = focusTable(), source = current.zones.find(zone => zone.id === "A:active")!.items[0] as GroupView;
    source.attached.push({ kind: "card", position: { ...source.position, member: { relation: "attached", index: 0 } }, ownerId: "A", markers: {}, card: { kind: "trainer", subtype: "tool", name: "合成道具", text: "合成说明。" } });
    current.viewer = "omniscient"; current.replay = { index: 0, total: 0 };
    panel(current, false);
    expect(screen.queryByRole("button", { name: "使用其他招式" })).toBeNull();
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
