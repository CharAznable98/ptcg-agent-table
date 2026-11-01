import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CardData, GroupView, HumanActionView, MatchView, Position } from "../../../packages/protocol/src/index.ts";
import { MatchTable } from "../src/MatchTable.tsx";
import { HumanActionDock, SetupPlacementBar, type SetupPlacement } from "../src/HumanActions.tsx";
import { card, view } from "./fixtures.ts";

function tabletop(): MatchView {
  const next = structuredClone(view);
  const group = next.zones[2]!.items[0] as GroupView;
  next.zones.push(...["A", "B"].map((seat) => ({
    id: `${seat}:active`, kind: "active" as const, playerId: seat as "A" | "B", layout: "slots" as const,
    defaultVisibility: { mode: "public" as const },
    items: [{ ...structuredClone(group), position: { zoneId: `${seat}:active`, index: 0 } }],
  })));
  next.zones[0]!.items[0] = { kind: "card", position: { zoneId: "A:hand", index: 0 }, ownerId: "A", markers: {},
    card: { kind: "energy", subtype: "basic", name: "合成能量", energyType: "草" } };
  return next;
}
function table(overrides: Partial<React.ComponentProps<typeof MatchTable>> = {}) {
  const callbacks = { onSelect: vi.fn(), onInspect: vi.fn(), onPreview: vi.fn(), onDestination: vi.fn(), onIntent: vi.fn(), onManualMove: vi.fn(), onManualState: vi.fn() };
  const result = render(<MatchTable view={tabletop()} viewer="A" selected={[]} highlighted={[]} interactive {...callbacks} {...overrides} />);
  return { ...result, ...callbacks };
}
const transfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
function drag(source: Element, target: Element) {
  const dataTransfer = transfer(); fireEvent.dragStart(source, { dataTransfer }); fireEvent.dragOver(target, { dataTransfer }); fireEvent.drop(target, { dataTransfer });
}

