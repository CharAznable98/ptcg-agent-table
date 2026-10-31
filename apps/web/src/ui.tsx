import { useEffect, useRef, useState, type ReactNode } from "react";
export function Button({
  children,
  onClick,
  disabled,
  kind = "",
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: string;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={type}
      className={`button ${kind}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  children,
  close,
  wide = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    ref.current
      ?.querySelector<HTMLElement>("button, input, textarea, select")
      ?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) close();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy}
        ref={ref}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
          if (event.key !== "Tab") return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
            ),
          ];
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <Button onClick={close} title="关闭" disabled={busy}>
            ✕
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}
/** 危险操作统一在页面内确认，避免原生 JS 对话框阻塞浏览器自动化与后台标签。 */
export function ConfirmAction({
  title,
  description,
  confirmLabel,
  reasonLabel,
  close,
  onConfirm,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  reasonLabel?: string;
  close: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  return (
    <Modal title={title} close={close} busy={busy}>
      <div className="confirmation-description">{description}</div>
      <ErrorNote value={error} />
      {reasonLabel && (
        <Field label={reasonLabel}>
          <textarea
            rows={3}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      )}
      <footer className="modal-footer">
        <Button disabled={busy} onClick={close}>
          取消
        </Button>
        <Button
          kind="danger"
          disabled={busy || Boolean(reasonLabel && !reason.trim())}
          onClick={() => {
            if (submitting.current) return;
            submitting.current = true;
            setBusy(true);
            setError("");
            void onConfirm(reason.trim())
              .then(close)
              .catch((error) => setError((error as Error).message))
              .finally(() => {
                submitting.current = false;
                setBusy(false);
              });
          }}
        >
          {busy ? "正在执行…" : confirmLabel}
        </Button>
      </footer>
    </Modal>
  );
}
export function JsonEditor({
  value,
  onChange,
  label = "JSON 内容",
  rows = 14,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  rows?: number;
}) {
  return (
    <Field label={label}>
      <textarea
        className="code"
        rows={rows}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
export function JsonDetails({
  value,
  label = "查看结构化记录",
}: {
  value: unknown;
  label?: string;
}) {
  return (
    <details className="json-details">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function FileImport({
  onImport,
  label = "导入 JSON",
}: {
  onImport: (file: File) => Promise<void>;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file)
            void onImport(file).catch((error) =>
              setError(String(error.message ?? error)),
            );
          event.target.value = "";
        }}
      />
      <Button onClick={() => ref.current?.click()}>{label}</Button>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </>
  );
}
export function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}
export function ErrorNote({ value }: { value: string }) {
  return value ? (
    <div role="alert" className="error-note">
      {value}
    </div>
  ) : null;
}
export function Busy({ text = "加载中…" }: { text?: string }) {
  return (
    <div className="busy">
      <span />
      {text}
    </div>
  );
}
