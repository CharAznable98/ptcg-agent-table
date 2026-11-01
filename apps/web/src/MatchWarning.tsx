import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./match-warning.css";

export interface MatchWarningMessage { key: string; title: string; message: string }

/** 相同失败不会随轮询反复弹出；新的执行尝试可以再次报告同一原因。 */
export function useMatchWarnings() {
  const [queue, setQueue] = useState<MatchWarningMessage[]>([]);
  const seen = useRef(new Set<string>());
  const notify = useCallback((warning: MatchWarningMessage) => {
    if (seen.current.has(warning.key)) return;
    seen.current.add(warning.key);
    setQueue(current => current.some(item => item.message === warning.message) ? current : [...current, warning]);
  }, []);
  const confirm = useCallback(() => setQueue(current => current.slice(1)), []);
  const clear = useCallback(() => { seen.current.clear(); setQueue([]); }, []);
  return { warning: queue[0], notify, confirm, clear };
}

export function MatchWarning({ warning, onConfirm }: { warning: MatchWarningMessage; onConfirm: () => void }) {
  const titleId = useId(), messageId = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    confirm.current?.focus();
    return () => {
      const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected && !previous.matches(":disabled") && !previous.closest("[inert]")
        ? previous : document.querySelector<HTMLElement>(".human-action-dock button:not(:disabled), .playmat");
      target?.focus({ preventScroll: true });
    };
  }, [warning.key]);
  return <div className="match-warning-backdrop" onMouseDown={event => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    confirm.current?.focus();
  }} onKeyDownCapture={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    if (event.key === "Tab") { event.preventDefault(); event.stopPropagation(); confirm.current?.focus(); }
  }}>
    <section className="match-warning" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
      <div className="match-warning-symbol" aria-hidden="true">!</div>
      <h2 id={titleId}>{warning.title}</h2>
      <p id={messageId}>{warning.message}</p>
      <footer><button type="button" className="button primary" ref={confirm} onClick={onConfirm}>确认</button></footer>
    </section>
  </div>;
}
