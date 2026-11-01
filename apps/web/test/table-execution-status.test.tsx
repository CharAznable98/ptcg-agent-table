import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanActionView } from "../../../packages/protocol/src/index.ts";
import { HumanActionDock, TableExecutionStatus } from "../src/HumanActions.tsx";

afterEach(cleanup);
const action: HumanActionView = {
  id: "action", playerId: "A", intent: { kind: "end_turn" }, label: "结束回合",
  status: "running", revision: 3, eventIds: ["1", "2"],
};
describe("牌桌处理反馈", () => {
  it("修正过程按后端阶段显示，并在等待人选时退出", () => {
    const { rerender } = render(<TableExecutionStatus action={action} />);
    for (const [phase, label] of [["reviewing", "核对结算"], ["continuing", "继续结算"], ["rolling_back", "正在回滚"]] as const) {
      rerender(<TableExecutionStatus action={{ ...action, recovery: { phase, attempt: 1 } }} />);
      expect(screen.getByRole("status")).toHaveTextContent(label);
      expect(screen.getByRole("status")).toHaveTextContent(action.label);
    }
    rerender(<TableExecutionStatus action={{ ...action, status: "awaiting_choice", recovery: { phase: "continuing", attempt: 1 } }} />);
    expect(screen.queryByLabelText("牌桌处理状态")).toBeNull();
  });
  it("回滚动画仍清楚标明修正阶段，允许跳至最新牌桌", () => {
    const skip = vi.fn();
    render(<TableExecutionStatus action={{ ...action, recovery: { phase: "rolling_back", attempt: 2 } }} queued={2} onSkip={skip} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在回滚");
    expect(screen.getByRole("status")).toHaveTextContent("剩余 2 步");
    fireEvent.click(screen.getByRole("button", { name: "跳过动画，显示最新牌桌" }));
    expect(skip).toHaveBeenCalledOnce();
  });
  it("修正中的行动栏同步阶段，只保留停止入口，提交停止时禁用", () => {
    const control = vi.fn(async () => {});
    const props = { busy: false, enabled: true, onEndTurn: vi.fn(), onAnswer: vi.fn(async () => {}), onControl: control, manualMode: false, onManualMode: vi.fn() };
    const { rerender } = render(<HumanActionDock {...props} action={action} />);
    for (const [phase, label] of [["reviewing", "核对结算"], ["continuing", "继续结算"], ["rolling_back", "正在回滚"]] as const) {
      rerender(<HumanActionDock {...props} action={{ ...action, recovery: { phase, attempt: 1 } }} />);
      expect(screen.getByRole("status")).toHaveTextContent(label);
      expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: /代理修正|代理复核|结束回合/ })).toBeNull();
    }
    rerender(<HumanActionDock {...props} busy action={{ ...action, recovery: { phase: "rolling_back", attempt: 1 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
    expect(control).not.toHaveBeenCalled();
    rerender(<HumanActionDock {...props} action={{ ...action, recovery: { phase: "continuing", attempt: 1 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(control).toHaveBeenCalledExactlyOnceWith("cancel");
  });
  it("提交即显示，代理接管后呈现真实进度", () => {
    const { rerender } = render(<TableExecutionStatus busy />);
    expect(screen.getByText("正在提交行动")).toBeTruthy();
    rerender(<TableExecutionStatus action={action} />);
    expect(screen.getByText("结束回合")).toBeTruthy();
    expect(screen.getByText("已执行 2 步")).toBeTruthy();
    rerender(<TableExecutionStatus action={{ ...action, status: "awaiting_choice" }} />);
    expect(screen.queryByLabelText("牌桌处理状态")).toBeNull();
  });
  it("动画队列在后端完成后继续显示，可直接跳至最新", () => {
    const skip = vi.fn();
    render(<TableExecutionStatus action={{ ...action, status: "completed" }} queued={3} onSkip={skip} />);
    expect(screen.getByText("剩余 3 步")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "跳过动画，显示最新牌桌" }));
    expect(skip).toHaveBeenCalledOnce();
  });
  it("AI 处理也在牌桌显示，等待人选时退出", () => {
    const { rerender } = render(<TableExecutionStatus aiThinking />);
    expect(screen.getByText("AI 正在处理")).toBeTruthy();
    rerender(<TableExecutionStatus aiThinking action={{ ...action, status: "awaiting_choice" }} />);
    expect(screen.queryByLabelText("牌桌处理状态")).toBeNull();
  });
  it("停止开局处理后直接提供继续入口，避免误点结束回合", () => {
    const control = vi.fn(async () => {});
    const endTurn = vi.fn();
    render(<HumanActionDock action={{ ...action, intent: { kind: "turn_start" }, status: "cancelled" }}
      busy={false} enabled onEndTurn={endTurn} onAnswer={async () => {}} onControl={control}
      manualMode={false} onManualMode={() => {}} />);
    expect(screen.queryByRole("button", { name: "结束回合" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "继续开局" }));
    expect(control).toHaveBeenCalledWith("retry");
    expect(endTurn).not.toHaveBeenCalled();
  });
});
