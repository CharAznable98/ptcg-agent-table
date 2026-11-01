import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HumanActionChoice, HumanActionView, MatchView, PlayerId, Position } from "../../../packages/protocol/src/index.ts";
import type { SetupPlacement } from "./direct-manipulation.tsx";
import { positionKey, zoneNames } from "./table-utils.ts";
import { CardFace } from "./Cards.tsx";
import { Button } from "./ui.tsx";
import "./human-actions.css";
import "./execution-status.css";

export interface HumanChoiceSubmission { choiceId: string; selected: string[]; number?: number }
export type { SetupPlacement } from "./direct-manipulation.tsx";

const recoveryPhaseNames = { reviewing: "核对结算", continuing: "继续结算", rolling_back: "正在回滚" };
function recoveryLabel(action: HumanActionView | null | undefined) {
  return action?.status === "running" && action.recovery ? recoveryPhaseNames[action.recovery.phase] : undefined;
}

/** 状态停留在牌桌中央，记录与卡牌仍可阅读；不猜测模型完成百分比。 */
export function TableExecutionStatus({ action, busy = false, preparing = false, aiThinking = false, queued = 0, onSkip }: {
  action?: HumanActionView | null; busy?: boolean; preparing?: boolean; aiThinking?: boolean;
  queued?: number; onSkip?: () => void;
}) {
  const running = action?.status === "running";
  const waiting = action?.status === "awaiting_choice";
  const unresolved = Boolean(action?.requiresResolution && !running && !waiting);
  if (!busy && !preparing && !running && !queued && !unresolved && (!aiThinking || waiting)) return null;
  const recovery = recoveryLabel(action);
  const needsAttention = unresolved && !queued && !busy && !preparing;
  const title = recovery ?? (queued ? "正在展示操作" : running ? action.label : preparing ? "正在准备回合" : busy ? "正在提交行动" : needsAttention ? "结算未完成" : "AI 正在处理");
  const detail = queued ? `剩余 ${queued} 步` : needsAttention ? "先让代理修正，再继续行动" : recovery ? action!.label : running && action.eventIds.length ? `已执行 ${action.eventIds.length} 步` : "等待处理结果";
  return <aside className={`table-execution-status ${needsAttention ? "needs-resolution" : queued ? "is-presenting" : "is-processing"}`} aria-label="牌桌处理状态">
    {needsAttention ? <span className="execution-warning" aria-hidden="true">!</span> : <div className="execution-signal" aria-hidden="true"><i /><i /><i /></div>}
    <div className="execution-copy" role="status" aria-live="polite">
      <strong title={title}>{title}</strong><span title={detail}>{detail}</span>
    </div>
    {queued > 0 && onSkip && <Button onClick={onSkip} title="跳过动画，显示最新牌桌">跳过动画</Button>}
    {!needsAttention && <div className="execution-activity" aria-hidden="true"><i /></div>}
  </aside>;
}

function canRestoreFocus(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected || element === document.body || element === document.documentElement
    || element.matches(":disabled") || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(":scope > summary")?.contains(element)) return false;
  }
  return element.tabIndex >= 0 || element.hasAttribute("tabindex");
}

export function SetupPlacementBar({ view, placement, busy, onConfirm, onClear }: {
  view: MatchView; placement: SetupPlacement; busy: boolean;
  onConfirm: () => void | Promise<void>; onClear: () => void;
}) {
  const [sending, setSending] = useState(false);
  const additional = view.flow.choice?.kind === "additional_bench";
  const eligible = new Set(view.flow.choice?.eligible?.map(positionKey) ?? []);
  const selected = [...(!additional && placement.active ? [placement.active] : []), ...placement.bench];
  const keys = selected.map(positionKey);
  const bench = view.zones.find((zone) => zone.playerId === view.viewer && zone.kind === "bench");
  const free = bench?.items.flatMap((item, index) => item ? [] : [index]) ?? [];
  const slots = placement.benchSlots ?? free.slice(0, placement.bench.length);
  const valid = (additional || Boolean(placement.active)) && keys.every((key) => eligible.has(key)) && new Set(keys).size === keys.length
    && slots.length === placement.bench.length && new Set(slots).size === slots.length && slots.every((index) => free.includes(index))
    && placement.bench.length <= (view.flow.choice?.maximum ?? free.length);
  const locked = busy || sending;
  return <div className="human-setup-bar" aria-label={additional ? "追加备战摆放" : "初始宝可梦摆放"}>
    <span className="setup-bar-status">{additional ? "追加备战" : "拖动基础宝可梦摆放"}</span>
    <span className="setup-placement-count">{!additional && `战斗 ${placement.active ? 1 : 0} · `}备战 {placement.bench.length}</span>
    <Button onClick={onClear} disabled={locked || !selected.length}>重置</Button>
    <Button kind="primary" disabled={locked || !valid} onClick={() => {
      if (!valid || locked) return;
      setSending(true);
      Promise.resolve(onConfirm()).finally(() => setSending(false)).catch(() => {});
    }}>{sending ? "提交中" : "准备完成"}</Button>
  </div>;
}

