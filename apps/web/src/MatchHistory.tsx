import { useMemo, useRef, useState } from "react";
import type { MatchView, Position, PublicEvent } from "../../../packages/protocol/src/index.ts";
import { buildActionHistory, type ActionStep } from "./action-history.ts";
import { presentEvent } from "./event-presentation.ts";
import { Button } from "./ui.tsx";
import "./action-history.css";

export interface MatchHistoryProps {
  view: MatchView;
  canObject: boolean;
  debug: boolean;
  onObject: (event: PublicEvent) => void;
  onRestore: (event: PublicEvent) => void;
  onLocate: (positions: Position[]) => void;
  onReplay?: (step: ActionStep) => void;
  activeActionId?: string;
}

function OriginalRecord({ event }: { event: PublicEvent }) {
  const [open, setOpen] = useState(false);
  return <details className="json-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>原始记录</summary>
    {open && <pre>{JSON.stringify(event.data, null, 2)}</pre>}
  </details>;
}

function ActionDetails({ step, view, canObject, debug, onObject, onRestore }: Pick<MatchHistoryProps, "view" | "canObject" | "debug" | "onObject" | "onRestore"> & { step: ActionStep }) {
  const [open, setOpen] = useState(false);
  return <details className="history-action-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>细节</span><span>{step.events.length} 步</span></summary>
    {open && <div className="history-atomic-list">
      {step.events.map((event, index) => {
        const presentation = presentEvent(event, view.events[step.startIndex + index - 1]);
        return <div className={`history-atomic-entry ${event.revokedBy ? "revoked" : ""}`} key={event.id} data-atomic-event-id={event.id}>
          <div className="history-meta">
            <span>{presentation.actor}</span><span>#{event.sequence}</span>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
          </div>
          <p className="history-atomic-title">{presentation.title}</p>
          {presentation.detail && <p className="history-atomic-detail">{presentation.detail}</p>}
          <div className="history-entry-actions">
            <OriginalRecord event={event} />
            <Button kind="text" disabled={!canObject} onClick={() => onObject(event)}>提出异议</Button>
            {debug && <Button kind="text danger" disabled={Boolean(event.revokedBy)} onClick={() => onRestore(event)}>恢复至此之前</Button>}
          </div>
        </div>;
      })}
    </div>}
  </details>;
}

export function MatchHistory({ view, canObject, debug, onObject, onRestore, onLocate, onReplay, activeActionId }: MatchHistoryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 键包含对局身份；切换对局不会继承另一局相同回合号的手动折叠状态。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const steps = useMemo(() => buildActionHistory(view.events), [view.events]);
  const rounds = useMemo(() => {
    const grouped = new Map<string, { key: string; label: string; steps: ActionStep[] }>();
    for (const step of [...steps].reverse()) {
      const round = grouped.get(step.turnKey);
      if (round) round.steps.push(step);
      else grouped.set(step.turnKey, { key: step.turnKey, label: step.turnLabel, steps: [step] });
    }
    return [...grouped.values()];
  }, [steps]);
  const defaultOpen = new Set(rounds.filter(round => !round.key.startsWith("setup")).slice(0, 2).map(round => round.key));
  if (!defaultOpen.size && rounds[0]) defaultOpen.add(rounds[0].key);
  const jumpToLatest = () => { if (scrollRef.current) scrollRef.current.scrollTop = 0; };
  return <aside className="match-history action-history" aria-label="对局记录">
    <header className="history-header">
      <div><h2>对局记录</h2><span>{steps.length} 次行动</span></div>
      <span className="history-mode">{view.replay ? "历史回放" : "实时"}</span>
    </header>
    <div className="history-scroll" ref={scrollRef} role="log" aria-label="对局记录列表" aria-live="off" tabIndex={0}>
      {!steps.length && <p className="history-empty">暂无记录</p>}
      {rounds.map(round => {
        const stateKey = `${view.id}/${round.key}`, open = expanded[stateKey] ?? defaultOpen.has(round.key);
        const sectionId = `history-round-${encodeURIComponent(stateKey)}`;
        return <section className={`history-round ${open ? "is-expanded" : ""}`} key={stateKey} data-turn-key={round.key}>
          <h3 className="history-round-heading"><button className="history-round-toggle" aria-expanded={open} aria-controls={sectionId}
            onClick={() => setExpanded(previous => ({ ...previous, [stateKey]: !open }))}>
            <span className="history-round-chevron" aria-hidden="true" />
            <span className="history-round-label">{round.label}</span><span className="history-round-count">{round.steps.length} 次</span>
          </button></h3>
          <div id={sectionId} className="history-round-content" hidden={!open}>
            {open && round.steps.map(step => <article className={`history-entry history-action ${step.revoked ? "revoked" : ""} ${step.id === activeActionId ? "is-active" : ""}`}
              key={step.id} data-event-id={step.events[0]!.id} data-action-id={step.id}>
              <div className="history-action-row">
                <span className={`history-actor actor-${step.events[0]!.actor}`}>{step.actor}</span>
                {step.positions.length || onReplay ? <button className="history-event-summary" title="定位相关区域"
                  onClick={() => { onLocate(step.positions); onReplay?.(step); }}>{step.title}</button>
                  : <p className="history-event-summary">{step.title}</p>}
                {onReplay && <button className="history-play" aria-label={`回放：${step.title}`} title="回放这次行动" onClick={() => onReplay(step)}><span aria-hidden="true">▶</span></button>}
              </div>
              {step.detail && <p className="history-event-detail">{step.detail}</p>}
              {step.revoked && <p className="history-revoked">已撤销，信息记录保留</p>}
              <ActionDetails step={step} view={view} canObject={canObject} debug={debug} onObject={onObject} onRestore={onRestore} />
            </article>)}
          </div>
        </section>;
      })}
    </div>
    <Button kind="history-to-latest" title="回到最新" disabled={!steps.length} onClick={jumpToLatest}>
      <span aria-hidden="true">↑</span>
    </Button>
  </aside>;
}
