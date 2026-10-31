import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  Json,
  MatchView,
  PublicEvent,
  TableView,
} from "../../../packages/protocol/src/index.ts";
import { MatchHistory } from "../src/MatchHistory.tsx";
import { presentEvent } from "../src/event-presentation.ts";
import { card, view } from "./fixtures.ts";

const json = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;
function recorded(
  sequence: number,
  command: unknown,
  table?: TableView,
  extra: Record<string, unknown> = {},
): PublicEvent {
  return {
    id: `event-${sequence}`,
    sequence,
    revision: sequence,
    at: "2026-10-29T03:00:00.000Z",
    actor: "A",
    commandKind: String((command as { kind: string }).kind),
    label: String((command as { kind: string }).kind),
    data: json({ command, ...(table ? { table } : {}), ...extra }),
  };
}
function props(value: MatchView) {
  return {
    view: value,
    canObject: true,
    debug: true,
    onObject: vi.fn(),
    onRestore: vi.fn(),
    onLocate: vi.fn(),
  };
}

describe("历史动作的中文呈现", () => {
  it("附着描述使用历史牌名并定位目标，不再定位已移出的手牌", () => {
    const previous = recorded(1, { kind: "declare", text: "准备附着" }, view);
    const next = structuredClone(view);
    const source = next.zones
      .find((zone) => zone.id === "A:hand")!
      .items.shift()!;
    const target = next.zones.find((zone) => zone.id === "A:bench")!.items[0]!;
    if (target.kind !== "group") throw new Error("fixture");
    if (source.kind === "group") throw new Error("fixture");
    target.attached.push({
      ...source,
      position: {
        zoneId: "A:bench",
        index: 0,
        member: { relation: "attached", index: 0 },
      },
    });
    const event = recorded(
      2,
      {
        kind: "move",
        source: {
          container: { kind: "zone", zoneId: "A:hand" },
          range: { mode: "indices", indices: [0] },
        },
        destination: {
          container: {
            kind: "group",
            position: { zoneId: "A:bench", index: 0 },
            relation: "attached",
          },
          index: 0,
        },
      },
      next,
      { result: { count: 1 } },
    );
    expect(presentEvent(event, previous)).toMatchObject({
      title: "将叶芽附着给叶芽",
      detail: "来自A 的手牌",
      positions: [
        {
          zoneId: "A:bench",
          index: 0,
          member: { relation: "attached", index: 0 },
        },
      ],
    });
  });
  it("末尾移动使用执行结果中的真实目标下标，定位多张牌而不回退到开头", () => {
    const event = recorded(2, {
      kind: "move",
      source: { container: { kind: "zone", zoneId: "A:discard" }, range: { mode: "indices", indices: [0, 1] } },
      destination: { container: { kind: "zone", zoneId: "A:deck" }, index: "end" },
    }, undefined, { result: { count: 2, destinationIndex: 5 } });
    expect(presentEvent(event)).toMatchObject({
      title: "从A 的弃牌区移入A 的牌库 2 张牌",
      positions: [{ zoneId: "A:deck", index: 5 }, { zoneId: "A:deck", index: 6 }],
    });
  });
  it("组内末尾移动优先实际下标，旧数字移动继续沿用请求下标", () => {
    const command = {
      kind: "move",
      source: { container: { kind: "zone", zoneId: "A:discard" }, range: { mode: "indices", indices: [0] } },
      destination: { container: { kind: "group", position: { zoneId: "A:bench", index: 1 }, relation: "attached" }, index: 3 },
    };
    const expected = (index: number) => [{ zoneId: "A:bench", index: 1, member: { relation: "attached", index } }];
    expect(presentEvent(recorded(2, command, undefined, { result: { count: 1, destinationIndex: 2 } })).positions).toEqual(expected(2));
    expect(presentEvent(recorded(2, command, undefined, { result: { count: 1 } })).positions).toEqual(expected(3));
    expect(presentEvent(recorded(2, { ...command, destination: { ...command.destination, index: "end" } }, undefined, { result: { count: 1, destinationIndex: 4 } })).positions).toEqual(expected(4));
  });
  it("伤害使用前后累计点数，不推断有效剩余HP", () => {
    const next = structuredClone(view);
    const group = next.zones.find((zone) => zone.kind === "bench")!.items[0]!;
    if (group.kind !== "group") throw new Error("fixture");
    group.state.damageCounters = 4;
    const event = recorded(
      2,
      {
        kind: "set_state",
        target: { kind: "group", position: { zoneId: "A:bench", index: 0 } },
        field: { key: "damageCounters", value: 4 },
      },
      next,
    );
    expect(
      presentEvent(event, recorded(1, { kind: "declare" }, view)).title,
    ).toBe("叶芽累计伤害：20 → 40");
  });
  it("旧记录没有可读牌面时，不从当前全知牌桌补入未来牌名", () => {
    const hidden = structuredClone(view);
    hidden.zones.forEach((zone) => {
      zone.items = zone.items.map((item, index) =>
        item ? { kind: "hidden", position: { zoneId: zone.id, index } } : null,
      );
    });
    const event = recorded(
      2,
      {
        kind: "move",
        source: {
          container: { kind: "zone", zoneId: "A:deck" },
          range: { mode: "range", start: 0, count: 1 },
        },
        destination: {
          container: { kind: "zone", zoneId: "A:hand" },
          index: 0,
        },
      },
      hidden,
      { result: { count: 1 } },
    );
    const result = presentEvent(
      event,
      recorded(1, { kind: "declare" }, hidden),
    );
    expect(result.title).toBe("从A 的牌库抽取 1 张牌");
    expect(result.detail).toBeUndefined();
    render(
      <MatchHistory
        {...props({ ...view, viewer: "omniscient", events: [event] })}
      />,
    );
    expect(screen.queryByText(card.name)).not.toBeInTheDocument();
  });
  it("只修正序列中因移出而前移的组下标，槽位保持原下标", () => {
    for (const layout of ["sequence", "slots"] as const) {
      const before = structuredClone(view),
        after = structuredClone(view);
      const group = before.zones.find((zone) => zone.kind === "bench")!
        .items[0]!;
      const item = before.zones.find((zone) => zone.kind === "hand")!.items[0]!;
      const zoneBefore = before.zones.find((zone) => zone.kind === "hand")!;
      zoneBefore.layout = layout;
      zoneBefore.items = [
        item,
        { ...group, position: { zoneId: "A:hand", index: 1 } },
      ];
      const zoneAfter = after.zones.find((zone) => zone.kind === "hand")!;
      zoneAfter.layout = layout;
      const targetIndex = layout === "sequence" ? 0 : 1;
      zoneAfter.items =
        layout === "sequence"
          ? [{ ...group, position: { zoneId: "A:hand", index: 0 } }]
          : [null, zoneBefore.items[1]!];
      const event = recorded(
        2,
        {
          kind: "move",
          source: {
            container: { kind: "zone", zoneId: "A:hand" },
            range: { mode: "indices", indices: [0] },
          },
          destination: {
            container: {
              kind: "group",
              position: { zoneId: "A:hand", index: 1 },
              relation: "attached",
            },
            index: 0,
          },
        },
        after,
        { result: { count: 1 } },
      );
      expect(
        presentEvent(event, recorded(1, { kind: "declare" }, before))
          .positions[0]?.index,
      ).toBe(targetIndex);
    }
  });
  it("流程、硬币与未知旧事件都有中文安全回退", () => {
    expect(
      presentEvent(
        recorded(1, { kind: "random", mode: "coins" }, view, {
          result: { coins: ["heads", "tails"] },
        }),
      ),
    ).toMatchObject({ title: "投掷硬币 2 次", detail: "正面、反面" });
    expect(
      presentEvent(
        recorded(1, { kind: "set_turn", phase: "check", playerId: null }, view),
      ).title,
    ).toBe("进入宝可梦检查");
    expect(presentEvent(recorded(1, { kind: "future_command" })).title).toBe(
      "对局操作已记录",
    );
  });
});

