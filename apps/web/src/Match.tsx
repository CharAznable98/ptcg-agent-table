import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GameCommand,
  MatchView,
  ObjectView,
  PlayerId,
  Position,
  PublicEvent,
  Viewer,
  HumanActionIntent,
  HumanActionView,
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
import { PokemonFocus, pokemonOf } from "./PokemonFocus.tsx";
import { MatchWarning, useMatchWarnings } from "./MatchWarning.tsx";
import { MatchTable } from "./MatchTable.tsx";
import { MatchHistory } from "./MatchHistory.tsx";
import { buildActionHistory, type ActionStep } from "./action-history.ts";
import { actionAt, actionKeyframes, nextAction, previousActionIndex } from "./replay-navigation.ts";
import { presentEvent } from "./event-presentation.ts";
import { TableMotion } from "./TableMotion.tsx";
import { useLivePresentation } from "./live-presentation.ts";
import { HumanActionDock, SetupPlacementBar, TableExecutionStatus, type SetupPlacement } from "./HumanActions.tsx";
import { startHumanAction, activateHumanTurn, answerHumanChoice, controlHumanAction } from "./human-action-api.ts";
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
  JsonDetails,
  Modal,
  ConfirmAction,
} from "./ui.tsx";
import {
  objectAt,
  phaseNames,
  statusNames,
  togglePosition,
  selectionFromPositions,
} from "./table-utils.ts";
export function Match({ id, back }: { id: string; back: () => void }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [view, setView] = useState<MatchView | null>(null);
  const { warning, notify, confirm: confirmWarning, clear: clearWarnings } = useMatchWarnings();
  const errorAttempt = useRef(0);
  const setError = useCallback((message: string) => {
    if (!message) { errorAttempt.current++; return; }
    notify({ key: `request:${errorAttempt.current}:${message}`, title: "操作失败", message });
  }, [notify]);
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
  const [activatingHuman, setActivatingHuman] = useState(false);
  const [replay, setReplay] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [historyEvents, setHistoryEvents] = useState<PublicEvent[]>([]);
  const historyViewer = useRef<string>("");
  const [playback, setPlayback] = useState<{ step: ActionStep; frames: number[]; next: number } | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [concedeOpen, setConcedeOpen] = useState(false);
  const [returningLive, setReturningLive] = useState(false);
  const [setupPlacement, setSetupPlacement] = useState<SetupPlacement>({ bench: [] });
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
  const refreshSequence = useRef(0);
  const submittingHuman = useRef(false);
  const activatedTurn = useRef("");
  const currentViewer = viewer ?? view?.viewer ?? "A";
  const refresh = useCallback(async () => {
    const requestSequence = ++refreshSequence.current;
    const next = await api<MatchView>(matchPath(id, viewer, replay));
    if (requestSequence !== refreshSequence.current) return;
    const projection = `${id}:${next.viewer}`;
    if (replay === null || replay === next.replay?.total) {
      historyViewer.current = projection;
      setHistoryEvents(next.events);
    } else if (historyViewer.current !== projection) {
      const full = await api<MatchView>(matchPath(id, viewer, next.replay?.total ?? next.events.length));
      if (requestSequence !== refreshSequence.current) return;
      historyViewer.current = projection;
      setHistoryEvents(full.events);
    }
    setView(next);
    if (replay === null) setReturningLive(false);
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
    } else setTotal(next.replay?.total ?? next.events.length);
    setSync("已同步");
  }, [id, viewer, replay]);
  const actions = useMemo(() => buildActionHistory(historyEvents), [historyEvents]);
  const { displayView, presenting, pendingSteps, skipToLatest } = useLivePresentation(view, replay === null);
  const currentAction = replay === null ? actionAt(actions, displayView?.events.length ?? 0) : actionAt(actions, replay);
  const humanAction = view?.humanAction;
  const previousFailure = useRef("");
  const failureEpisode = useRef(0);
  useEffect(() => {
    if (replay !== null) return;
    if (humanAction?.status !== "failed") { previousFailure.current = ""; return; }
    const signature = `${humanAction.id}:${humanAction.error ?? ""}`;
    if (signature === previousFailure.current) return;
    previousFailure.current = signature;
    notify({ key: `human:${signature}:${++failureEpisode.current}`, title: "行动未完成", message: humanAction.error || "执行中断，请让代理修正后继续。" });
  }, [replay, humanAction, notify]);
  const previousRuntimeError = useRef("");
  useEffect(() => {
    if (replay !== null) return;
    const message = view?.runtime.error ?? "";
    if (message && message !== previousRuntimeError.current) notify({ key: `runtime:${++failureEpisode.current}`, title: "AI 运行中断", message });
    previousRuntimeError.current = message;
  }, [replay, view?.runtime.error, notify]);
  const loadingReplay = replay !== null && Boolean(view) && view?.replay?.index !== replay && (!playback || playback.next === 0);
  const executorActive = humanAction?.status === "running" || humanAction?.status === "awaiting_choice";
  const executionLocked = executorActive || Boolean(humanAction?.requiresResolution);
  const directLocked = executorActive || Boolean(humanAction?.requiresResolution && !manualMode);
  function playAction(step: ActionStep) {
    setInspecting(null);
    setPreviewing(null);
    setError("");
    setManualMode(false);
    setPlayback({ step, frames: actionKeyframes(step, historyEvents), next: 0 });
    setReplay(step.startIndex);
  }
  function seekReplay(index: number) {
    setPlayback(null);
    setInspecting(null);
    setPreviewing(null);
    setReplay(index);
  }
  useEffect(() => {
    if (!playback || replay === null || view?.replay?.index !== replay) return;
    const frame = playback.frames[playback.next];
    const timer = setTimeout(() => {
      if (frame === undefined) setPlayback(null);
      else {
        setPlayback(current => current ? { ...current, next: current.next + 1 } : null);
        setReplay(frame);
      }
    }, playback.next === 0 ? 120 : window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 120 : 650);
    return () => clearTimeout(timer);
  }, [playback, replay, view]);
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
    setManualMode(false);
  }, [viewer, view?.flow.operator]);
  useEffect(() => { setSetupPlacement({ bench: [] }); }, [viewer, view?.flow.choice?.kind, view?.flow.choice?.playerId]);
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
    let notification: ReturnType<typeof setTimeout> | undefined;
    let queued = false;
    const notify = () => {
      if (queued) return;
      queued = true;
      notification = setTimeout(() => {
        queued = false;
        if (!controller.signal.aborted) reloadRef.current();
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
      if (notification) clearTimeout(notification);
    };
  }, [id, viewer, replay]);
  useEffect(() => {
    if (!view || view.mode !== "local" || replay !== null || presenting) return;
    if (
      previousOperator.current &&
      previousOperator.current !== view.flow.operator &&
      currentViewer !== view.flow.operator
    )
      setPrivacy(view.flow.operator);
    previousOperator.current = view.flow.operator;
  }, [view?.flow.operator, view?.mode, replay, currentViewer, presenting]);
  async function execute(command: GameCommand) {
    if (!view) throw new Error("牌桌尚未加载");
    if (view.viewer === "omniscient") throw new Error("全知视角不可操作");
    if (!view.players.some(
      (player) => player.id === view.viewer && player.kind === "human",
    ))
      throw new Error("AI 席位由后端 agent 操作");
    setBusy(true);
    setError("");
    try {
      const result = await submitCommand(
        id, view.revision, command, view.viewer,
      );
      if (result.status === "rejected") throw new Error(result.error.message);
      if (result.status === "not_executed") throw new Error(result.reason);
      if (!manualMode || command.kind !== "set_state") setSelected([]);
      if (["look", "show", "random"].includes(command.kind))
        setReceipt(result.result);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作失败");
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
  useEffect(() => {
    if (replay !== null) { activatedTurn.current = ""; return; }
    if (!view || view.id !== id || view.replay || returningLive || !humanSeat || view.viewer === "omniscient" || view.flow.phase !== "turn"
      || view.flow.turnOwner !== view.viewer || view.flow.operator !== view.viewer) return;
    const key = `${id}:${view.viewer}:${view.flow.turnNumber}`;
    if (activatedTurn.current === key) return;
    activatedTurn.current = key;
    let disposed = false;
    setActivatingHuman(true);
    // 实时牌桌显式激活；GET、历史与导出本身始终只读。
    void activateHumanTurn(id, view.viewer).then(action => {
      if (!disposed && action) reloadRef.current();
    }).catch(error => {
      if (!disposed) setError(error instanceof Error ? error.message : "回合准备失败");
    }).finally(() => { if (!disposed) setActivatingHuman(false); });
    return () => { disposed = true; setActivatingHuman(false); };
  }, [id, replay, returningLive, humanSeat, view?.viewer, Boolean(view?.replay), view?.flow.phase, view?.flow.turnOwner, view?.flow.operator, view?.flow.turnNumber]);
  const canOperate = Boolean(
    view &&
      humanSeat &&
      replay === null &&
      !returningLive &&
      !activatingHuman &&
      !presenting &&
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
      !returningLive &&
      !presenting &&
      view.dispute?.respondent === currentViewer,
  );
  const canChoice = Boolean(
    view &&
      humanSeat &&
      replay === null &&
      !returningLive &&
      !presenting &&
      view.flow.choice?.playerId === currentViewer &&
      !finished,
  );
  const placementMode = canChoice && ["initial_placement", "additional_bench"].includes(view?.flow.choice?.kind ?? "");
  const handoffMode = canChoice && view?.flow.choice?.kind === "handoff";
  async function confirmPlacement() {
    setInspecting(null); setPreviewing(null);
    try {
      const slots = setupPlacement.benchSlots ? { benchSlots: setupPlacement.benchSlots } : {};
      if (view?.flow.choice?.kind === "initial_placement") {
        if (!setupPlacement.active) throw new Error("请先拖入战斗宝可梦");
        await execute({ kind: "initial_placement", active: setupPlacement.active, bench: setupPlacement.bench, ...slots });
      } else await execute({ kind: "additional_bench", bench: setupPlacement.bench, ...slots });
    } catch (error) { setError((error as Error).message); }
  }
  const updateHuman = (action: HumanActionView) => {
    if (action.status !== "failed") previousFailure.current = "";
    setView(current => current ? { ...current, humanAction: action } : current);
  };
  async function beginHuman(intent: HumanActionIntent) {
    if (!view || view.viewer === "omniscient" || !canOperate || executionLocked || submittingHuman.current) return;
    submittingHuman.current = true;
    setBusy(true);
    setError("");
    setInspecting(null);
    setPreviewing(null);
    try {
      const action = await startHumanAction(id, { playerId: view.viewer, requestId: crypto.randomUUID(), revision: view.revision, intent });
      updateHuman(action);
      await refresh();
    } catch (error) {
      setError((error as Error).message);
      void refresh();
    } finally { submittingHuman.current = false; setBusy(false); }
  }
  async function answerChoice(answer: { choiceId: string; selected: string[]; number?: number }) {
    if (!view || view.viewer === "omniscient" || !humanAction || presenting) return;
    setBusy(true); setError("");
    try {
      updateHuman(await answerHumanChoice(id, humanAction.id, { ...answer, playerId: view.viewer, requestId: crypto.randomUUID(), revision: view.revision }));
      await refresh();
    } catch (error) { setError((error as Error).message); throw error; }
    finally { setBusy(false); }
  }
  async function controlExecution(action: "retry" | "cancel" | "repair" | "manual") {
    if (!view || view.viewer === "omniscient" || !humanAction) return;
    if (action !== "cancel") setManualMode(false);
    setBusy(true); setError("");
    try {
      const result = await controlHumanAction(id, humanAction.id, view.viewer, action);
      if (action !== "cancel") previousFailure.current = "";
      updateHuman(result); await refresh();
    }
    catch (error) { setError((error as Error).message); throw error; }
    finally { setBusy(false); }
  }
  async function toggleManual(value: boolean) {
    if (value && (!canOperate || executorActive)) return;
    setInspecting(null); setPreviewing(null); setError("");
    try {
      // 由服务端明确进入手动修正范围，保留原行动的未结算义务。
      if (value && humanAction && (humanAction.status === "failed" || humanAction.requiresResolution)) await controlExecution("manual");
      setManualMode(value);
    } catch (error) { setError((error as Error).message); }
  }
  async function manuallyMove(source: Position, target: Position) {
    if (!view || view.viewer === "omniscient" || !manualMode || !canOperate || busy || executorActive) return;
    const seat = view.viewer;
    setBusy(true); setError("");
    try {
      let current = await api<MatchView>(matchPath(id, seat, null));
      const send = async (command: GameCommand) => {
        const result = await submitCommand(id, current.revision, command, seat);
        if (result.status === "rejected") throw new Error(result.error.message);
        if (result.status === "not_executed") throw new Error(result.reason);
        current = await api<MatchView>(matchPath(id, seat, null));
      };
      const moved = objectAt(current, source), destination = objectAt(current, target);
      if (!moved) throw new Error("来源卡牌已变化，请重新拖动");
      if (moved.kind === "group" && destination?.kind === "group" && !source.member && !target.member) {
        const stagingId = `${seat}:staging`;
        const stagingIndex = current.zones.find(zone => zone.id === stagingId)?.items.length ?? 0;
        await send({ kind: "move", source: selectionFromPositions([source]), destination: { container: { kind: "zone", zoneId: stagingId }, index: "end" } });
        await send({ kind: "move", source: selectionFromPositions([target]), destination: { container: { kind: "zone", zoneId: source.zoneId }, index: source.index } });
        await send({ kind: "move", source: selectionFromPositions([{ zoneId: stagingId, index: stagingIndex }]), destination: { container: { kind: "zone", zoneId: target.zoneId }, index: target.index } });
      } else {
        const pokemon = moved.kind === "card" && moved.card.kind === "pokemon";
        if (pokemon && !destination && /:(active|bench)$/.test(target.zoneId)) {
          await send({ kind: "create_group", destination: { container: { kind: "zone", zoneId: target.zoneId }, index: target.index } });
        }
        const intoGroup = destination?.kind === "group" || (pokemon && !destination && /:(active|bench)$/.test(target.zoneId));
        await send({ kind: "move", source: selectionFromPositions([source]), destination: {
          container: intoGroup ? { kind: "group", position: { zoneId: target.zoneId, index: target.index }, relation: pokemon ? "stack" : "attached" } : { kind: "zone", zoneId: target.zoneId },
          index: intoGroup ? "end" : target.index,
        } });
      }
      setSelected([]); await refresh();
    } catch (error) { setError((error as Error).message); void refresh(); }
    finally { setBusy(false); }
  }
  async function control(action: "run" | "pause" | "resume" | "step") {
    setBusy(true);
    setError("");
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
    ++refreshSequence.current;
    setPlayback(null);
    setReturningLive(false);
    setHistoryEvents([]);
    historyViewer.current = "";
    setView(null);
    setViewer(next);
    setInspecting(null);
    setPreviewing(null);
    setReceipt(null);
    setSelected([]);
    clearWarnings();
  }
  const playerName = (seat: PlayerId | null) =>
    seat
      ? (view?.players.find((player) => player.id === seat)?.name ?? seat)
      : "无";
  const result = view?.flow.result;
  const inspectionSource = inspecting ?? previewing;
  // 详情沿用当前投影，不把点击时的旧状态伪装为实时状态。
  const inspected =
    displayView && inspectionSource ? objectAt(displayView, inspectionSource.position) : null;
  const focusedPokemon = Boolean(inspecting && inspected?.kind === "group" && pokemonOf(inspected) && !manualMode);
  const actionProgress = replay === null ? actions.length : actions.filter(action => action.endIndex <= replay).length;
  const frameEvent = replay === null || !replay ? undefined : historyEvents[replay - 1];
  const frameTitle = frameEvent ? presentEvent(frameEvent, historyEvents[replay! - 2]).title : "对局开始";
  const replayControls =
    replay !== null ? (
      <section className="replay-bar">
        <b>历史回放</b>
        <Button
          title="回到开始"
          disabled={replay <= 0}
          onClick={() => seekReplay(0)}
        >
          起点
        </Button>
        <Button disabled={replay <= 0} onClick={() => seekReplay(previousActionIndex(actions, replay))}>
          上一步
        </Button>
        <input
          type="range"
          aria-label="回放进度"
          min="0"
          max={actions.length}
          value={actionProgress}
          disabled={!actions.length}
          aria-valuetext={`${actionProgress} / ${actions.length} 个行动`}
          onChange={(event) => {
            seekReplay(actions[Number(event.target.value) - 1]?.endIndex ?? 0);
          }}
        />
        <span className="replay-action-counter">
          {actionProgress} / {actions.length} 行动
        </span>
        <Button
          disabled={replay >= total}
          onClick={() => { const action = nextAction(actions, replay); if (action) playAction(action); }}
        >
          下一步
        </Button>
        <Button
          title="跳到末尾"
          disabled={replay >= total}
          onClick={() => seekReplay(total)}
        >
          末尾
        </Button>
        <Button kind="replay-stop" title={playback ? "暂停演示" : "重播当前行动"} disabled={!playback && !currentAction}
          onClick={() => { if (playback) setPlayback(null); else if (currentAction) playAction(currentAction); }}>
          {playback ? "暂停" : "重播"}
        </Button>
        <div className="replay-action-caption" role="status" aria-live="polite">
          <strong title={playback?.step.title ?? currentAction?.title ?? "对局开始"}>{playback?.step.title ?? currentAction?.title ?? "对局开始"}</strong>
          <small title={frameTitle}>{frameTitle}</small>
        </div>
      </section>
    ) : null;
  const activeDispute = view?.dispute && view.dispute.status !== "closed";
  return (
    <main
      data-theme={theme}
      className={`match-page match-workspace ${historyOpen ? "history-drawer-open" : ""} ${returningLive || loadingReplay ? "is-returning-live" : ""}`}
      aria-busy={returningLive || loadingReplay || undefined}
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
              disabled={!view || returningLive}
              onClick={() => {
                setPlayback(null);
                setManualMode(false);
                setInspecting(null);
                setPreviewing(null);
                if (replay === null) setReplay(total);
                else {
                  ++refreshSequence.current;
                  setReturningLive(true);
                  setSync("正在读取最新牌桌");
                  const liveViewers = allowedViewers(view!, false);
                  if (!liveViewers.includes(currentViewer))
                    applyViewer(liveViewers[0] ?? "A");
                  setReplay(null);
                }
              }}
            >
              {returningLive ? "读取中" : replay === null ? "逐步回放" : "返回实时"}
            </Button>
            <Button
              kind="mobile-history-toggle"
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              {historyOpen ? "关闭记录" : "对局记录"}
            </Button>
            {debug && humanSeat && replay === null && (
              <Button onClick={() => setOperationsOpen(!operationsOpen)}>
                {operationsOpen ? "收起底层操作" : "底层操作"}
              </Button>
            )}
            <details className="match-menu">
              <summary>更多</summary>
              <div>
                {humanSeat && replay === null && !finished && <Button onClick={() => setConcedeOpen(true)} disabled={busy || executionLocked || presenting}>认输</Button>}
                <Button
                  onClick={() => {
                    setError("");
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
            <span className="flow-phase">{returningLive || loadingReplay ? "同步中" : phaseNames[view.flow.phase]}</span>
            {view.evaluation && <span className="runtime-status">策略评估</span>}
            <span className="turn-status">
              第 {view.flow.turnNumber} 回合
              {view.flow.turnOwner
                ? ` / ${playerName(view.flow.turnOwner)}`
                : ""}
            </span>
            {!finished && !returningLive && !loadingReplay && (
              <span className="operator-status" title={handoffMode ? view.flow.choice?.message : undefined}>
                {handoffMode ? view.flow.choice?.message || "等待你处理对方效果" : `${playerName(view.flow.operator)}${view.runtime.status === "running" ? " 正在思考" : " 持有操作权"}`}
              </span>
            )}
            <span className="runtime-status">
              {returningLive ? "读取最新牌桌" : loadingReplay ? "读取历史牌桌" : replay === null ? statusNames[view.runtime.status] : "历史回放"}
            </span>
            <span className="sync-status" title={sync}>
              {loadingReplay ? "正在读取历史牌桌" : sync}
            </span>
            {view.runtime.modelCalls !== undefined && (
              <span className="model-call-count">
                {view.runtime.modelCalls} 次调用
              </span>
            )}
            {replayControls ?? (placementMode ? (
              <SetupPlacementBar view={view} placement={setupPlacement} busy={busy}
                onConfirm={() => void confirmPlacement()} onClear={() => setSetupPlacement({ bench: [] })} />
            ) : humanSeat && !finished && !returningLive && view.flow.phase !== "setup" && (view.flow.operator === currentViewer || executionLocked) ? (
              <HumanActionDock action={presenting && humanAction?.status === "awaiting_choice" ? { ...humanAction, status: "running" } : humanAction} busy={busy || activatingHuman} enabled={canOperate && !executionLocked}
                handoff={handoffMode}
                onEndTurn={() => void beginHuman({ kind: handoffMode ? "resolve_handoff" : "end_turn" })}
                onAnswer={answerChoice} onControl={controlExecution}
                manualMode={manualMode} manualEnabled={canOperate && !executorActive} onManualMode={value => void toggleManual(value)} />
            ) : (
              <div className="runtime-controls" hidden={returningLive || !view.players.some(player => player.kind === "ai")}>
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
            ))}
          </div>
        )}
        {result && view && !loadingReplay && !returningLive && !presenting && (
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
            <div className="table-column"
              onDragStartCapture={event => {
                if ((event.target as HTMLElement).closest('[draggable="true"]')) { setInspecting(null); setPreviewing(null); }
              }}
              onKeyDownCapture={event => {
                if (event.key === " " && (event.target as HTMLElement).closest('[draggable="true"]')) { setInspecting(null); setPreviewing(null); }
              }}>
              <MatchTable
                view={displayView ?? view}
                inert={focusedPokemon || Boolean(warning && !privacy)}
                viewer={view.viewer}
                selected={selected}
                highlighted={located}
                interactive={Boolean(humanSeat && replay === null && (canOperate || placementMode) && !directLocked && !busy)}
                {...(humanSeat && replay === null ? { onIntent: (intent: HumanActionIntent) => void beginHuman(intent) } : {})}
                humanActionBusy={busy || activatingHuman || executorActive || presenting}
                manualMode={manualMode}
                {...(placementMode ? { setupPlacement, onSetupPlacement: (placement: SetupPlacement) => {
                  setInspecting(null); setPreviewing(null); setSetupPlacement(placement);
                } } : {})}
                onManualMove={(source, target) => void manuallyMove(source, target)}
                onManualState={(target, field) => {
                  if (manualMode && !busy && !executorActive && !presenting) void execute({ kind: "set_state", target: { kind: "group", position: target }, field }).catch(error => setError(error.message));
                }}
                onSelect={(position) =>
                  setSelected(manualMode ? [position] : togglePosition(selected, position))
                }
                onInspect={(object) => {
                  setInspecting(object);
                  setPreviewing(null);
                }}
                onPreview={setPreviewing}
                onDestination={(key, index) => setDestination({ key, index })}
              />
              <TableMotion view={displayView ?? view} />
              {replay === null && <TableExecutionStatus action={humanAction} busy={busy} preparing={activatingHuman}
                aiThinking={view.runtime.status === "running" && !finished}
                queued={pendingSteps} onSkip={skipToLatest} />}
              {returningLive && <div className="table-waiting" role="status">正在读取最新牌桌</div>}
              {loadingReplay && <div className="table-waiting" role="status">正在读取历史牌桌</div>}
              {view.flow.choice && !canChoice && !finished && !presenting && (
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
              {canChoice && !placementMode && !handoffMode && (
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
              {activeDispute && !presenting && (
                <div className="flow-overlay dispute-overlay">
                  <DisputePanel
                    view={view}
                    execute={execute}
                    busy={busy}
                    canRespond={canRespond}
                  />
                </div>
              )}
              {debug && operationsOpen && (
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
                    enabled={canOperate && !directLocked}
                    canConcede={Boolean(
                      humanSeat && replay === null && !finished && !executionLocked,
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
              {focusedPokemon && inspected?.kind === "group" ? <PokemonFocus object={inspected} view={displayView ?? view}
                enabled={Boolean(canOperate && !busy && !executionLocked && !manualMode && !handoffMode)}
                onIntent={intent => void beginHuman(intent)} onInspectMember={member => { setInspecting(member); setPreviewing(null); }}
                close={() => { setInspecting(null); setPreviewing(null); }} /> : inspected && (
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
              view={replay === null ? view : { ...view, events: historyEvents }}
              canObject={replay === null && canOperate}
              debug={debug}
              onObject={setObjection}
              onRestore={(event) => setDebugAction({ kind: "restore", event })}
              onLocate={(positions) => setLocated(positions)}
              onReplay={playAction}
              {...(currentAction ? { activeActionId: currentAction.id } : {})}
            />
          </div>
        </>
      )}
      {concedeOpen && <ConfirmAction title="认输" description={<p>确认结束本局对战？</p>} confirmLabel="确认认输" close={() => setConcedeOpen(false)} onConfirm={async () => { await execute({ kind: "concede" }); setConcedeOpen(false); }} />}
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
      {warning && !privacy && <MatchWarning warning={warning} onConfirm={confirmWarning} />}
    </main>
  );
}
