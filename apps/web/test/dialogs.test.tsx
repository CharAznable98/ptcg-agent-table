import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  GameCommand,
  MatchView,
  PublicEvent,
} from "../../../packages/protocol/src/index.ts";
import { ConfirmAction } from "../src/ui.tsx";
import { Library } from "../src/Library.tsx";
import { Match } from "../src/Match.tsx";
import { Operations } from "../src/Operations.tsx";
import { card, view } from "./fixtures.ts";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(window, "confirm").mockImplementation(() => {
    throw new Error("禁止原生确认框");
  });
  vi.spyOn(window, "prompt").mockImplementation(() => {
    throw new Error("禁止原生输入框");
  });
});

describe("页面内危险操作确认", () => {
  it("原因必填，提交时禁止重复调用与取消，成功才关闭", async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn().mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const close = vi.fn();
    render(
      <ConfirmAction
        title="中止运行"
        description="保留牌桌"
        confirmLabel="确认中止"
        reasonLabel="中止原因"
        close={close}
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "中止运行" });
    expect(within(dialog).getByText("确认中止")).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("中止原因"), {
      target: { value: "  需要核对局面  " },
    });
    fireEvent.click(within(dialog).getByText("确认中止"));
    const pending = within(dialog).getByText("正在执行…");
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    fireEvent.click(within(dialog).getByText("取消"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith("需要核对局面");
    expect(close).not.toHaveBeenCalled();
    resolve();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("错误留在确认弹窗内，允许重试；取消不执行动作", async () => {
    const close = vi.fn();
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("恢复锚点已失效"))
      .mockResolvedValue(undefined);
    render(
      <ConfirmAction
        title="恢复牌桌"
        description="恢复到历史之前"
        confirmLabel="确认恢复"
        close={close}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("取消"));
    expect(close).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    close.mockClear();
    fireEvent.click(screen.getByText("确认恢复"));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("恢复锚点已失效");
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认恢复"));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it.each(["decks", "opponents"] as const)(
    "%s 删除须在弹窗内明确确认",
    async (kind) => {
      let removed = false;
      const fetch = vi
        .fn()
        .mockImplementation((url: string, options?: RequestInit) => {
          if (options?.method === "DELETE") {
            removed = true;
            return Promise.resolve(new Response('{"ok":true}'));
          }
          const deck = {
            id: "deck-1",
            deck: { name: "待删卡组", cards: [{ card, count: 60 }] },
            createdAt: "2026-10-29",
            updatedAt: "2026-10-29",
          };
          const opponent = {
            schemaVersion: 1,
            id: "opponent-1",
            name: "待删对手",
            deck: deck.deck,
            strategies: [],
          };
          return Promise.resolve(
            new Response(
              JSON.stringify(
                url.endsWith("/decks")
                  ? { decks: removed && kind === "decks" ? [] : [deck] }
                  : {
                      opponents:
                        removed && kind === "opponents" ? [] : [opponent],
                    },
              ),
            ),
          );
        });
      vi.stubGlobal("fetch", fetch);
      render(<Library />);
      await screen.findByText("待删卡组", { selector: "h2" });
      if (kind === "opponents")
        fireEvent.click(screen.getByRole("button", { name: /^AI 对手/ }));
      fireEvent.click(screen.getByRole("button", { name: "删除" }));
      const title = kind === "decks" ? "删除卡组" : "删除 AI 对手";
      const dialog = screen.getByRole("dialog", { name: title });
      expect(
        fetch.mock.calls.some((call) => call[1]?.method === "DELETE"),
      ).toBe(false);
      fireEvent.click(within(dialog).getByText("取消"));
      expect(
        screen.queryByRole("dialog", { name: title }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "删除" }));
      fireEvent.click(screen.getByText("确认删除"));
      await waitFor(() =>
        expect(
          fetch.mock.calls.some(
            (call) =>
              call[0] ===
                `/api/${kind}/${kind === "decks" ? "deck-1" : "opponent-1"}` &&
              call[1]?.method === "DELETE",
          ),
        ).toBe(true),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: title }),
        ).not.toBeInTheDocument(),
      );
      expect(window.confirm).not.toHaveBeenCalled();
    },
  );

  it("认输弹窗取消不发命令，确认才提交concede", async () => {
    const execute = vi
      .fn<(command: GameCommand) => Promise<void>>()
      .mockResolvedValue(undefined);
    render(
      <Operations
        view={view}
        selected={[]}
        setSelected={() => {}}
        destination={{ key: "A:hand", index: 0 }}
        setDestination={() => {}}
        execute={execute}
        busy={false}
        enabled
      />,
    );
    fireEvent.click(screen.getByText("流程"));
    fireEvent.click(screen.getByText("认输"));
    fireEvent.click(screen.getByText("取消"));
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("认输"));
    fireEvent.click(screen.getByText("确认认输并结束本局"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith({ kind: "concede" }),
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });
});