describe("记录面板交互", () => {
  it("最新记录在上，动作差异仍使用时间顺序中的上一条记录", () => {
    const after = structuredClone(view);
    const group = after.zones.find((zone) => zone.kind === "bench")!.items[0]!;
    if (group.kind !== "group") throw new Error("fixture");
    group.state.damageCounters = 4;
    const first = recorded(1, { kind: "declare", text: "第一条" }, view);
    const second = recorded(2, {
      kind: "set_state",
      target: { kind: "group", position: { zoneId: "A:bench", index: 0 } },
      field: { key: "damageCounters", value: 4 },
    }, after);
    const events = [first, second];
    const { container } = render(<MatchHistory {...props({ ...view, events })} />);
    expect([...container.querySelectorAll(".history-entry")].map((entry) => entry.getAttribute("data-event-id")))
      .toEqual(["event-2", "event-1"]);
    expect(screen.getByText("叶芽累计伤害：20 → 40")).toBeInTheDocument();
    expect(events).toEqual([first, second]);
    const button = screen.getByRole("button", { name: "回到最新" });
    expect(button).toHaveClass("history-to-latest");
    expect(button).toHaveTextContent("");
    expect(button.querySelector("svg")).not.toBeNull();
  });
  it("定位、异议、调试恢复均保留原事件；撤销事件不能恢复", () => {
    const event = recorded(
      1,
      {
        kind: "set_state",
        target: { kind: "group", position: { zoneId: "A:bench", index: 0 } },
        field: { key: "damageCounters", value: 3 },
      },
      view,
    );
    const callbacks = props({ ...view, events: [event] });
    const { rerender } = render(<MatchHistory {...callbacks} />);
    fireEvent.click(screen.getByTitle("定位相关区域"));
    expect(callbacks.onLocate).toHaveBeenCalledWith([
      { zoneId: "A:bench", index: 0 },
    ]);
    fireEvent.click(screen.getByText("提出异议"));
    expect(callbacks.onObject).toHaveBeenCalledWith(event);
    fireEvent.click(screen.getByText("恢复至此之前"));
    expect(callbacks.onRestore).toHaveBeenCalledWith(event);
    rerender(
      <MatchHistory
        {...callbacks}
        view={{ ...view, events: [{ ...event, revokedBy: "restore" }] }}
      />,
    );
    expect(screen.getByText("已撤销，信息记录保留")).toBeInTheDocument();
    expect(screen.getByText("恢复至此之前")).toBeDisabled();
    expect(screen.getByText("提出异议")).toBeEnabled();
  });
  it("向下阅读历史后新记录不抢滚动位置，点击上箭头才回到最新", () => {
    const first = recorded(1, { kind: "declare", text: "第一条" }, view);
    const second = recorded(2, { kind: "declare", text: "第二条" }, view);
    const callbacks = props({ ...view, events: [first] });
    const { rerender } = render(<MatchHistory {...callbacks} />);
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(
      <MatchHistory
        {...callbacks}
        view={{ ...view, events: [first, second] }}
      />,
    );
    expect(log.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(log.scrollTop).toBe(0);
  });
  it("切换回放游标不自动回顶，原始JSON默认不生成长DOM", () => {
    const first = recorded(1, { kind: "declare", text: "第一条" }, view);
    const second = recorded(2, { kind: "declare", text: "第二条" }, view);
    const callbacks = props({ ...view, events: [first, second] });
    const { rerender, container } = render(<MatchHistory {...callbacks} />);
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(
      <MatchHistory
        {...callbacks}
        view={{ ...view, events: [first], replay: { index: 1, total: 2 } }}
      />,
    );
    expect(log.scrollTop).toBe(100);
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(container.querySelector("pre")).toHaveTextContent("第一条");
  });
});
