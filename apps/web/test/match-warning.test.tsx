import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanActionView } from "../../../packages/protocol/src/index.ts";
import { Match } from "../src/Match.tsx";
import { MatchWarning, useMatchWarnings } from "../src/MatchWarning.tsx";
import { view } from "./fixtures.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Harness() {
  const { warning, notify, confirm } = useMatchWarnings();
  return <><button onClick={() => notify({ key: "one", title: "操作失败", message: "同一次失败" })}>失败一</button><button onClick={() => notify({ key: "two", title: "操作失败", message: "另一次失败" })}>失败二</button>{warning && <MatchWarning warning={warning} onConfirm={confirm} />}</>;
}
describe("必须确认的对局警告", () => {
  it("轮询重复失败只通知一次，不同失败依次确认且键盘焦点留在确认按钮", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("失败一"));
    expect(screen.getByRole("button", { name: "确认" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "确认" }), { key: "Tab" });
    expect(screen.getByRole("button", { name: "确认" })).toHaveFocus();
    act(() => screen.getByText("失败一").focus());
    fireEvent.mouseDown(screen.getByRole("alertdialog").parentElement!);
    expect(screen.getByRole("button", { name: "确认" })).toHaveFocus();
    fireEvent.click(screen.getByText("失败二"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("同一次失败");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("另一次失败");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    fireEvent.click(screen.getByText("失败一"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("异步代理失败自动弹出，确认后同一状态不重复，重试再失败重新提示", async () => {
    const current = structuredClone(view);
    const failed: HumanActionView = { id: "failed-action", playerId: "A", intent: { kind: "end_turn" }, label: "结束回合", status: "failed", revision: current.revision, eventIds: [], error: "夜巡灵身上没有附着能量，无法满足招式的能量要求。" };
    current.humanAction = failed;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = vi.fn(async (path: string) => {
      if (path.includes("/events?")) return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
      if (path.endsWith("/actions/activate")) return new Response("null");
      if (path.endsWith("/control")) { current.humanAction = { ...failed, status: "running" }; return new Response(JSON.stringify(current.humanAction)); }
      return new Response(JSON.stringify(current));
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => { render(<Match id={current.id} back={() => {}} />); });
    expect(await screen.findByRole("alertdialog", { name: "行动未完成" })).toHaveTextContent(failed.error!);
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    act(() => stream?.enqueue(new TextEncoder().encode("event: change\ndata: {}\n\n")));
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "代理修正" }));
    await screen.findByRole("button", { name: "停止" });
    current.humanAction = { ...failed };
    act(() => stream?.enqueue(new TextEncoder().encode("event: change\ndata: {}\n\n")));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveTextContent(failed.error!));
  });
});