const events: PublicEvent[] = [
  {
    id: "event-1",
    sequence: 1,
    revision: 1,
    at: "2026-10-29",
    actor: "A",
    commandKind: "declare",
    label: "第一条宣告",
    data: {},
  },
  {
    id: "event-2",
    sequence: 2,
    revision: 2,
    at: "2026-10-29",
    actor: "B",
    commandKind: "move",
    label: "指定位置移动",
    data: {},
  },
];
function renderDebugMatch() {

  const observation: MatchView = { ...view, events };
  const fetch = vi
    .fn()
    .mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          url.includes("/events") ? "" : JSON.stringify(observation),
        ),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  render(<Match id={view.id} back={() => {}} />);
  return fetch;
}
describe("调试操作页面弹窗", () => {
  it("首个恢复与指定事件恢复均经过弹窗且无需凭证", async () => {
    const fetch = renderDebugMatch();
    await screen.findByText("牌桌操作");
    fireEvent.click(screen.getByText("调试"));
    fireEvent.click(screen.getByText("恢复到首个玩家操作前"));
    let dialog = screen.getByRole("dialog", { name: "恢复牌桌" });
    expect(within(dialog).getByText(/第一条宣告/)).toBeInTheDocument();
    expect(fetch.mock.calls.some((call) => call[0].endsWith("/debug"))).toBe(
      false,
    );
    fireEvent.click(within(dialog).getByText("确认恢复牌桌"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const first = fetch.mock.calls.find((call) => call[0].endsWith("/debug"))!;
    expect(JSON.parse(first[1].body)).toEqual({
      kind: "restore",
      targetEventId: "event-1",
    });
    expect(first[1].headers.has("x-match-token")).toBe(false);
    fireEvent.click(
      within(document.querySelector<HTMLElement>('[data-event-id="event-2"]')!)
        .getByRole("button", { name: "恢复至此之前" }),
    );
    dialog = screen.getByRole("dialog", { name: "恢复牌桌" });
    expect(within(dialog).getByText(/指定位置移动/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText("确认恢复牌桌"));
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter((call) => call[0].endsWith("/debug")),
      ).toHaveLength(2),
    );
    const second = fetch.mock.calls.filter((call) =>
      call[0].endsWith("/debug"),
    )[1]!;
    expect(JSON.parse(second[1].body)).toEqual({
      kind: "restore",
      targetEventId: "event-2",
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("中止要求填写原因，确认后才发送原debug命令", async () => {
    const fetch = renderDebugMatch();
    await screen.findByText("牌桌操作");
    fireEvent.click(screen.getByText("调试"));
    fireEvent.click(screen.getByText("中止运行并留记录"));
    const dialog = screen.getByRole("dialog", { name: "中止运行" });
    expect(within(dialog).getByText("确认中止并留记录")).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("中止原因"), {
      target: { value: "人工复核局面" },
    });
    fireEvent.click(within(dialog).getByText("确认中止并留记录"));
    await waitFor(() =>
      expect(fetch.mock.calls.some((call) => call[0].endsWith("/debug"))).toBe(
        true,
      ),
    );
    const request = fetch.mock.calls.find((call) =>
      call[0].endsWith("/debug"),
    )!;
    expect(JSON.parse(request[1].body)).toEqual({
      kind: "abort",
      reason: "人工复核局面",
    });
    expect(window.prompt).not.toHaveBeenCalled();
  });
});
