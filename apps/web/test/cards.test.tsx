import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type {
  CardView,
  GroupView,
  ZoneView,
} from "../../../packages/protocol/src/index.ts";
import { CardFace, ObjectCard, ObjectInspector, Zone } from "../src/Cards.tsx";
import { card, view } from "./fixtures.ts";

const group = structuredClone(
  view.zones.find((zone) => zone.kind === "bench")!.items[0],
) as GroupView;
const member = group.stack[0] as CardView;

function InspectorHarness() {
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);
  const attached: GroupView = {
    ...group,
    attached: [
      {
        ...member,
        position: {
          ...group.position,
          member: { relation: "attached", index: 0 },
        },
      },
    ],
  };
  return (
    <>
      <button>其他焦点</button>
      <ObjectCard
        object={attached}
        selected={[]}
        onSelect={() => {}}
        onInspect={() => setPinned(true)}
        onPreview={(object) => setPreview(Boolean(object))}
        interactive={false}
      />
      {(pinned || preview) && (
        <ObjectInspector
          object={attached}
          selected={[]}
          onSelect={() => {}}
          pinned={pinned}
          close={() => {
            setPinned(false);
            setPreview(false);
          }}
        />
      )}
    </>
  );
}

describe("牌桌卡牌总览与详情", () => {
  it("卡背图片失败后保留隐藏卡牌和隐藏卡牌组的可访问操作", () => {
    const hidden = { kind: "hidden" as const, position: { zoneId: "B:hand", index: 0 } };
    const onSelect = vi.fn();
    const { container, rerender } = render(
      <ObjectCard object={hidden} selected={[]} onSelect={onSelect} onInspect={() => {}} />,
    );
    const select = screen.getByRole("button", { name: "选择B · 手牌 第 1 位隐藏卡牌" });
    expect(screen.queryByText("隐藏", { selector: ".card-back > span" })).toBeNull();
    fireEvent.error(container.querySelector(".card-back-image")!);
    expect(screen.getByText("隐藏", { selector: ".card-back > span" })).toBeInTheDocument();
    fireEvent.click(select);
    expect(onSelect).toHaveBeenCalledWith(hidden.position);

    const onInspect = vi.fn();
    rerender(
      <ObjectCard
        object={{ ...group, stack: [{ ...hidden, position: group.position }] }}
        selected={[]}
        onSelect={onSelect}
        onInspect={onInspect}
        interactive={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看A · 备战区 第 1 位卡牌组" }));
    expect(onInspect).toHaveBeenCalledOnce();
    expect(screen.getByText("卡牌组", { selector: ".card-back > span" })).toBeInTheDocument();
  });
  it("观战点击查看、人类点击选择，悬停只预览", () => {
    const onSelect = vi.fn(),
      onInspect = vi.fn(),
      onPreview = vi.fn();
    const { rerender, container } = render(
      <ObjectCard
        object={group}
        selected={[]}
        onSelect={onSelect}
        onInspect={onInspect}
        onPreview={onPreview}
        interactive={false}
      />,
    );
    fireEvent.mouseEnter(container.querySelector(".group-object")!);
    expect(onPreview).toHaveBeenLastCalledWith(group);
    expect(onInspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /查看A.*卡牌组/ }));
    expect(onInspect).toHaveBeenCalledWith(group);
    expect(onSelect).not.toHaveBeenCalled();
    rerender(
      <ObjectCard
        object={group}
        selected={[]}
        onSelect={onSelect}
        onInspect={onInspect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /选择A.*卡牌组/ }));
    expect(onSelect).toHaveBeenCalledWith(group.position);
    expect(screen.getByText("伤害 20")).toBeInTheDocument();
    expect(screen.queryByText(/剩余/)).not.toBeInTheDocument();
  });

  it("附着摘要保留能量与道具身份，隐藏成员不泄漏牌面", () => {
    const attached: GroupView = {
      ...group,
      attached: [
        {
          ...member,
          position: {
            ...group.position,
            member: { relation: "attached", index: 0 },
          },
          card: {
            kind: "energy",
            subtype: "basic",
            name: "基本草能量",
            energyType: "草",
          },
        },
        {
          ...member,
          position: {
            ...group.position,
            member: { relation: "attached", index: 1 },
          },
          card: {
            kind: "energy",
            subtype: "basic",
            name: "基本草能量",
            energyType: "草",
          },
        },
        {
          ...member,
          position: {
            ...group.position,
            member: { relation: "attached", index: 2 },
          },
          card: {
            kind: "trainer",
            subtype: "tool",
            name: "练习护具",
            text: "道具说明",
          },
        },
        {
          kind: "hidden",
          position: {
            ...group.position,
            member: { relation: "attached", index: 3 },
          },
        },
      ],
    };
    render(
      <ObjectCard
        object={attached}
        selected={[]}
        onSelect={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    expect(screen.getByText("草能量 ×2")).toHaveAttribute(
      "title",
      "草能量 2 张",
    );
    expect(screen.getByText("练习护具 ×1")).toBeInTheDocument();
    expect(screen.getByText("隐藏卡牌 ×1")).toBeInTheDocument();
    expect(screen.queryByText(/提供.*能量/)).not.toBeInTheDocument();
  });

  it("无图总览精简，详情即使有图也保留完整卡文，图片失败可回退", () => {
    const { rerender } = render(<CardFace card={card} compact />);
    expect(screen.getByText("叶芽")).toBeInTheDocument();
    expect(screen.queryByText("普通的招式说明。")).not.toBeInTheDocument();
    const illustrated = {
      ...card,
      imageUrl: "https://example.com/card.png",
      rulesText: "特殊规则说明",
    };
    rerender(<CardFace card={illustrated} />);
    expect(screen.getByRole("img", { name: "叶芽" })).toBeInTheDocument();
    expect(screen.getByText("普通的招式说明。")).toBeInTheDocument();
    expect(screen.getByText("特殊规则说明")).toBeInTheDocument();
    fireEvent.error(screen.getByRole("img", { name: "叶芽" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("普通的招式说明。")).toBeInTheDocument();
  });

  it("悬停详情不抢焦点；固定详情非模态，可选内部卡、查看标记并用Esc关闭", () => {
    const rich: GroupView = {
      ...group,
      state: {
        ...group.state,
        specialConditions: ["poisoned"],
        markers: { 已用特性: true },
      },
      stack: [{ ...member, markers: { 本回合进化: true } }],
    };
    const onSelect = vi.fn(),
      close = vi.fn();
    const { rerender } = render(
      <>
        <button>原焦点</button>
        <ObjectInspector
          object={rich}
          selected={[]}
          onSelect={onSelect}
          close={close}
          pinned={false}
        />
      </>,
    );
    screen.getByRole("button", { name: "原焦点" }).focus();
    expect(screen.getByRole("tooltip", { name: "卡牌详情" })).toHaveStyle({
      pointerEvents: "none",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "原焦点" }),
    );
    rerender(
      <>
        <button>原焦点</button>
        <ObjectInspector
          object={rich}
          selected={[]}
          onSelect={onSelect}
          close={close}
        />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "卡牌详情" })).toHaveAttribute(
      "aria-modal",
      "false",
    );
    expect(screen.getByText("已用特性")).toBeInTheDocument();
    expect(screen.getByText("本回合进化")).toBeInTheDocument();
    expect(screen.getByText("中毒")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看并选择/ }));
    expect(onSelect).toHaveBeenCalledWith(member.position);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("全知牌库与奖赏基础区显示卡背，展开牌库保留可见牌面和原对象交互", () => {
    const deck: ZoneView = {
      ...view.zones[0]!,
      id: "A:deck",
      kind: "deck",
      items: [
        { ...member, position: { zoneId: "A:deck", index: 0 } },
        { ...member, position: { zoneId: "A:deck", index: 1 } },
        { kind: "hidden", position: { zoneId: "A:deck", index: 2 } },
      ],
    };
    const prizes: ZoneView = {
      ...deck,
      id: "A:prizes",
      kind: "prizes",
      layout: "slots",
      items: [
        { ...member, position: { zoneId: "A:prizes", index: 0 } },
        null,
        { ...member, position: { zoneId: "A:prizes", index: 2 } },
      ],
    };
    const hand: ZoneView = {
      ...deck, id: "A:hand", kind: "hand",
      items: [{ ...member, position: { zoneId: "A:hand", index: 0 } }],
    };
    const discard: ZoneView = {
      ...deck, id: "A:discard", kind: "discard",
      items: [{ ...member, position: { zoneId: "A:discard", index: 0 } }],
    };
    const inspect = vi.fn(), preview = vi.fn();
    render(<>
      {[deck, prizes, hand, discard].map((zone) => (
        <Zone key={zone.id} zone={zone} selected={[]} onSelect={vi.fn()}
          onInspect={inspect} onPreview={preview} onDestination={vi.fn()}
          interactive={false} />
      ))}
    </>);
    const deckRegion = screen.getByRole("region", { name: "A牌库" });
    const prizeRegion = screen.getByRole("region", { name: "A奖赏卡" });
    expect(deckRegion.querySelectorAll(".zone-content .card-back-image")).toHaveLength(1);
    expect(deckRegion.querySelector(".zone-content .card-face")).toBeNull();
    expect(prizeRegion.querySelectorAll(".card-back-image")).toHaveLength(2);
    expect(prizeRegion.querySelectorAll(".empty-slot")).toHaveLength(1);
    for (const name of ["A手牌", "A弃牌区"]) {
      const region = screen.getByRole("region", { name });
      expect(region.querySelectorAll(".card-face")).toHaveLength(1);
      expect(region.querySelector(".card-back-image")).toBeNull();
    }
    fireEvent.mouseEnter(deckRegion.querySelector(".single-object")!);
    expect(preview).toHaveBeenLastCalledWith(deck.items[0]);
    fireEvent.click(within(deckRegion).getByRole("button", { name: /查看A.*第 1 位叶芽/ }));
    expect(inspect).toHaveBeenLastCalledWith(deck.items[0]);
    fireEvent.click(within(deckRegion).getByRole("button", { name: "展开" }));
    const content = within(deckRegion).getByRole("dialog", { name: "A牌库内容" });
    expect(content.querySelectorAll(".card-face")).toHaveLength(2);
    expect(content.querySelectorAll(".card-back-image")).toHaveLength(1);
    fireEvent.click(within(content).getByRole("button", { name: /第 2 位叶芽/ }));
    expect(inspect).toHaveBeenLastCalledWith(deck.items[1]);
  });

  it("牌叠展开在独立内容层中，基础区域始终只保留顶卡，观战可查看其中卡牌", () => {
    const zone: ZoneView = {
      ...view.zones[0]!,
      id: "A:discard",
      kind: "discard",
      items: [
        { ...member, position: { zoneId: "A:discard", index: 0 } },
        { ...member, position: { zoneId: "A:discard", index: 1 } },
      ],
    };
    const inspect = vi.fn();
    const { container } = render(
      <Zone
        zone={zone}
        selected={[]}
        onSelect={vi.fn()}
        onInspect={inspect}
        onDestination={vi.fn()}
        interactive={false}
      />,
    );
    expect(
      container
        .querySelector(".zone-content")!
        .querySelectorAll(".single-object"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    const content = screen.getByRole("dialog", { name: "A弃牌区内容" });
    expect(
      within(content).getAllByRole("button", { name: /查看A.*叶芽/ }),
    ).toHaveLength(2);
    expect(
      container
        .querySelector(".zone-content")!
        .querySelectorAll(".single-object"),
    ).toHaveLength(1);
    fireEvent.click(
      within(content).getByRole("button", { name: /第 2 位叶芽/ }),
    );
    expect(inspect).toHaveBeenCalledWith(zone.items[1]);
    fireEvent.keyDown(content, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("记录定位只增加高亮，不污染选牌状态", () => {
    const { container } = render(
      <Zone
        zone={view.zones[2]!}
        selected={[]}
        onSelect={vi.fn()}
        onInspect={vi.fn()}
        onDestination={vi.fn()}
        highlighted={[member.position]}
      />,
    );
    expect(container.querySelector('[data-zone-id="A:bench"]')).toHaveClass(
      "is-located",
    );
    const located = container.querySelector(
      '.group-object[data-position-key="A:bench/0"]',
    );
    expect(located).toHaveClass("is-located");
    expect(located).not.toHaveClass("selected");
  });

  it.each(["Escape", "关闭按钮"])(
    "用%s关闭固定详情后保留焦点且不重开预览，后续主动悬停和聚焦仍可预览",
    (method) => {
      const { container } = render(<InspectorHarness />);
      const opener = screen.getByRole("button", { name: /查看A.*卡牌组/ });
      act(() => opener.focus());
      expect(
        screen.getByRole("tooltip", { name: "卡牌详情" }),
      ).toBeInTheDocument();
      fireEvent.click(opener);
      const inspector = screen.getByRole("dialog", { name: "卡牌详情" });
      const attached = within(inspector).getByRole("button", {
        name: /查看并选择.*附着/,
      });
      act(() => attached.focus());
      fireEvent.click(attached);
      if (method === "Escape") fireEvent.keyDown(document, { key: "Escape" });
      else
        fireEvent.click(
          within(inspector).getByRole("button", { name: "关闭卡牌详情" }),
        );
      expect(document.activeElement).toBe(opener);
      expect(
        screen.queryByRole("dialog", { name: "卡牌详情" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("tooltip", { name: "卡牌详情" }),
      ).not.toBeInTheDocument();

      const object = container.querySelector(".group-object")!;
      fireEvent.mouseLeave(object);
      fireEvent.mouseEnter(object);
      expect(
        screen.getByRole("tooltip", { name: "卡牌详情" }),
      ).toBeInTheDocument();
      fireEvent.mouseLeave(object);
      act(() => screen.getByRole("button", { name: "其他焦点" }).focus());
      act(() => opener.focus());
      expect(
        screen.getByRole("tooltip", { name: "卡牌详情" }),
      ).toBeInTheDocument();
    },
  );
});