describe("直接操牌", () => {
  it("能量拖向宝可梦一次表达附着意图，正常点击仍只查看详情", () => {
    const result = table();
    const energy = screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成能量/ });
    fireEvent.click(energy);
    expect(result.onInspect).toHaveBeenCalledOnce(); expect(result.onSelect).not.toHaveBeenCalled();
    drag(energy, result.container.querySelector('[data-position-key="A:bench/0"]')!);
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "attach", source: { zoneId: "A:hand", index: 0 }, target: { zoneId: "A:bench", index: 0 } });
  });
  it("原生连续事件在拖动状态尚未绘制时也允许合法落点", () => {
    const result = table();
    const source = screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成能量/ });
    const target = result.container.querySelector('[data-position-key="A:active/0"]')!;
    const dataTransfer = transfer();
    act(() => {
      fireEvent.dragStart(source, { dataTransfer });
      fireEvent.dragOver(target, { dataTransfer });
      expect(dataTransfer.dropEffect).toBe("move");
    });
    fireEvent.drop(target, { dataTransfer });
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "attach", source: { zoneId: "A:hand", index: 0 }, target: { zoneId: "A:active", index: 0 } });
  });
  it("撤退首次进入指定备战目标即可放下，无需等待下一次移动", () => {
    const result = table(), dataTransfer = transfer();
    const source = screen.getByRole("button", { name: /查看A.*战斗场 第 1 位卡牌组/ });
    const target = result.container.querySelector('[data-position-key="A:bench/0"]')!;
    act(() => {
      fireEvent.dragStart(source, { dataTransfer });
      expect(fireEvent.dragEnter(target, { dataTransfer })).toBe(false);
      expect(dataTransfer.dropEffect).toBe("move");
      fireEvent.drop(target, { dataTransfer });
    });
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "retreat", source: { zoneId: "A:active", index: 0 }, target: { zoneId: "A:bench", index: 0 } });
  });
  it("牌桌不常驻招式和特性按钮，点击宝可梦只请求展开", () => {
    const result = table();
    expect(screen.queryByRole("button", { name: "使用招式撞击" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /查看A.*战斗场 第 1 位卡牌组/ }));
    expect(result.onInspect).toHaveBeenCalledOnce();
    expect(result.onIntent).not.toHaveBeenCalled();
  });
  it("多行动与长附着共存时，牌桌只显示状态和完整数量", () => {
    const current = tabletop(), source = current.zones.find((zone) => zone.id === "A:active")!.items[0] as GroupView;
    const top = source.stack[0]; if (top?.kind !== "card" || top.card.kind !== "pokemon") throw new Error("fixture");
    top.card.abilities = [{ name: "合成主动特性", text: "合成效果" }];
    top.card.attacks.push({ ...top.card.attacks[0]!, name: "合成第二招式" });
    source.state.specialConditions = ["poisoned", "burned", "confused"];
    source.attached = [0, 1].map((index) => ({ kind: "card", position: { ...source.position, member: { relation: "attached", index } }, ownerId: "A", markers: {}, card: { kind: "energy", subtype: "special", name: "合成超长附着名称与版本识别信息", text: "合成说明" } }));
    const result = table({ view: current }), panel = result.container.querySelector('[data-position-key="A:active/0"]')! as HTMLElement;
    expect(within(panel).getByTitle("合成超长附着名称与版本识别信息 2 张")).toHaveTextContent("×2");
    expect(within(panel).queryByRole("button", { name: /使用招式|使用特性/ })).toBeNull();
  });
  it("训练家拖向桌面表达使用，不创建新的玩法区域", () => {
    const current = tabletop(); const source = current.zones[0]!.items[0]!;
    if (source.kind !== "card") throw new Error("fixture");
    source.card = { kind: "trainer", subtype: "item", name: "合成检索", text: "合成效果" };
    const result = table({ view: current });
    drag(screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成检索/ }), screen.getByLabelText("对战牌桌"));
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "play", source: { zoneId: "A:hand", index: 0 } });
    expect(result.container.querySelector('[data-zone-id$=":staging"]')).toBeNull();
  });
  it("连续原生事件无需等待高亮绘制即可在桌面使用训练家", () => {
    const current = tabletop(), object = current.zones[0]!.items[0]!;
    if (object.kind !== "card") throw new Error("fixture");
    object.card = { kind: "trainer", subtype: "item", name: "合成检索", text: "合成效果" };
    const result = table({ view: current });
    const source = screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成检索/ });
    const target = screen.getByLabelText("对战牌桌"), dataTransfer = transfer();
    dataTransfer.dropEffect = "none";
    act(() => {
      fireEvent.dragStart(source, { dataTransfer });
      expect(fireEvent.dragOver(target, { dataTransfer })).toBe(false);
      expect(dataTransfer.dropEffect).toBe("move");
      fireEvent.drop(target, { dataTransfer });
    });
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "play", source: { zoneId: "A:hand", index: 0 } });
  });
  it("能量未指定宝可梦时，桌面中央不显示可放置状态", () => {
    const result = table(), dataTransfer = transfer();
    dataTransfer.dropEffect = "none";
    fireEvent.dragStart(screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成能量/ }), { dataTransfer });
    const target = screen.getByLabelText("对战牌桌");
    expect(fireEvent.dragEnter(target, { dataTransfer })).toBe(true);
    expect(fireEvent.dragOver(target, { dataTransfer })).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
    expect(result.onIntent).not.toHaveBeenCalled();
  });
  it("训练家首次进入中央使用区即可放下", () => {
    const current = tabletop(), object = current.zones[0]!.items[0]!;
    if (object.kind !== "card") throw new Error("fixture");
    object.card = { kind: "trainer", subtype: "item", name: "合成检索", text: "合成效果" };
    const result = table({ view: current }), dataTransfer = transfer();
    const source = screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成检索/ });
    const target = screen.getByLabelText("对战牌桌");
    act(() => {
      fireEvent.dragStart(source, { dataTransfer });
      expect(fireEvent.dragEnter(target, { dataTransfer })).toBe(false);
      expect(dataTransfer.dropEffect).toBe("move");
      fireEvent.drop(target, { dataTransfer });
    });
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "play", source: { zoneId: "A:hand", index: 0 } });
  });
  it("键盘提起、放下与取消等价于拖拽，不替玩家选择目标", () => {
    const result = table();
    const energy = screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成能量/ });
    fireEvent.keyDown(energy, { key: " " });
    expect(energy).toHaveAttribute("aria-grabbed", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(energy).toHaveAttribute("aria-grabbed", "false");
    expect(result.onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(energy, { key: " " });
    fireEvent.keyDown(screen.getByRole("button", { name: /查看A.*备战区 第 1 位卡牌组/ }), { key: "Enter" });
    expect(result.onIntent).toHaveBeenCalledOnce();
  });
  it("只读及执行中锁定普通行动，基本宝可梦误投到卡牌组不变成进化", () => {
    const result = table({ humanActionBusy: true });
    expect(screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成能量/ })).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: "使用招式撞击" })).toBeNull();
    result.rerender(<MatchTable view={tabletop()} viewer="A" selected={[]} highlighted={[]} interactive onSelect={result.onSelect} onInspect={result.onInspect} onPreview={result.onPreview} onDestination={result.onDestination} onIntent={result.onIntent} />);
    drag(screen.getByRole("button", { name: /查看A.*手牌 第 2 位叶芽/ }), result.container.querySelector('[data-position-key="A:bench/0"]')!);
    expect(result.onIntent).not.toHaveBeenCalled(); expect(screen.getByRole("status")).toHaveTextContent("未识别的落点");
  });
  it("手动调整复用拖动并显式调整伤害，不发送新的代理意图", () => {
    const onManualMove = vi.fn(), onManualState = vi.fn(), onIntent = vi.fn();
    function ManualHarness() {
      const [selected, setSelected] = useState<Position[]>([]);
      return <div className="table-column"><MatchTable view={tabletop()} viewer="A" selected={selected} highlighted={[]} interactive manualMode
        onSelect={(position) => setSelected([position])} onInspect={vi.fn()} onPreview={vi.fn()} onDestination={vi.fn()}
        onIntent={onIntent} onManualMove={onManualMove} onManualState={onManualState} /></div>;
    }
    const result = render(<ManualHarness />);
    drag(screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成能量/ }), result.container.querySelector('[data-position-key="A:bench/0"]')!);
    expect(onManualMove).toHaveBeenCalledExactlyOnceWith({ zoneId: "A:hand", index: 0 }, { zoneId: "A:bench", index: 0 });
    expect(screen.queryByRole("button", { name: "叶芽增加10伤害" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看A.*战斗场 第 1 位卡牌组/ }));
    const toolbar = screen.getByRole("region", { name: /A.*战斗场.*叶芽状态调整/ });
    expect(toolbar.parentElement).toHaveClass("table-column");
    expect(result.container.querySelector(".group-object .manual-state-toolbar")).toBeNull();
    fireEvent.click(within(toolbar).getByRole("button", { name: "叶芽增加10伤害" }));
    expect(onManualState).toHaveBeenCalledWith({ zoneId: "A:active", index: 0 }, { key: "damageCounters", value: 3 });
    fireEvent.click(screen.getByRole("button", { name: /查看B.*战斗场 第 1 位卡牌组/ }));
    expect(screen.queryByRole("region", { name: /A.*战斗场.*叶芽状态调整/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /B.*战斗场.*叶芽状态调整/ })).toBeInTheDocument();
    expect(onIntent).not.toHaveBeenCalled();
  });
  it("手动状态提交只禁用工具条，更新后保留同一控件和焦点，可连续调整", () => {
    let current = tabletop();
    const onManualState = vi.fn(), selected = [{ zoneId: "A:active", index: 0 }];
    const callbacks = { onSelect: vi.fn(), onInspect: vi.fn(), onPreview: vi.fn(), onDestination: vi.fn(), onIntent: vi.fn(), onManualState };
    const content = (busy: boolean) => <div className="table-column"><MatchTable view={current} viewer="A" selected={selected} highlighted={[]} interactive={!busy} humanActionBusy={busy} manualMode {...callbacks} /></div>;
    const result = render(content(false));
    const toolbar = screen.getByRole("region", { name: /A.*战斗场.*叶芽状态调整/ });
    const increase = within(toolbar).getByRole("button", { name: "叶芽增加10伤害" });
    act(() => increase.focus());
    fireEvent.click(increase);
    expect(onManualState).toHaveBeenLastCalledWith(selected[0], { key: "damageCounters", value: 3 });
    result.rerender(content(true));
    expect(screen.getByRole("region", { name: /A.*战斗场.*叶芽状态调整/ })).toBe(toolbar);
    expect(increase).toBeDisabled();
    expect(within(toolbar).getByRole("combobox")).toBeDisabled();
    // Chrome 会在原生控件变为 disabled 后将焦点退到 BODY。
    act(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); });
    expect(document.activeElement).toBe(document.body);
    current = structuredClone(current); current.revision++;
    (current.zones.find((zone) => zone.id === "A:active")!.items[0] as GroupView).state.damageCounters = 3;
    result.rerender(content(false));
    expect(within(toolbar).getByRole("button", { name: "叶芽增加10伤害" })).toBe(increase);
    expect(increase).toBeEnabled();
    expect(document.activeElement).toBe(increase);
    fireEvent.click(increase);
    expect(onManualState).toHaveBeenLastCalledWith(selected[0], { key: "damageCounters", value: 4 });
    expect(within(toolbar).getByText("30")).toBeInTheDocument();
  });
  it("手动提交期间转移到记录区后，工具条恢复不会抢回焦点", () => {
    const current = tabletop(), selected = [{ zoneId: "A:active", index: 0 }];
    const callbacks = { onSelect: vi.fn(), onInspect: vi.fn(), onPreview: vi.fn(), onDestination: vi.fn(), onIntent: vi.fn(), onManualState: vi.fn() };
    const content = (busy: boolean) => <><div className="table-column"><MatchTable view={current} viewer="A" selected={selected} highlighted={[]} interactive={!busy} humanActionBusy={busy} manualMode {...callbacks} /></div><button>查看记录</button></>;
    const result = render(content(false));
    const control = screen.getByRole("combobox", { name: "叶芽调整特殊状态" });
    act(() => control.focus());
    result.rerender(content(true));
    act(() => screen.getByRole("button", { name: "查看记录" }).focus());
    result.rerender(content(false));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看记录" }));
    expect(screen.getByRole("combobox", { name: "叶芽调整特殊状态" })).toBe(control);
  });
  it("交权时从备战拖到空战斗明确选择替补，普通回合不允许免费升前场", () => {
    const current = tabletop(); current.zones.find((zone) => zone.id === "A:active")!.items[0] = null;
    const result = table({ view: current });
    const reserve = screen.getByRole("button", { name: /查看A.*备战区 第 1 位卡牌组/ });
    expect(reserve).toHaveAttribute("draggable", "false");
    drag(reserve, screen.getByRole("button", { name: /战斗场第1位作为目标/ }));
    expect(result.onIntent).not.toHaveBeenCalled();
    current.flow.choice = { kind: "handoff", playerId: "A", message: "选择替补" }; current.flow.turnOwner = "B";
    result.rerender(<MatchTable view={current} viewer="A" selected={[]} highlighted={[]} interactive onSelect={result.onSelect} onInspect={result.onInspect} onPreview={result.onPreview} onDestination={result.onDestination} onIntent={result.onIntent} />);
    expect(screen.getByRole("button", { name: /查看A.*手牌 第 1 位合成能量/ })).toHaveAttribute("draggable", "false");
    drag(screen.getByRole("button", { name: /查看A.*备战区 第 1 位卡牌组/ }), screen.getByRole("button", { name: /战斗场第1位作为目标/ }));
    expect(result.onIntent).toHaveBeenCalledExactlyOnceWith({ kind: "resolve_handoff", source: { zoneId: "A:bench", index: 0 }, target: { zoneId: "A:active", index: 0 } });
  });
  it("普通备战本体与弃牌不显示无效拖动暗示，备战特性和手动移动仍可操作", () => {
    const current = tabletop(); const group = current.zones.find((zone) => zone.id === "A:bench")!.items[0] as GroupView;
    const top = group.stack[0]; if (top?.kind !== "card" || top.card.kind !== "pokemon") throw new Error("fixture");
    top.card.abilities = [{ name: "合成特性", text: "合成效果" }];
    current.zones.push({ id: "A:discard", kind: "discard", playerId: "A", layout: "sequence", defaultVisibility: { mode: "public" }, items: [{ ...top, position: { zoneId: "A:discard", index: 0 } }] });
    const result = table({ view: current });
    expect(screen.getByRole("button", { name: /查看A.*备战区 第 1 位卡牌组/ })).toHaveAttribute("draggable", "false");
    expect(screen.getByRole("button", { name: /查看A.*弃牌区 第 1 位叶芽/ })).toHaveAttribute("draggable", "false");
    fireEvent.click(screen.getByRole("button", { name: /查看A.*备战区 第 1 位卡牌组/ }));
    expect(result.onInspect).toHaveBeenCalledOnce();
    result.rerender(<MatchTable view={current} viewer="A" selected={[]} highlighted={[]} interactive manualMode onSelect={result.onSelect} onInspect={result.onInspect} onPreview={result.onPreview} onDestination={result.onDestination} onIntent={result.onIntent} onManualMove={result.onManualMove} />);
    expect(screen.getByRole("button", { name: /查看A.*弃牌区 第 1 位叶芽/ })).toHaveAttribute("draggable", "true");
  });
});

