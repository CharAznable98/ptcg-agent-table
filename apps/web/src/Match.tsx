import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GameCommand,
  MatchView,
  ObjectView,
  PlayerId,
  Position,
  PublicEvent,
  Viewer,
} from "../../../packages/protocol/src/index.ts";
import {
  allowedViewers,
  api,
  downloadJson,
  jsonBody,
  matchPath,
  streamMatch,
  submitCommand,
} from "./api.ts";
import { ObjectInspector } from "./Cards.tsx";
import { MatchTable } from "./MatchTable.tsx";
import { MatchHistory } from "./MatchHistory.tsx";
import {
  DisputePanel,
  ObjectionEditor,
  RevealedCards,
  RandomResult,
  SetupChoice,
} from "./Choices.tsx";
import { Operations, type DestinationPick } from "./Operations.tsx";
import {
  Button,
  Busy,
  ErrorNote,
  JsonDetails,
  Modal,
  ConfirmAction,
} from "./ui.tsx";
import {
  objectAt,
  phaseNames,
  statusNames,
  togglePosition,
} from "./table-utils.ts";
export function Match({ id, back }: { id: string; back: () => void }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [view, setView] = useState<MatchView | null>(null);
  const [error, setError] = useState("");
  const [sync, setSync] = useState("连接中");
  const [selected, setSelected] = useState<Position[]>([]);
  const [destination, setDestination] = useState<DestinationPick>({
    key: "A:hand",
    index: 0,
  });
  const [inspecting, setInspecting] = useState<ObjectView | null>(null);
  const [objection, setObjection] = useState<PublicEvent | null>(null);
  const [receipt, setReceipt] = useState<unknown | null>(null);
  const [busy, setBusy] = useState(false);
  const [replay, setReplay] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [finishedLive, setFinishedLive] = useState(false);
  const [privacy, setPrivacy] = useState<Viewer | null>(null);
  const [previewing, setPreviewing] = useState<ObjectView | null>(null);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [located, setLocated] = useState<Position[]>([]);
  const [theme, setTheme] = useState("system");
  const [debug, setDebug] = useState(false);
  const [debugAction, setDebugAction] = useState<
    { kind: "restore"; event: PublicEvent } | { kind: "abort" } | null
  >(null);
  const reloadRef = useRef<() => void>(() => {});
  const previousOperator = useRef<PlayerId | null>(null);
  const latestView = useRef<MatchView | null>(null);
  const currentViewer = viewer ?? view?.viewer ?? "A";
  const refresh = useCallback(async () => {
    const next = await api<MatchView>(matchPath(id, viewer, replay));
    setView(next);
    setInspecting((current) =>
      current && objectAt(next, current.position) ? current : null,
    );
    setPreviewing((current) =>
      current && objectAt(next, current.position) ? current : null,
    );
    latestView.current = next;
    if (replay === null) {
      setTotal(next.events.length);
      setFinishedLive(next.flow.phase === "finished");
    } else setTotal(next.replay?.total ?? total);
    setError("");
    setSync("已同步");
  }, [id, viewer, replay]);
  useEffect(() => {
    setSelected([]);
    void refresh().catch((error) => setError(error.message));
  }, [refresh]);
  useEffect(() => {
    setInspecting(null);
    setPreviewing(null);
    setLocated([]);
  }, [viewer, replay]);
  useEffect(() => {
    reloadRef.current = () => {
      void refresh().catch((error) => setError(error.message));
    };
  }, [refresh]);
  useEffect(() => {
    if (replay !== null) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setInterval> | undefined;
    let queued = false;
    const notify = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        reloadRef.current();
      }, 120);
    };
    const connect = async () => {
      try {
        setSync("实时连接中");
        await streamMatch(
          id,
          viewer,
          latestView.current?.cursor ?? "",
          notify,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setSync("正在重连");
          retry = setTimeout(() => void connect(), 1800);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setSync("轮询同步中");
        reloadRef.current();
        retry = setTimeout(() => void connect(), 3000);
      }
    };
    void connect();
    fallback = setInterval(() => reloadRef.current(), 5000);
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
      if (fallback) clearInterval(fallback);
    };
  }, [id, viewer, replay]);
  useEffect(() => {
    if (!view || view.mode !== "local" || replay !== null) return;
    if (
      previousOperator.current &&
      previousOperator.current !== view.flow.operator &&
      currentViewer !== view.flow.operator
    )
      setPrivacy(view.flow.operator);
    previousOperator.current = view.flow.operator;
  }, [view?.flow.operator, view?.mode, replay, currentViewer]);
  async function execute(command: GameCommand) {
    if (!view) throw new Error("牌桌尚未加载");
    if (view.viewer === "omniscient") throw new Error("全知视角不可操作");
    if (!view.players.some(
      (player) => player.id === view.viewer && player.kind === "human",
    ))
      throw new Error("AI 席位由后端 agent 操作");
    setBusy(true);
    try {
      const result = await submitCommand(
        id, view.revision, command, view.viewer,
      );
      if (result.status === "rejected") throw new Error(result.error.message);
      if (result.status === "not_executed") throw new Error(result.reason);
      setSelected([]);
      if (["look", "show", "random"].includes(command.kind))
        setReceipt(result.result);
      await refresh();
    } catch (error) {
      void refresh();
      throw error;
    } finally {
      setBusy(false);
    }
  }
  const finished = view?.flow.phase === "finished";
  const viewers = view
    ? allowedViewers(view, finishedLive && replay !== null)
    : [];
  const humanSeat = view?.players.some(
    (player) => player.id === currentViewer && player.kind === "human",
  );
  const canOperate = Boolean(
    view &&
      humanSeat &&
      replay === null &&
      view.flow.operator === currentViewer &&
      view.flow.phase !== "setup" &&
      !finished &&
      !view.dispute?.status.match(
        /^(awaiting_response|awaiting_judge|applying)$/,
      ),
  );
  const canRespond = Boolean(
    view &&
      humanSeat &&
      replay === null &&
      view.dispute?.respondent === currentViewer,
  );
  const canChoice = Boolean(
    view &&
      humanSeat &&
      replay === null &&
      view.flow.choice?.playerId === currentViewer &&
      !finished,
  );
  async function control(action: "run" | "pause" | "resume" | "step") {
    setBusy(true);
    try {
      await api(
        `/matches/${id}/control`,
        { method: "POST", body: jsonBody({ action }) },
      );
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changeViewer(next: Viewer) {
    if (view?.mode === "local" && replay === null && next !== currentViewer) {
      setPrivacy(next);
      return;
    }
    applyViewer(next);
  }
  function applyViewer(next: Viewer) {
    setView(null);
    setViewer(next);
    setInspecting(null);
    setPreviewing(null);
    setReceipt(null);
    setSelected([]);
  }
  const playerName = (seat: PlayerId | null) =>
    seat
      ? (view?.players.find((player) => player.id === seat)?.name ?? seat)
      : "无";
  const result = view?.flow.result;
  const inspectionSource = inspecting ?? previewing;
  // 详情沿用当前投影，不把点击时的旧状态伪装为实时状态。
  const inspected =
    view && inspectionSource ? objectAt(view, inspectionSource.position) : null;
  const replayControls =
    replay !== null ? (
      <section className="replay-bar">
        <b>历史回放</b>
        <Button
          title="回到开始"
          disabled={replay <= 0}
          onClick={() => setReplay(0)}
        >
          起点
        </Button>
        <Button disabled={replay <= 0} onClick={() => setReplay(replay - 1)}>
          上一步
        </Button>
        <input
          type="range"
          aria-label="回放进度"
          min="0"
          max={total}
          value={replay}
          onChange={(event) => {
            setInspecting(null);
            setPreviewing(null);
            setReplay(Number(event.target.value));
          }}
        />
        <span>
          {replay} / {total}
        </span>
        <Button
          disabled={replay >= total}
          onClick={() => setReplay(replay + 1)}
        >
          下一步
        </Button>
        <Button
          title="跳到末尾"
          disabled={replay >= total}
          onClick={() => setReplay(total)}
        >
          末尾
        </Button>
      </section>
    ) : null;
  const activeDispute = view?.dispute && view.dispute.status !== "closed";
  return (
    <main
      data-theme={theme}
      className={`match-page match-workspace ${historyOpen ? "history-drawer-open" : ""}`}
    >
      <header className="match-header">
        <div className="match-header-main">
          <Button kind="match-back" onClick={back} title="返回对局记录">
            PTCG
          </Button>
          <h1 title={view?.players.map((player) => player.name).join(" vs ")}>
            {view?.players.map((player) => player.name).join(" vs ") ??
              "加载中…"}
          </h1>
          <div className="match-header-actions">
            <label className="viewer-select">
              视角
              <select
                aria-label="牌桌视角"
                value={currentViewer}
                onChange={(event) => changeViewer(event.target.value as Viewer)}
              >
                {viewers.map((value) => (
                  <option value={value} key={value}>
                    {value === "omniscient"
                      ? "全知观战"
                      : `${value} · ${playerName(value)}`}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={!view}
              onClick={() => {
                setInspecting(null);
                setPreviewing(null);
                if (replay === null) setReplay(total);
                else {
                  const liveViewers = allowedViewers(view!, false);
                  if (!liveViewers.includes(currentViewer))
                    applyViewer(liveViewers[0] ?? "A");
                  setReplay(null);
                }
              }}
            >
              {replay === null ? "逐步回放" : "返回实时"}
            </Button>
            <Button
              kind="mobile-history-toggle"
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              {historyOpen ? "关闭记录" : "对局记录"}
            </Button>
            {humanSeat && replay === null && (
              <Button onClick={() => setOperationsOpen(!operationsOpen)}>
                {operationsOpen ? "收起操作" : "牌桌操作"}
              </Button>
            )}
            <details className="match-menu">
              <summary>更多</summary>
              <div>
                <Button
                  onClick={() => {
                    void api(`/matches/${id}/export`)
                      .then((value) => downloadJson(value, `ptcg-${id}.json`))
                      .catch((error) => setError(error.message));
                  }}
                >
                  导出单局
                </Button>
                <Button onClick={() => setDebug(!debug)}>
                  {debug ? "关闭调试" : "调试"}
                </Button>
                <label className="theme-select">
                  外观
                  <select
                    aria-label="界面外观"
                    value={theme}
                    onChange={(event) => setTheme(event.target.value)}
                  >
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </label>
              </div>
            </details>
          </div>
        </div>
        {view && (
          <div className="match-status-line">
            <span className="flow-phase">{phaseNames[view.flow.phase]}</span>
            {view.evaluation && <span className="runtime-status">策略评估</span>}
            <span className="turn-status">
              第 {view.flow.turnNumber} 回合
              {view.flow.turnOwner
                ? ` / ${playerName(view.flow.turnOwner)}`
                : ""}
            </span>
            {!finished && (
              <span className="operator-status">
                {playerName(view.flow.operator)}
                {view.runtime.status === "running"
                  ? " 正在思考"
                  : " 持有操作权"}
              </span>
            )}
            <span className="runtime-status">
              {replay === null ? statusNames[view.runtime.status] : "历史回放"}
            </span>
            <span className="sync-status" title={sync}>
              {sync}
            </span>
            {view.runtime.modelCalls !== undefined && (
              <span className="model-call-count">
                {view.runtime.modelCalls} 次调用
              </span>
            )}
            {replayControls ?? (
              <div className="runtime-controls">
                {(["run", "pause", "resume", "step"] as const).map(
                  (action, index) => (
                    <Button
                      key={action}
                      disabled={
                        busy ||
                        Boolean(finished) ||
                        replay !== null ||
                        (action === "pause" &&
                          view.runtime.status !== "running") ||
                        (action === "resume" &&
                          !["paused", "aborted"].includes(
                            view.runtime.status,
                          )) ||
                        (action === "run" && view.runtime.status === "running")
                      }
                      onClick={() => void control(action)}
                    >
                      {["运行 AI", "暂停", "继续", "单步"][index]}
                    </Button>
                  ),
                )}
              </div>
            )}
          </div>
        )}
        <ErrorNote value={error} />
        {view?.runtime.error && (
          <ErrorNote value={`AI 运行：${view.runtime.error}`} />
        )}
        {result && view && (
          <section className="result-banner">
            <h2>
              {result.kind === "win"
                ? `${playerName(result.winner)} 获胜`
                : result.kind === "draw"
                  ? "本局平局"
                  : "异常结束"}
            </h2>
            <p title={result.reason}>{result.reason}</p>
            {!view.evaluation && Object.entries(view.summaries).map(([seat, summary]) => (
              <small key={seat}>
                {seat} 策略
                {summary?.status === "completed"
                  ? `已保存 v${summary.version}`
                  : summary?.status === "failed"
                    ? `：${summary.error}`
                    : "正在总结…"}
              </small>
            ))}
            {!view.evaluation && replay === null &&
              view.players.some(
                (player) =>
                  player.kind === "ai" &&
                  view.summaries[player.id]?.status !== "completed",
              ) && (
                <Button
                  disabled={busy || view.runtime.status === "running"}
                  onClick={() => void control("resume")}
                >
                  重试策略总结
                </Button>
              )}
          </section>
        )}
      </header>
      {!view ? (
        <Busy />
      ) : (
        <>
          <div className="match-layout">
            <div className="table-column">
              <MatchTable
                view={view}
                viewer={view.viewer}
                selected={selected}
                highlighted={located}
                interactive={Boolean(humanSeat && replay === null)}
                onSelect={(position) =>
                  setSelected(togglePosition(selected, position))
                }
                onInspect={(object) => {
                  setInspecting(object);
                  setPreviewing(null);
                }}
                onPreview={setPreviewing}
                onDestination={(key, index) => setDestination({ key, index })}
              />
              {view.flow.choice && !canChoice && !finished && (
                <div className="table-waiting" role="status">
                  等待 {playerName(view.flow.choice.playerId)}{" "}
                  {view.flow.choice.kind === "choose_first"
                    ? "选择先后攻"
                    : view.flow.choice.kind === "initial_placement"
                      ? "摆放宝可梦"
                      : view.flow.choice.kind === "mulligan_draw"
                        ? "选择补抽数量"
                        : view.flow.choice.kind === "result_confirm"
                          ? "确认结果"
                          : "完成选择"}
                </div>
              )}
              {canChoice && (
                <div className="flow-overlay">
                  <SetupChoice
                    key={`${view.flow.choice?.kind}-${view.flow.choice?.playerId}`}
                    view={view}
                    execute={execute}
                    busy={busy}
                    canAct={canChoice}
                  />
                </div>
              )}
              {activeDispute && (
                <div className="flow-overlay dispute-overlay">
                  <DisputePanel
                    view={view}
                    execute={execute}
                    busy={busy}
                    canRespond={canRespond}
                  />
                </div>
              )}
              {operationsOpen && (
                <section
                  className="operations-drawer"
                  aria-label="牌桌操作面板"
                >
                  <Button
                    kind="drawer-close"
                    title="关闭牌桌操作"
                    onClick={() => setOperationsOpen(false)}
                  >
                    关闭
                  </Button>
                  <Operations
                    view={view}
                    selected={selected}
                    setSelected={setSelected}
                    destination={destination}
                    setDestination={setDestination}
                    execute={execute}
                    busy={busy}
                    enabled={canOperate}
                    canConcede={Boolean(
                      humanSeat && replay === null && !finished,
                    )}
                  />
                </section>
              )}
              {debug && (
                <section className="debug-drawer" aria-label="调试面板">
                  <header>
                    <b>调试</b>
                    <Button
                      title="关闭调试面板"
                      onClick={() => setDebug(false)}
                    >
                      关闭
                    </Button>
                  </header>
                  <p>调试操作保留系统记录。</p>
                  <Button
                    onClick={() => {
                      const event = view.events.find(
                        (event) => !event.revokedBy && event.actor !== "system",
                      );
                      if (!event) {
                        setError("没有可恢复的记录");
                        return;
                      }
                      setDebugAction({ kind: "restore", event });
                    }}
                  >
                    恢复到首个玩家操作前
                  </Button>
                  <Button
                    kind="danger"
                    onClick={() => setDebugAction({ kind: "abort" })}
                  >
                    中止运行并留记录
                  </Button>
                  <Button onClick={() => reloadRef.current()}>重新读取</Button>
                </section>
              )}
              {inspected && (
                <ObjectInspector
                  object={inspected}
                  pinned={Boolean(inspecting)}
                  close={() => {
                    setInspecting(null);
                    setPreviewing(null);
                  }}
                  selected={selected}
                  onSelect={(position) =>
                    setSelected(togglePosition(selected, position))
                  }
                />
              )}
            </div>
            <MatchHistory
              view={view}
              canObject={replay === null && canOperate}
              debug={debug}
              onObject={setObjection}
              onRestore={(event) => setDebugAction({ kind: "restore", event })}
              onLocate={(positions) => setLocated(positions)}
            />
          </div>
        </>
      )}
      {debugAction && (
        <ConfirmAction
          title={debugAction.kind === "restore" ? "恢复牌桌" : "中止运行"}
          description={
            debugAction.kind === "restore" ? (
              <p>
                确认恢复到 #{debugAction.event.sequence}「
                {debugAction.event.label}
                」执行前？牌桌与流程会恢复，原历史和已获知信息保留，并留下调试记录。
              </p>
            ) : (
              <p>中止 AI 运行并保存当前牌桌及原因。此操作不自动判定胜负。</p>
            )
          }
          confirmLabel={
            debugAction.kind === "restore" ? "确认恢复牌桌" : "确认中止并留记录"
          }
          {...(debugAction.kind === "abort" ? { reasonLabel: "中止原因" } : {})}
          close={() => setDebugAction(null)}
          onConfirm={async (reason) => {
            setBusy(true);
            try {
              await api(`/matches/${id}/debug`, {
                method: "POST",
                body: jsonBody(
                  debugAction.kind === "restore"
                    ? { kind: "restore", targetEventId: debugAction.event.id }
                    : { kind: "abort", reason },
                ),
              });
              await refresh();
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {objection && view && (
        <ObjectionEditor
          event={objection}
          view={view}
          close={() => setObjection(null)}
          execute={execute}
        />
      )}
      {receipt !== null && (
        <Modal title="本次操作的结果" close={() => setReceipt(null)} wide>
          <RandomResult value={receipt} />
          <RevealedCards value={receipt} />
          <JsonDetails label="结构化反馈" value={receipt} />
          <Button onClick={() => setReceipt(null)}>已查看</Button>
        </Modal>
      )}
      {privacy && (
        <div className="privacy-curtain">
          <h1>请将设备交给玩家 {privacy}</h1>
          <Button
            kind="primary large"
            onClick={() => {
              applyViewer(privacy);
              setPrivacy(null);
            }}
          >
            我是玩家 {privacy}，查看牌桌
          </Button>
        </div>
      )}
    </main>
  );
}
