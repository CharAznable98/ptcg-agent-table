import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import type {
  GameCommand,
  MatchView,
  Position,
} from "../../../packages/protocol/src/index.ts";
import {
  allowedViewers,
  api,
  streamMatch,
  submitCommand,
} from "../src/api.ts";
import {
  selectionFromPositions,
  togglePosition,
  containers,
} from "../src/table-utils.ts";
import { Operations, type DestinationPick } from "../src/Operations.tsx";
import { SetupChoice, ObjectionEditor, DisputePanel } from "../src/Choices.tsx";
import { CardFace } from "../src/Cards.tsx";
import { Home } from "../src/Home.tsx";
import { Settings } from "../src/Settings.tsx";
import { Library } from "../src/Library.tsx";
import { Match } from "../src/Match.tsx";
import { parseDeck, parseCard } from "../src/validation.ts";
import { card, view } from "./fixtures.ts";
beforeEach(() => {
  vi.restoreAllMocks();
});
describe("结构化位置与权限", () => {
  it("同源多选产生位置集合，跨来源拒绝并自动重新点选", () => {
    const a = { zoneId: "A:hand", index: 0 };
    const b = { zoneId: "A:hand", index: 1 };
    expect(selectionFromPositions([b, a])).toEqual({
      container: { kind: "zone", zoneId: "A:hand" },
      range: { mode: "indices", indices: [0, 1] },
    });
    expect(() =>
      selectionFromPositions([a, { zoneId: "A:deck", index: 0 }]),
    ).toThrow("同一来源");
    expect(togglePosition([a], { zoneId: "A:deck", index: 0 })).toEqual([
      { zoneId: "A:deck", index: 0 },
    ]);
  });
  it("内部附着卡不误选整个卡牌组", () => {
    expect(
      selectionFromPositions([
        {
          zoneId: "A:bench",
          index: 0,
          member: { relation: "attached", index: 2 },
        },
      ]),
    ).toEqual({
      container: {
        kind: "group",
        position: { zoneId: "A:bench", index: 0 },
        relation: "attached",
      },
      range: { mode: "indices", indices: [2] },
    });
    expect(
      containers(view).some((item) => item.key === "A:bench/0/stack"),
    ).toBe(true);
  });
  it("人机实时只显示人类视角，赛后允许全知", () => {
    const match: MatchView = {
      ...view,
      mode: "human_ai",
      players: view.players.map((player) => ({
        ...player,
        kind: player.id === "A" ? "human" : "ai",
      })),
    };
    expect(allowedViewers(match, false)).toEqual(["A"]);
    expect(allowedViewers(match, true)).toEqual(["A", "B", "omniscient"]);
  });
  it("原子命令显式携带席位、版本与请求ID，不发送凭证", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "committed",
          eventId: "e1",
          revision: 13,
          result: {},
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await submitCommand(
      "match-test",
      12,
      { kind: "declare", text: "使用撞击" },
      "A",
    );
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/matches/match-test/commands");
    expect(url).not.toContain("secret");
    expect(options.headers.has("x-match-token")).toBe(false);
    expect(JSON.parse(options.body)).toMatchObject({
      playerId: "A",
      revision: 12,
      command: { kind: "declare", text: "使用撞击" },
    });
  });
  it("SSE无需凭证即可同步", async () => {
    const notify = vi.fn();
    const bytes = new TextEncoder().encode(
      'event: change\ndata: {"revision":13}\n\n',
    );
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await streamMatch(
      "match-test",
      "A",
      "12",
      notify,
      new AbortController().signal,
    );
    expect(notify).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).not.toContain("secret");
    expect(fetch.mock.calls[0]![1].headers).toBeUndefined();
  });
  it("HTTP错误保留服务端安全说明", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "WRONG_OPERATOR", message: "当前无操作权" },
          }),
          { status: 403 },
        ),
      ),
    );
    await expect(api("/matches/test")).rejects.toThrow("当前无操作权");
  });
});
function OperationHarness({
  execute,
  selected: initial = [{ zoneId: "A:hand", index: 0 }],
}: {
  execute: (command: GameCommand) => Promise<void>;
  selected?: Position[];
}) {
  const [destination, setDestination] = useState<DestinationPick>({
    key: "A:bench/0/attached",
    index: 0,
  });
  const [selected, setSelected] = useState(initial);
  return (
    <Operations
      view={view}
      selected={selected}
      setSelected={setSelected}
      destination={destination}
      setDestination={setDestination}
      execute={execute}
      busy={false}
      enabled
    />
  );
}
describe("牌桌表单可直接执行基础操作", () => {
  it("检查阶段自动无归属，切换玩家回合自动选择有效席位", () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    render(<OperationHarness execute={execute} />);
    fireEvent.click(screen.getByText("流程"));
    expect(screen.getByLabelText("回合归属")).toBeDisabled();
    fireEvent.click(screen.getByText("更新回合与阶段"));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "set_turn",
      phase: "check",
      playerId: null,
    });
    fireEvent.change(screen.getByLabelText("回合阶段"), {
      target: { value: "turn" },
    });
    expect(screen.getByLabelText("回合归属")).toBeEnabled();
    fireEvent.click(screen.getByText("更新回合与阶段"));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "set_turn",
      phase: "turn",
      playerId: "A",
    });
  });
  it("移动点选卡牌到组内附着，无需UUID", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    render(<OperationHarness execute={execute} />);
    fireEvent.click(screen.getByText("移动到目标"));
    expect(execute).toHaveBeenCalledWith({
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
    });
  });
  it("查看和展示分开提交；硬币支持多枚", () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    render(<OperationHarness execute={execute} />);
    fireEvent.click(screen.getByText("查看 / 展示"));
    fireEvent.click(screen.getByText("仅自己查看"));
    fireEvent.click(screen.getByText("向双方展示"));
    expect(execute.mock.calls.map((item) => item[0].kind)).toEqual([
      "look",
      "show",
    ]);
    fireEvent.click(screen.getByText("随机"));
    fireEvent.change(screen.getByLabelText("硬币数量"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByText("产生并记录随机结果"));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "random",
      mode: "coins",
      count: 3,
    });
  });
  it("卡牌组伤害以指示物数量提交；可删除空组", () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    render(
      <OperationHarness
        execute={execute}
        selected={[{ zoneId: "A:bench", index: 0 }]}
      />,
    );
    fireEvent.click(screen.getByText("状态"));
    fireEvent.change(
      screen.getByLabelText("伤害指示物数量（每个 10 点伤害）"),
      { target: { value: "4" } },
    );
    fireEvent.click(screen.getByText("更新状态"));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "set_state",
      target: { kind: "group", position: { zoneId: "A:bench", index: 0 } },
      field: { key: "damageCounters", value: 4 },
    });
    fireEvent.click(screen.getByText("空组"));
    fireEvent.click(screen.getByText("删除选中的空卡牌组"));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "remove_group",
      position: { zoneId: "A:bench", index: 0 },
    });
  });
  it("无卡图牌面显示名称HP及招式", () => {
    render(<CardFace card={card} />);
    expect(screen.getByText("叶芽")).toBeInTheDocument();
    expect(screen.getByText("80")).toBeInTheDocument();
    expect(screen.getByText(/撞击/)).toBeInTheDocument();
  });
});
describe("开局、异议与配置", () => {
  it("清空浏览器存储后仍可重开人机对局，只显示人类席位", async () => {
    const current: MatchView = {
      ...view,
      mode: "human_ai",
      players: view.players.map((player) => ({
        ...player,
        kind: player.id === "A" ? "human" : "ai",
      })),
    };
    const fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(new Response(
        url.includes("/events") ? "" : JSON.stringify(current),
      )),
    );
    vi.stubGlobal("fetch", fetch);
    const first = render(<Match id="match-test" back={() => {}} />);
    await screen.findByRole("button", { name: "牌桌操作" });
    first.unmount();
    localStorage.clear();
    render(<Match id="match-test" back={() => {}} />);
    await screen.findByRole("button", { name: "牌桌操作" });
    expect(screen.getByLabelText("牌桌视角")).toHaveValue("A");
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("value")))
      .not.toContain("B");
    expect(screen.queryByText("本浏览器没有这局的访问凭证")).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(fetch.mock.calls.filter(([url]) => url === "/api/matches/match-test"))
      .toHaveLength(2);
  });
  it("首页已有对局可直接打开，无浏览器凭证提示", async () => {
    const openMatch = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) =>
      Promise.resolve(new Response(JSON.stringify(
        url.endsWith("/matches")
          ? { matches: [{
              id: "old-match", createdAt: "2026-10-29", mode: "local",
              players: view.players, phase: "turn", result: null,
              runtime: view.runtime, revision: view.revision,
            }] }
          : url.endsWith("/decks") ? { decks: [] } : { opponents: [] },
      ))),
    ));
    render(<Home openMatch={openMatch} />);
    fireEvent.click(await screen.findByRole("button", { name: /玩家 A.*vs.*玩家 B/ }));
    expect(openMatch).toHaveBeenCalledWith("old-match");
    expect(screen.queryByText(/本浏览器无操作凭证/)).toBeNull();
  });
  it("未结束时本人认输不要求普通操作权，准备等待期间也可确认提交", async () => {
    const waiting: MatchView = {
      ...view,
      flow: {
        ...view.flow,
        phase: "setup",
        operator: "B",
        choice: { kind: "choose_first", playerId: "B" },
      },
    };
    const fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            url.includes("/events")
              ? ""
              : JSON.stringify(
                  url.endsWith("/commands")
                    ? {
                        status: "committed",
                        eventId: "conceded",
                        revision: 13,
                        result: {},
                      }
                    : waiting,
                ),
          ),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    render(<Match id="match-test" back={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "牌桌操作" }));
    fireEvent.click(screen.getByText("流程"));
    expect(screen.getByText("认输", { selector: "button" })).toBeEnabled();
    fireEvent.click(screen.getByText("认输", { selector: "button" }));
    fireEvent.click(screen.getByText("确认认输并结束本局"));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some((call) => call[0].endsWith("/commands")),
      ).toBe(true),
    );
    const request = fetch.mock.calls.find((call) =>
      call[0].endsWith("/commands"),
    )!;
    expect(JSON.parse(request[1].body).command).toEqual({ kind: "concede" });
    expect(request[1].headers.has("x-match-token")).toBe(false);
    expect(JSON.parse(request[1].body).playerId).toBe("A");
  });
  it("同一个持久AI对手不能在一局同时占两席", async () => {
    const opponent = {
      schemaVersion: 1,
      id: "same-ai",
      name: "同一个AI",
      deck: { cards: [{ card, count: 60 }] },
      strategies: [
        {
          version: 1,
          content: "",
          createdAt: "2026-10-29",
          source: { kind: "initial" },
        },
      ],
    };
    const fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.endsWith("/matches")
                ? { matches: [] }
                : url.endsWith("/decks")
                  ? { decks: [] }
                  : { opponents: [opponent] },
            ),
          ),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    render(<Home openMatch={() => {}} />);
    await screen.findByText("暂无对局");
    fireEvent.click(screen.getByText("新建对局"));
    fireEvent.click(screen.getByText("AI 对战", { selector: "b" }));
    fireEvent.click(screen.getByText("创建对局"));
    expect(screen.getByRole("alert")).toHaveTextContent("不能同时占据两席");
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(
      true,
    );
  });
  it.each(["baseline", "comparison"] as const)("%s 评估终局不显示策略复盘或重试操作", async (phase) => {
    const completed: MatchView = {
      ...view,
      mode: "ai_ai",
      evaluation: { id: "eval-1", phase },
      players: view.players.map((player) => ({ ...player, kind: "ai" })),
      flow: { ...view.flow, phase: "finished", result: { kind: "win", winner: "A", reason: "评估终局" } },
      runtime: { status: "completed" },
      summaries: { B: { status: "failed", error: "不应展示的复盘状态" } },
    };
    const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(
      url.includes("/events") ? "" : JSON.stringify(completed),
    )));
    vi.stubGlobal("fetch", fetch);
    render(<Match id="match-evaluation" back={() => {}} />);
    await screen.findByText("评估终局");
    expect(screen.getByText("策略评估")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试策略总结" })).not.toBeInTheDocument();
    expect(screen.queryByText(/不应展示的复盘状态/)).not.toBeInTheDocument();
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });
  it("正式结果保留，总结失败可从结果区重试", async () => {
    const completed: MatchView = {
      ...view,
      players: view.players.map((player) => ({
        ...player,
        kind: player.id === "B" ? "ai" : "human",
      })),
      flow: {
        ...view.flow,
        phase: "finished",
        result: { kind: "win", winner: "A", reason: "已确认终局" },
      },
      runtime: { status: "completed" },
      summaries: { B: { status: "failed", error: "暂时网络故障" } },
    };
    const fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            url.includes("/events")
              ? ""
              : JSON.stringify(
                  url.endsWith("/control") ? { status: "running" } : completed,
                ),
          ),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    render(<Match id="match-test" back={() => {}} />);
    const retry = await screen.findByText("重试策略总结");
    expect(screen.getByText("已确认终局")).toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        fetch.mock.calls.some((call) => call[0].endsWith("/control")),
      ).toBe(true),
    );
    const request = fetch.mock.calls.find((call) =>
      call[0].endsWith("/control"),
    )!;
    expect(JSON.parse(request[1].body)).toEqual({ action: "resume" });
    expect(request[1].headers.has("x-match-token")).toBe(false);
  });
  it("合法JSON但不合卡牌及卡组结构时拒绝进入表单", () => {
    expect(() => parseDeck('{"cards":null}')).toThrow("卡组结构无效");
    expect(() => parseCard('{"kind":"pokemon","name":"缺字段"}')).toThrow(
      "卡牌结构无效",
    );
  });
  it("卡组编辑器的无效JSON保存及切表单均显示错误并保持可操作", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                url.includes("/decks") ? { decks: [] } : { opponents: [] },
              ),
            ),
          ),
        ),
    );
    render(<Library />);
    await screen.findByText("暂无卡组");
    fireEvent.click(screen.getByText("打开练习示例"));
    fireEvent.click(screen.getByText("JSON", { selector: "button" }));
    fireEvent.change(screen.getByLabelText("JSON 内容"), {
      target: { value: '{"cards":null}' },
    });
    fireEvent.click(screen.getByText("卡牌编辑器"));
    expect(screen.getByRole("alert")).toHaveTextContent("卡组结构无效");
    fireEvent.change(screen.getByLabelText("JSON 内容"), {
      target: { value: "{broken" },
    });
    fireEvent.click(screen.getByText("保存卡组"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("保存卡组")).toBeEnabled();
  });
  it("本地交接在揭开遮罩后才请求另一席位视角", async () => {
    const fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          url.includes("/events")
            ? ""
            : JSON.stringify({
                ...view,
                viewer: url.includes("viewer=B") ? "B" : "A",
              }),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<Match id="match-test" back={() => {}} />);
    await screen.findByText("牌桌操作");
    fireEvent.change(screen.getByLabelText("牌桌视角"), {
      target: { value: "B" },
    });
    expect(screen.getByText("请将设备交给玩家 B")).toBeInTheDocument();
    expect(fetch.mock.calls.some((call) => call[0].includes("viewer=B"))).toBe(
      false,
    );
    fireEvent.click(screen.getByText("我是玩家 B，查看牌桌"));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some((call) => call[0].includes("viewer=B")),
      ).toBe(true),
    );
    const read = fetch.mock.calls.find(
      (call) => call[0].includes("viewer=B") && !call[0].includes("/events"),
    )!;
    expect(read[1].headers.has("x-match-token")).toBe(false);
  });
  it("开局选择战斗与备战宝可梦后只提交一次结构化选择", () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const setup: MatchView = {
      ...view,
      flow: {
        ...view.flow,
        phase: "setup",
        choice: {
          kind: "initial_placement",
          playerId: "A",
          eligible: [
            { zoneId: "A:hand", index: 0 },
            { zoneId: "A:hand", index: 1 },
          ],
          maximum: 5,
        },
      },
    };
    render(<SetupChoice view={setup} execute={execute} busy={false} canAct />);
    fireEvent.change(screen.getByLabelText("战斗宝可梦"), {
      target: { value: "A:hand/0" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByText("提交摆放"));
    expect(execute).toHaveBeenCalledWith({
      kind: "initial_placement",
      active: { zoneId: "A:hand", index: 0 },
      bench: [{ zoneId: "A:hand", index: 1 }],
    });
  });
  it("历史异议包含固定恢复提议，回应使用proposalId", () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const event = {
      id: "event-1",
      sequence: 1,
      revision: 1,
      at: new Date().toISOString(),
      actor: "B" as const,
      commandKind: "move",
      label: "错误移动",
      data: {},
    };
    const { unmount } = render(
      <ObjectionEditor
        event={event}
        view={view}
        close={() => {}}
        execute={execute}
      />,
    );
    fireEvent.change(screen.getByLabelText("异议理由"), {
      target: { value: "当前不应移动此卡" },
    });
    fireEvent.click(screen.getByText("提交异议"));
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "object",
        targetEventId: "event-1",
        proposal: { restoreBeforeEventId: "event-1", shuffles: [] },
      }),
    );
    unmount();
    render(
      <DisputePanel
        view={{
          ...view,
          dispute: {
            id: "d1",
            targetEventId: "event-1",
            raisedBy: "A",
            respondent: "B",
            reason: "异议",
            proposalId: "p1",
            proposal: { shuffles: [] },
            status: "awaiting_response",
          },
        }}
        execute={execute}
        busy={false}
        canRespond
      />,
    );
    fireEvent.click(screen.getByText("认可异议与此处置提议"));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "respond",
      response: { kind: "accept", disputeId: "d1", proposalId: "p1" },
    });
  });
  it("缺少卡组创建时显示错误，不发送无效创建请求", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                url.includes("/matches")
                  ? { matches: [] }
                  : url.includes("/decks")
                    ? { decks: [] }
                    : { opponents: [] },
              ),
            ),
          ),
        ),
    );
    render(<Home openMatch={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("新建对局")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("新建对局"));
    fireEvent.click(screen.getByText("创建对局"));
    expect(screen.getByRole("alert")).toHaveTextContent("请选择双方卡组");
  });
  it("载入默认提示词只替换编辑内容，不自动PUT", async () => {
    const prompts = {
      schemaVersion: 1,
      player: "玩家正文",
      judge: "裁判正文",
      summary: "总结正文",
      compactor: "压缩正文",
      toolDescriptions: { a: "工具" },
      feedback: { a: "反馈" },
    };
    const fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith("/model")
              ? {
                  schemaVersion: 1,
                  model: "gpt-6.1-terra",
                  reasoningEffort: "medium",
                  fast: false,
                  connection: { kind: "local_codex_credentials" },
                }
              : url.endsWith("/default")
                ? { ...prompts, player: "默认玩家正文" }
                : prompts,
          ),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<Settings />);
    await screen.findByText("模型连接", { selector: "h2" });
    fireEvent.click(screen.getByText("对战玩家提示词"));
    fireEvent.click(screen.getByText("载入默认配置"));
    await screen.findByDisplayValue("默认玩家正文");
    expect(screen.getByRole("status")).toHaveTextContent("尚未保存");
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "PUT")).toBe(
      true,
    );
  });
});
