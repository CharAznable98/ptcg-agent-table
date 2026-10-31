import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EvaluationRecord, OpponentRecord } from "../../../packages/protocol/src/index.ts";
import { Evaluations } from "../src/Evaluations.tsx";
import { Home } from "../src/Home.tsx";
import { card } from "./fixtures.ts";

const opponents: OpponentRecord[] = ["one", "two"].map((id) => ({
  schemaVersion: 1, id, name: `AI ${id}`, deck: { cards: [{ count: 60, card }] },
  strategies: [1, 2, 3].map((version) => ({ version, content: `计划 ${version}`, createdAt: "2026-10-30", source: { kind: "initial" } })),
}));
const evaluation: EvaluationRecord = {
  id: "eval-1", createdAt: "2026-10-30T06:00:00Z", evaluatedPlayer: "B",
  players: [{ opponentId: "one", version: 2 }, { opponentId: "two", version: 1 }],
  baseline: { matchId: "base-1", version: 1, match: {
    id: "base-1", createdAt: "2026-10-30T06:00:00Z", mode: "ai_ai",
    players: [{ id: "A", name: "AI one", kind: "ai" }, { id: "B", name: "AI two", kind: "ai" }],
    phase: "finished", result: { kind: "win", winner: "A", reason: "奖赏卡取完" }, runtime: { status: "completed" }, revision: 7,
  } }, comparisons: [],
};

beforeEach(() => vi.restoreAllMocks());
function installFetch(records: EvaluationRecord[] = []) {
  const fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (options?.method === "POST") return Promise.resolve(new Response(JSON.stringify(url.endsWith("/comparisons") ? { ...evaluation, comparisons: [{ matchId: "compare-1", version: 3 }] } : evaluation)));
    return Promise.resolve(new Response(JSON.stringify(url.endsWith("/opponents") ? { opponents } : { evaluations: records })));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("手动策略对照", () => {
  it("首页提供评估入口，打开之前不查询或触发评估", async () => {
    const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.endsWith("/matches") ? { matches: [] } : url.endsWith("/decks") ? { decks: [] } : url.endsWith("/opponents") ? { opponents } : { evaluations: [] },
    ))));
    vi.stubGlobal("fetch", fetch);
    render(<Home openMatch={() => {}} />);
    await screen.findByText("暂无对局");
    expect(fetch.mock.calls.some((call) => call[0].includes("/evaluations"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "策略评估" }));
    await screen.findByRole("dialog", { name: "策略评估" });
    await screen.findByText("暂无评估");
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });
  it("选择同一 AI 两席时阻止创建", async () => {
    const fetch = installFetch();
    render(<Evaluations opponents={opponents} close={() => {}} openMatch={() => {}} />);
    await screen.findByText("暂无评估");
    fireEvent.change(screen.getByLabelText("席位 B · AI 对手"), { target: { value: "one" } });
    fireEvent.click(screen.getByRole("button", { name: "运行版本 A" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请选择两名独立 AI 对手");
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
  });
  it("打开和选择版本均不启动评估，点击后才提交精确版本与席位", async () => {
    const fetch = installFetch();
    render(<Evaluations opponents={opponents} close={() => {}} openMatch={() => {}} />);
    await screen.findByText("暂无评估");
    fireEvent.change(screen.getByLabelText("席位 A · 策略版本"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("席位 B · 策略版本"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("被评估席位"), { target: { value: "B" } });
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "运行版本 A" }));
    await screen.findByText("版本 A · v1");
    const post = fetch.mock.calls.find((call) => call[1]?.method === "POST")!;
    expect(post[0]).toBe("/api/evaluations");
    expect(JSON.parse(post[1].body)).toEqual({ players: [{ opponentId: "one", version: 2 }, { opponentId: "two", version: 1 }], evaluatedPlayer: "B" });
    expect(fetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("版本 B 只在手动提交后运行，固定对手不进入变更请求", async () => {
    const fetch = installFetch([evaluation]);
    const openMatch = vi.fn();
    render(<Evaluations opponents={opponents} close={() => {}} openMatch={openMatch} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI one.*AI two/ }));
    fireEvent.change(screen.getByLabelText("版本 B · 策略版本"), { target: { value: "3" } });
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "运行版本 B" }));
    await screen.findByText("版本 B · v3");
    const post = fetch.mock.calls.find((call) => call[1]?.method === "POST")!;
    expect(post[0]).toBe("/api/evaluations/eval-1/comparisons");
    expect(JSON.parse(post[1].body)).toEqual({ version: 3 });
    fireEvent.click(screen.getAllByRole("button", { name: "查看对局" })[0]!);
    expect(openMatch).toHaveBeenCalledWith("base-1");
    expect(screen.getByText(/单组结果仅反映此起点/)).toBeInTheDocument();
  });
  it("基准运行中禁止版本 B，刷新只读且错误保留在面板", async () => {
    const running = structuredClone(evaluation);
    running.baseline.match!.phase = "turn";
    running.baseline.match!.result = null;
    running.baseline.match!.runtime = { status: "running" };
    const fetch = installFetch([running]);
    render(<Evaluations opponents={opponents} close={() => {}} openMatch={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI one.*AI two/ }));
    expect(screen.getByRole("button", { name: "运行版本 B" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    await waitFor(() => expect(fetch.mock.calls.filter((call) => call[0] === "/api/evaluations").length).toBe(2));
    expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "READ_FAILED", message: "读取失败" } }), { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
  });
});