function choiceLocation(position: Position | undefined, playerId: PlayerId) {
  if (!position) return "";
  const [owner, zone] = position.zoneId.includes(":") ? position.zoneId.split(":") : ["", position.zoneId];
  const side = owner === "A" || owner === "B" ? owner === playerId ? "自己" : "对方" : "";
  const slot = zone === "active" || zone === "stadium" ? "" : ` · 第 ${position.index + 1} 位`;
  const member = position.member ? ` · ${position.member.relation === "stack" ? "叠牌" : "附着"} ${position.member.index + 1}` : "";
  return `${side}${zoneNames[zone!] ?? zone}${slot}${member}`;
}

function ChoiceSheet({ choice, playerId, busy, onAnswer, onCancel, restoreFocus }: {
  choice: HumanActionChoice; playerId: PlayerId; busy: boolean;
  onAnswer: (answer: HumanChoiceSubmission) => Promise<void>;
  onCancel: () => void;
  restoreFocus: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const locked = busy || sending;
  const number = amount === "" ? NaN : Number(amount);
  const valid = choice.kind === "number"
    ? Number.isInteger(number) && number >= choice.minimum && number <= choice.maximum
    : selected.length >= choice.minimum && selected.length <= choice.maximum;
  useEffect(() => {
    setPortalTarget(document.querySelector<HTMLElement>(".table-column"));
  }, []);
  useEffect(() => {
    if (!portalTarget || !ref.current) return;
    const previous = document.activeElement;
    const panel = ref.current;
    (ref.current.querySelector<HTMLElement>(".human-choice-option") ?? ref.current.querySelector<HTMLElement>("input") ?? ref.current.querySelector<HTMLElement>("button"))?.focus();
    return () => {
      const current = document.activeElement;
      // 非模态选择期间，用户可能已转去查看记录，或新选择已经接管焦点。
      if (canRestoreFocus(current) && !panel.contains(current)) return;
      if (canRestoreFocus(previous) && previous.tabIndex >= 0) previous.focus({ preventScroll: true });
      else restoreFocus();
    };
  }, [portalTarget, restoreFocus]);
  function toggle(id: string) {
    if (locked) return;
    setSelected((current) => current.includes(id) ? current.filter((value) => value !== id)
      : choice.maximum === 1 ? [id] : current.length < choice.maximum ? [...current, id] : current);
  }
  async function submit() {
    if (!valid || locked) return;
    setSending(true); setError("");
    try { await onAnswer({ choiceId: choice.id, selected, ...(choice.kind === "number" ? { number } : {}) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "提交失败"); }
    finally { setSending(false); }
  }
  const panel = <section className="human-choice-sheet" role="dialog" aria-label={choice.title} aria-modal="false" aria-busy={locked} ref={ref}
    onKeyDown={(event) => { if (event.key === "Escape" && !locked) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <header>
      <div><h2>{choice.title}</h2><span>{choice.kind === "number" ? `${choice.minimum}-${choice.maximum}` : `${selected.length} / ${choice.minimum === choice.maximum ? choice.maximum : `${choice.minimum}-${choice.maximum}`}${choice.kind === "order" ? " · 按点击顺序排列" : ""}`}</span></div>
      <Button title="取消本次行动" disabled={locked} onClick={onCancel}>取消行动</Button>
    </header>
    {choice.kind === "number" ? <div className="human-number-choice">
      <label><span>数量</span><input autoComplete="off" aria-label="选择数量" type="number" inputMode="numeric"
        min={choice.minimum} max={choice.maximum} step={1} value={amount} disabled={locked}
        onChange={(event) => setAmount(event.target.value)} /></label>
    </div> : <div className={`human-choice-options ${choice.options.some((option) => option.card) ? "has-cards" : ""}`}>
      {choice.options.map((option) => {
        const index = selected.indexOf(option.id), chosen = index >= 0;
        const location = choiceLocation(option.position, playerId);
        const marker = chosen && <span className="choice-order">{choice.kind === "order" ? index + 1 : "已选"}</span>;
        return <button type="button" className={`human-choice-option ${chosen ? "is-chosen" : ""} ${option.card ? "has-card" : ""}`}
          aria-label={location ? `${option.label}，${location}` : option.label} aria-pressed={chosen} key={option.id}
          disabled={locked || !chosen && choice.maximum > 1 && selected.length >= choice.maximum}
          onClick={() => toggle(option.id)}>
          {location && <span className="choice-option-location">{location.split(" · ").map((part, partIndex) => <span key={partIndex}>{partIndex > 0 && " · "}{part}</span>)}</span>}
          {option.card && <span className="choice-option-card"><CardFace card={option.card} compact />{marker}</span>}
          <span className="choice-option-label" title={option.label}>{option.label}</span>
          {!option.card && marker}
        </button>;
      })}
    </div>}
    {choice.kind === "order" && selected.length > 0 && <ol className="human-choice-order" aria-label="已选顺序">
      {selected.map((id, index) => {
        const option = choice.options.find((option) => option.id === id)!;
        const location = choiceLocation(option.position, playerId);
        return <li key={id}><span>{index + 1}. {option.label}{location && ` · ${location}`}</span>
        <button type="button" aria-label={`将第${index + 1}项前移`} disabled={locked || index === 0} onClick={() => setSelected((items) => {
          const next = [...items]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next;
        })}>上移</button>
        <button type="button" aria-label={`将第${index + 1}项后移`} disabled={locked || index === selected.length - 1} onClick={() => setSelected((items) => {
          const next = [...items]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; return next;
        })}>下移</button>
      </li>; })}
    </ol>}
    <footer>{error && <span role="alert">{error}</span>}<Button kind="primary" disabled={!valid || locked} onClick={() => void submit()}>{sending ? "提交中" : "确认选择"}</Button></footer>
  </section>;
  return portalTarget ? createPortal(panel, portalTarget) : null;
}

export function HumanActionDock({ action, busy, enabled, onEndTurn, onAnswer, onControl, manualMode, onManualMode, manualEnabled = enabled, handoff = false }: {
  action: HumanActionView | null | undefined;
  busy: boolean; enabled: boolean;
  onEndTurn: () => void;
  onAnswer: (answer: HumanChoiceSubmission) => Promise<void>;
  onControl: (action: "retry" | "cancel" | "repair") => Promise<void>;
  manualMode: boolean; onManualMode: (value: boolean) => void;
  manualEnabled?: boolean;
  handoff?: boolean;
}) {
  const dock = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [controlling, setControlling] = useState(false);
  const running = action?.status === "running";
  const awaiting = action?.status === "awaiting_choice";
  const failed = action?.status === "failed";
  const cancelled = action?.status === "cancelled";
  const unresolved = Boolean(action?.requiresResolution);
  const pausedTurnStart = cancelled && !unresolved && action.intent.kind === "turn_start";
  const locked = busy || controlling;
  const restoreFocus = useCallback(() => {
    const root = dock.current;
    if (!root) return;
    const candidates = [root.querySelector<HTMLElement>(".human-action-more > summary"), ...root.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    const target = candidates.find(canRestoreFocus) ?? root;
    target.focus({ preventScroll: true });
  }, []);
  useEffect(() => { setError(""); }, [action?.id, action?.status]);
  async function control(value: "retry" | "cancel" | "repair") {
    if (locked) return;
    setError(""); setControlling(true);
    try { await onControl(value); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setControlling(false); }
  }
  return <div className={`human-action-dock ${running ? "is-running" : ""}`} aria-label="人类行动" ref={dock} tabIndex={-1}>
    <span className="human-action-status" role="status" title={error || (!cancelled && action?.error) || action?.label}>
      {manualMode ? "手动调整" : error ? "操作失败" : (running ? recoveryLabel(action) ?? "执行中" : awaiting ? "等待选择" : unresolved ? "结算未完成" : failed ? "执行中断" : cancelled ? `已停止${action.eventIds.length ? ` · 保留 ${action.eventIds.length} 步` : ""}` : handoff ? "等待处理" : action?.status === "completed" ? "行动完成" : "拖动卡牌操牌")}
    </span>
    {running && <Button disabled={locked} onClick={() => void control("cancel")}>停止</Button>}
    {!running && !awaiting && (failed || unresolved) && <Button kind="primary" disabled={locked} onClick={() => { if (manualMode) onManualMode(false); void control("retry"); }}>代理修正</Button>}
    {manualMode ? <Button onClick={() => onManualMode(false)} disabled={locked}>结束调整</Button>
      : pausedTurnStart ? <Button kind="primary" onClick={() => void control("retry")} disabled={locked}>继续开局</Button>
        : !running && !awaiting && <Button kind={unresolved ? undefined : "primary"} onClick={onEndTurn} disabled={locked || !enabled || unresolved}>{handoff ? "继续处理" : "结束回合"}</Button>}
    {!running && !awaiting && <details className="human-action-more"><summary aria-label="行动更多操作" tabIndex={0}>更多</summary><div>
      {action?.status === "cancelled" && !pausedTurnStart && !unresolved && <Button disabled={locked} onClick={() => { onManualMode(false); void control("retry"); }}>继续原行动</Button>}
      {action && !unresolved && (failed || action.status === "completed") && <Button disabled={locked} onClick={() => { onManualMode(false); void control("repair"); }}>代理复核</Button>}
      <Button disabled={locked || !manualEnabled} onClick={() => onManualMode(!manualMode)}>{manualMode ? "结束手动调整" : "手动调整"}</Button>
    </div></details>}
    {awaiting && action.choice && <ChoiceSheet key={action.choice.id} choice={action.choice} playerId={action.playerId} busy={locked} onAnswer={onAnswer} onCancel={() => void control("cancel")} restoreFocus={restoreFocus} />}
  </div>;
}
