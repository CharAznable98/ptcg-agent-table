import { useMemo, useRef, useState } from "react";
import type {
  MatchView,
  Position,
  PublicEvent,
} from "../../../packages/protocol/src/index.ts";
import { presentEvent } from "./event-presentation.ts";
import { Button } from "./ui.tsx";

export interface MatchHistoryProps {
  view: MatchView;
  canObject: boolean;
  debug: boolean;
  onObject: (event: PublicEvent) => void;
  onRestore: (event: PublicEvent) => void;
  onLocate: (positions: Position[]) => void;
}

function OriginalRecord({ event }: { event: PublicEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="json-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>原始记录</summary>
      {open && <pre>{JSON.stringify(event.data, null, 2)}</pre>}
    </details>
  );
}

export function MatchHistory({
  view,
  canObject,
  debug,
  onObject,
  onRestore,
  onLocate,
}: MatchHistoryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () =>
      view.events
        .map((event, index) => ({
          event,
          presentation: presentEvent(event, view.events[index - 1]),
        }))
        .reverse(),
    [view.events],
  );
  const jumpToLatest = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  return (
    <aside className="match-history" aria-label="对局记录">
      <header className="history-header">
        <div>
          <h2>对局记录</h2>
          <span>{view.events.length} 条</span>
        </div>
        <span className="history-mode">
          {view.replay ? "历史回放" : "实时"}
        </span>
      </header>
      <div
        className="history-scroll"
        ref={scrollRef}
        role="log"
        aria-label="对局记录列表"
        aria-live="off"
        tabIndex={0}
      >
        {!items.length && <p className="history-empty">暂无记录</p>}
        {items.map(({ event, presentation }, index) => (
          <div className="history-entry-group" key={event.id}>
            {(index === 0 ||
              presentation.turnLabel !==
                items[index - 1]!.presentation.turnLabel) && (
              <h3 className="history-turn">{presentation.turnLabel}</h3>
            )}
            <article
              className={`history-entry ${event.revokedBy ? "revoked" : ""}`}
              data-event-id={event.id}
            >
              <div className="history-meta">
                <span className={`history-actor actor-${event.actor}`}>
                  {presentation.actor}
                </span>
                <span>#{event.sequence}</span>
                <time dateTime={event.at}>
                  {new Date(event.at).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
              </div>
              {presentation.positions.length ? (
                <button
                  className="history-event-summary"
                  title="定位相关区域"
                  onClick={() => onLocate(presentation.positions)}
                >
                  {presentation.title}
                </button>
              ) : (
                <p className="history-event-summary">{presentation.title}</p>
              )}
              {presentation.detail && (
                <p className="history-event-detail">{presentation.detail}</p>
              )}
              {event.revokedBy && (
                <p className="history-revoked">已撤销，信息记录保留</p>
              )}
              <div className="history-entry-actions">
                <OriginalRecord event={event} />
                <Button
                  kind="text"
                  disabled={!canObject}
                  onClick={() => onObject(event)}
                >
                  提出异议
                </Button>
                {debug && (
                  <Button
                    kind="text danger"
                    disabled={Boolean(event.revokedBy)}
                    onClick={() => onRestore(event)}
                  >
                    恢复至此之前
                  </Button>
                )}
              </div>
            </article>
          </div>
        ))}
      </div>
      <Button
        kind="history-to-latest"
        title="回到最新"
        disabled={!items.length}
        onClick={jumpToLatest}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 19V5m-6 6 6-6 6 6" />
        </svg>
      </Button>
    </aside>
  );
}
