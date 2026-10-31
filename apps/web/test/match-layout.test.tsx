import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Match } from "../src/Match.tsx";
import { MatchTable } from "../src/MatchTable.tsx";
import type { MatchView } from "../../../packages/protocol/src/index.ts";
import { view } from "./fixtures.ts";

beforeEach(() => {
  vi.restoreAllMocks();
});
function mockMatch() {

  const current: MatchView = {
    ...structuredClone(view),
    id: "layout-ai",
    mode: "ai_ai",
    viewer: "omniscient",
    players: view.players.map((player) => ({ ...player, kind: "ai" })),
  };
  const fetch = vi
    .fn()
    .mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          url.includes("/events")
            ? ""
            : JSON.stringify(
                url.includes("/replay")
                  ? { ...current, replay: { index: 0, total: 0 } }
                  : current,
              ),
        ),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("对局工作区", () => {
  it("无浏览器凭证的AI局默认全知，观战不常驻人类操作表单", async () => {
    const fetch = mockMatch();
    render(<Match id="layout-ai" back={() => {}} />);
    await screen.findByRole("complementary", { name: "对局记录" });
    expect(screen.getByLabelText("牌桌视角")).toHaveValue("omniscient");
    expect(fetch.mock.calls.some(([url]) => url === "/api/matches/layout-ai")).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(screen.queryByRole("button", { name: "牌桌操作" })).toBeNull();
    expect(
      screen.getByRole("log", { name: "对局记录列表" }),
    ).toBeInTheDocument();
  });
  it("点击固定非模态详情，回放切换清除旧详情且保留记录", async () => {
    mockMatch();
    render(<Match id="layout-ai" back={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看A · 备战区 第 1 位卡牌组",
      }),
    );
    expect(screen.getByRole("dialog", { name: "卡牌详情" })).toHaveAttribute(
      "aria-modal",
      "false",
    );
    expect(
      screen.getByRole("log", { name: "对局记录列表" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "逐步回放" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "卡牌详情" })).toBeNull(),
    );
    expect(
      screen.getByRole("slider", { name: "回放进度" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回实时" }));
    await waitFor(() =>
      expect(screen.queryByRole("slider", { name: "回放进度" })).toBeNull(),
    );
  });
  it("视图仍有底层区域时也不渲染放逐区或暂存区", () => {
    const table = structuredClone(view);
    table.zones.push(
      {
        id: "A:lost",
        kind: "lost",
        playerId: "A",
        layout: "sequence",
        items: [],
        defaultVisibility: { mode: "public" },
      },
      {
        id: "A:staging",
        kind: "staging",
        playerId: "A",
        layout: "sequence",
        items: [],
        defaultVisibility: { mode: "hidden" },
      },
    );
    render(
      <MatchTable
        view={table}
        viewer="omniscient"
        selected={[]}
        highlighted={[]}
        interactive={false}
        onSelect={() => {}}
        onInspect={() => {}}
        onPreview={() => {}}
        onDestination={() => {}}
      />,
    );
    expect(screen.queryByLabelText("A放逐区")).toBeNull();
    expect(screen.queryByLabelText("A暂存区")).toBeNull();
    expect(screen.getByLabelText("A手牌")).toBeInTheDocument();
    expect(table.zones.some((zone) => zone.kind === "staging")).toBe(true);
  });
});