function dock(action: HumanActionView, manualMode = false) {
  const onAnswer = vi.fn(async () => {}), onControl = vi.fn(async () => {}), onManualMode = vi.fn();
  const rendered = render(<><div className="table-column" /><HumanActionDock action={action} busy={false} enabled onEndTurn={vi.fn()} onAnswer={onAnswer} onControl={onControl} manualMode={manualMode} onManualMode={onManualMode} /></>);
  return { ...rendered, onAnswer, onControl, onManualMode };
}
const action: HumanActionView = { id: "action", playerId: "A", intent: { kind: "end_turn" }, label: "合成行动", status: "awaiting_choice", revision: 1, eventIds: [], choice: {
  id: "choice", title: "选择卡牌", kind: "select", minimum: 1, maximum: 1,
  options: [{ id: "a", label: "候选甲", card: card as CardData }, { id: "b", label: "候选乙" }],
} };
describe("人类选择", () => {
  it("同名宝可梦显示真实战斗场与备战槽位，确认仍提交独立选项ID", () => {
    const current = structuredClone(action);
    current.choice!.options = [
      { id: "active", label: card.name, card, position: { zoneId: "B:active", index: 0 } },
      { id: "bench", label: card.name, card, position: { zoneId: "B:bench", index: 4 } },
      { id: "own", label: card.name, card, position: { zoneId: "A:bench", index: 2 } },
      { id: "skip", label: "不选择" },
    ];
    const result = dock(current);
    expect(screen.getByRole("button", { name: `${card.name}，对方战斗场` })).toHaveTextContent("对方战斗场");
    const bench = screen.getByRole("button", { name: `${card.name}，对方备战区 · 第 5 位` });
    expect(bench).toHaveTextContent("对方备战区 · 第 5 位");
    expect(screen.getByRole("button", { name: `${card.name}，自己备战区 · 第 3 位` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "不选择" }).querySelector(".choice-option-location")).toBeNull();
    fireEvent.click(bench);
    expect(screen.getByRole("button", { name: `${card.name}，对方战斗场` })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(result.onAnswer).toHaveBeenCalledExactlyOnceWith({ choiceId: "choice", selected: ["bench"] });
  });
  it("位置跟随实际选择席位，排序结果保留同名卡的位置且不补出隐藏卡面", () => {
    const current = structuredClone(action); current.playerId = "B";
    current.choice = { ...current.choice!, kind: "order", minimum: 2, maximum: 2, options: [
      { id: "attached", label: "卡牌", position: { zoneId: "B:bench", index: 4, member: { relation: "attached", index: 1 } } },
      { id: "hand", label: "卡牌", position: { zoneId: "A:hand", index: 2 } },
    ] };
    const result = dock(current);
    const attached = screen.getByRole("button", { name: "卡牌，自己备战区 · 第 5 位 · 附着 2" });
    expect(attached.querySelector(".card-face")).toBeNull();
    fireEvent.click(attached);
    fireEvent.click(screen.getByRole("button", { name: "卡牌，对方手牌 · 第 3 位" }));
    const ordered = within(screen.getByRole("list", { name: "已选顺序" }));
    expect(ordered.getAllByRole("listitem")[0]).toHaveTextContent("自己备战区 · 第 5 位 · 附着 2");
    expect(ordered.getAllByRole("listitem")[1]).toHaveTextContent("对方手牌 · 第 3 位");
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(result.onAnswer).toHaveBeenCalledExactlyOnceWith({ choiceId: "choice", selected: ["attached", "hand"] });
  });
  it("Esc取消选择后，BODY不会成为恢复目标，焦点回到稳定更多入口", async () => {
    function FocusHarness() {
      const [current, setCurrent] = useState<HumanActionView>(structuredClone(action));
      return <><div className="table-column" /><HumanActionDock action={current} busy={false} enabled onEndTurn={vi.fn()} onAnswer={vi.fn(async () => {})}
        onControl={async () => setCurrent({ ...current, status: "cancelled", choice: undefined })} manualMode={false} onManualMode={vi.fn()} /></>;
    }
    render(<FocusHarness />);
    const option = screen.getByRole("button", { name: "候选甲" });
    expect(document.activeElement).toBe(option);
    fireEvent.keyDown(option, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("行动更多操作")));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("确认后旧触发元素已卸载时恢复到Dock，连续选择优先聚焦新选项", async () => {
    function FocusHarness() {
      const [current, setCurrent] = useState<HumanActionView | null>(null);
      return <>{!current && <button onClick={() => setCurrent(structuredClone(action))}>发起行动</button>}<div className="table-column" />
        <HumanActionDock action={current} busy={false} enabled onEndTurn={vi.fn()} manualMode={false} onManualMode={vi.fn()} onControl={vi.fn(async () => {})}
          onAnswer={async () => setCurrent(current?.choice?.id === "choice" ? { ...current, choice: { ...current.choice!, id: "next-choice", title: "继续选择", options: [{ id: "next", label: "下一项" }] } } : { ...current!, status: "completed", choice: undefined })} />
      </>;
    }
    render(<FocusHarness />);
    const opener = screen.getByRole("button", { name: "发起行动" }); opener.focus(); fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "候选甲" })); fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "下一项" })));
    fireEvent.click(screen.getByRole("button", { name: "下一项" })); fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("行动更多操作")));
  });
  it("非模态选择关闭时不夺回用户已转到记录区的焦点", async () => {
    function FocusHarness() {
      const [current, setCurrent] = useState<HumanActionView>(structuredClone(action));
      return <><button onClick={() => setCurrent({ ...current, status: "completed", choice: undefined })}>查看记录</button><div className="table-column" />
        <HumanActionDock action={current} busy={false} enabled onEndTurn={vi.fn()} onAnswer={vi.fn(async () => {})} onControl={vi.fn(async () => {})} manualMode={false} onManualMode={vi.fn()} /></>;
    }
    render(<FocusHarness />);
    const record = screen.getByRole("button", { name: "查看记录" }); record.focus(); fireEvent.click(record);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(record);
  });
  it("不默认选牌，用户确认后才提交所选项", async () => {
    const result = dock(structuredClone(action));
    expect(screen.getByRole("button", { name: "确认选择" })).toBeDisabled();
    expect(result.onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "候选甲" }));
    expect(result.onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(result.onAnswer).toHaveBeenCalledExactlyOnceWith({ choiceId: "choice", selected: ["a"] });
  });
  it("数量必须明确输入，不自动采用最小值", () => {
    const current = structuredClone(action); current.choice = { ...current.choice!, kind: "number", minimum: 0, maximum: 3, options: [] };
    const result = dock(current);
    expect(screen.getByRole("button", { name: "确认选择" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("选择数量"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
    expect(result.onAnswer).toHaveBeenCalledExactlyOnceWith({ choiceId: "choice", selected: [], number: 2 });
  });
  it("错误时先提供代理修正，手动调整在更多操作里", () => {
    const result = dock({ ...action, choice: undefined, status: "failed", error: "合成失败" });
    fireEvent.click(screen.getByRole("button", { name: "代理修正" }));
    expect(result.onControl).toHaveBeenCalledWith("retry"); expect(result.onManualMode).not.toHaveBeenCalled();
  });
  it("停止的行动可以在手动调整后交回代理，已完成行动只允许复核", () => {
    const result = dock({ ...action, choice: undefined, status: "cancelled" }, true);
    fireEvent.click(screen.getByLabelText("行动更多操作"));
    fireEvent.click(screen.getByRole("button", { name: "继续原行动" }));
    expect(result.onManualMode).toHaveBeenCalledExactlyOnceWith(false);
    expect(result.onControl).toHaveBeenCalledExactlyOnceWith("retry");
    result.rerender(<><div className="table-column" /><HumanActionDock action={{ ...action, choice: undefined, status: "completed" }} busy={false} enabled onEndTurn={vi.fn()} onAnswer={result.onAnswer} onControl={result.onControl} manualMode={false} onManualMode={result.onManualMode} /></>);
    expect(screen.queryByRole("button", { name: "继续原行动" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代理复核" })).toBeInTheDocument();
    expect(result.onControl).toHaveBeenCalledOnce();
  });
  it("主动停止显示保留的成功步骤，不沿用此前错误标题", () => {
    dock({ ...action, choice: undefined, status: "cancelled", eventIds: ["event-1", "event-2"], error: "旧网络超时" });
    expect(screen.getByRole("status")).toHaveTextContent("已停止 · 保留 2 步");
    expect(screen.getByRole("status")).toHaveAttribute("title", action.label);
    expect(screen.queryByText("旧网络超时")).not.toBeInTheDocument();
  });
  it("临时交权显示继续处理而非结束回合", () => {
    const onEndTurn = vi.fn();
    render(<HumanActionDock action={null} busy={false} enabled handoff onEndTurn={onEndTurn} onAnswer={vi.fn(async () => {})} onControl={vi.fn(async () => {})} manualMode={false} onManualMode={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "结束回合" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续处理" }));
    expect(onEndTurn).toHaveBeenCalledOnce();
  });
});

function preparation(additional = false): MatchView {
  const current = tabletop();
  current.flow.phase = "setup";
  current.zones.find((zone) => zone.id === "A:active")!.items[0] = null;
  if (!additional) current.zones.find((zone) => zone.id === "A:bench")!.items[0] = null;
  current.zones[0]!.items = [0, 1].map((index) => ({ kind: "card", card, ownerId: "A", markers: {}, position: { zoneId: "A:hand", index } }));
  current.flow.choice = { kind: additional ? "additional_bench" : "initial_placement", playerId: "A", eligible: additional ? [{ zoneId: "A:hand", index: 1 }] : [{ zoneId: "A:hand", index: 0 }, { zoneId: "A:hand", index: 1 }], maximum: 5 };
  return current;
}
function SetupHarness({ current, submit }: { current: MatchView; submit: (placement: SetupPlacement) => void }) {
  const [placement, setPlacement] = useState<SetupPlacement>({ bench: [], benchSlots: [] });
  return <><SetupPlacementBar view={current} placement={placement} busy={false} onConfirm={() => submit(placement)} onClear={() => setPlacement({ bench: [], benchSlots: [] })} />
    <MatchTable view={current} viewer="A" selected={[]} highlighted={[]} interactive={false} onSelect={() => {}} onInspect={() => {}} onPreview={() => {}} onDestination={() => {}} onIntent={vi.fn()} setupPlacement={placement} onSetupPlacement={setPlacement} /></>;
}
describe("开局直接摆牌", () => {
  it("键盘落牌焦点跟随新ghost、换槽和回手，不增加任何选择", () => {
    const submit = vi.fn(); const { container } = render(<SetupHarness current={preparation()} submit={submit} />);
    const hand = screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ });
    const activeSlot = within(screen.getByRole("region", { name: "A战斗场" })).getByRole("button", { name: /战斗场第1位/ });
    hand.focus(); fireEvent.keyDown(hand, { key: " " }); activeSlot.focus(); fireEvent.keyDown(activeSlot, { key: "Enter" });
    const activeGhost = within(container.querySelector<HTMLElement>('[data-displayed-position="A:active/0"]')!).getByRole("button");
    expect(document.activeElement).toBe(activeGhost);
    fireEvent.keyDown(activeGhost, { key: " " });
    const benchSlot = screen.getByRole("button", { name: /备战区第5位作为目标/ }); benchSlot.focus(); fireEvent.keyDown(benchSlot, { key: "Enter" });
    const benchGhost = within(container.querySelector<HTMLElement>('[data-displayed-position="A:bench/4"]')!).getByRole("button");
    expect(document.activeElement).toBe(benchGhost);
    expect(container.querySelector('[data-displayed-position="A:active/0"]')).toBeNull();
    fireEvent.keyDown(benchGhost, { key: " " }); fireEvent.keyDown(benchGhost, { key: "Escape" });
    expect(document.activeElement).toBe(benchGhost);
    expect(benchGhost).toHaveAttribute("aria-grabbed", "false");
    fireEvent.keyDown(benchGhost, { key: " " });
    const otherHandCard = screen.getByRole("button", { name: /查看A.*手牌 第 2 位叶芽/ }); otherHandCard.focus(); fireEvent.keyDown(otherHandCard, { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ }));
    expect(container.querySelector(".setup-ghost")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
  it("键盘替换战斗宝可梦后跟随新牌，原生拖拽不抢焦点", () => {
    const { container } = render(<><button>保持焦点</button><SetupHarness current={preparation()} submit={vi.fn()} /></>);
    const first = screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ });
    const activeSlot = within(screen.getByRole("region", { name: "A战斗场" })).getByRole("button", { name: /战斗场第1位/ });
    const outside = screen.getByRole("button", { name: "保持焦点" }); outside.focus();
    drag(first, activeSlot);
    expect(document.activeElement).toBe(outside);
    const second = screen.getByRole("button", { name: /查看A.*手牌 第 2 位叶芽/ }); second.focus(); fireEvent.keyDown(second, { key: " " });
    const oldGhost = within(container.querySelector<HTMLElement>('[data-displayed-position="A:active/0"]')!).getByRole("button"); oldGhost.focus(); fireEvent.keyDown(oldGhost, { key: "Enter" });
    const newGhost = container.querySelector<HTMLElement>('[data-displayed-position="A:active/0"]')!;
    expect(newGhost).toHaveAttribute("data-draft-source", "A:hand/1");
    expect(document.activeElement).toBe(within(newGhost).getByRole("button"));
    expect(screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ })).toBeInTheDocument();
  });
  it("保留明确的战斗与第5备战槽位，只在准备完成时提交原始来源", () => {
    const current = preparation(), submit = vi.fn();
    const { container } = render(<SetupHarness current={current} submit={submit} />);
    expect(screen.getByRole("button", { name: "准备完成" })).toBeDisabled();
    drag(screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ }), within(screen.getByRole("region", { name: "A战斗场" })).getByRole("button", { name: /战斗场第1位/ }));
    expect(current.zones.find((zone) => zone.id === "A:active")!.items[0]).toBeNull();
    expect(container.querySelector('[data-displayed-position="A:active/0"]')).toHaveAttribute("data-draft-source", "A:hand/0");
    expect(container.querySelector('[data-displayed-position="A:active/0"]')).not.toHaveAttribute("data-position-key");
    drag(screen.getByRole("button", { name: /查看A.*手牌 第 2 位叶芽/ }), screen.getByRole("button", { name: /备战区第5位作为目标/ }));
    expect(container.querySelector('[data-displayed-position="A:bench/4"]')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备完成" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({ active: { zoneId: "A:hand", index: 0 }, bench: [{ zoneId: "A:hand", index: 1 }], benchSlots: [4] });
  });
  it("草稿可以拖回手牌，不自动填补战斗位", () => {
    const { container } = render(<SetupHarness current={preparation()} submit={vi.fn()} />);
    drag(screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ }), within(screen.getByRole("region", { name: "A战斗场" })).getByRole("button", { name: /战斗场第1位/ }));
    drag(within(container.querySelector<HTMLElement>('[data-displayed-position="A:active/0"]')!).getByRole("button"), screen.getByRole("region", { name: "A手牌" }));
    expect(container.querySelector(".setup-ghost")).toBeNull();
    expect(screen.getByRole("button", { name: "准备完成" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ })).toBeInTheDocument();
  });
  it("追加备战只允许本次获授权的手牌，保留已有场上宝可梦", () => {
    const submit = vi.fn(); const { container } = render(<SetupHarness current={preparation(true)} submit={submit} />);
    expect(screen.getByRole("button", { name: /查看A.*手牌 第 1 位叶芽/ })).toHaveAttribute("draggable", "false");
    expect(screen.getByRole("button", { name: /查看A.*备战区 第 1 位卡牌组/ })).toHaveAttribute("draggable", "false");
    drag(screen.getByRole("button", { name: /查看A.*手牌 第 2 位叶芽/ }), screen.getByRole("button", { name: /备战区第5位作为目标/ }));
    expect(container.querySelector('[data-displayed-position="A:bench/4"]')).toBeInTheDocument();
    expect(container.querySelector('[data-displayed-position="A:active/0"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "准备完成" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({ bench: [{ zoneId: "A:hand", index: 1 }], benchSlots: [4] });
  });
});
