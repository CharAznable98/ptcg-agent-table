import { useEffect, useRef, useState } from "react";
import type {
  CreateEvaluationInput,
  EvaluationRecord,
  EvaluationRun,
  OpponentRecord,
  PlayerId,
} from "../../../packages/protocol/src/index.ts";
import { api, jsonBody } from "./api.ts";
import { phaseNames, statusNames } from "./table-utils.ts";
import { Button, Empty, ErrorNote, Field, Modal } from "./ui.tsx";

/** 选择、读取与刷新只查询；两个运行按钮分别发起一次真实对局。 */
export function Evaluations({
  opponents: initialOpponents,
  close,
  openMatch,
}: {
  opponents: OpponentRecord[];
  close: () => void;
  openMatch: (id: string) => void;
}) {
  const [opponents, setOpponents] = useState(initialOpponents);
  const [records, setRecords] = useState<EvaluationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [choices, setChoices] = useState([
    initialOpponents[0]?.id ?? "",
    initialOpponents[1]?.id ?? "",
  ]);
  const [versions, setVersions] = useState([
    initialOpponents[0]?.strategies.at(-1)?.version ?? 0,
    initialOpponents[1]?.strategies.at(-1)?.version ?? 0,
  ]);
  const [evaluatedPlayer, setEvaluatedPlayer] = useState<PlayerId>("A");
  const [comparisonVersion, setComparisonVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const detail = records.find((record) => record.id === selected);
  const evaluatedIndex = detail?.evaluatedPlayer === "B" ? 1 : 0;
  const evaluatedOpponent = detail
    ? opponents.find((record) => record.id === detail.players[evaluatedIndex].opponentId)
    : undefined;
  const comparedVersions = detail
    ? new Set([detail.baseline.version, ...detail.comparisons.map((run) => run.version)])
    : new Set<number>();
  const availableVersions = evaluatedOpponent?.strategies.filter(
    (version) => !comparedVersions.has(version.version),
  ) ?? [];
  const readyToCompare = detail?.baseline.match?.phase === "finished" &&
    detail.baseline.match.result !== null;

  useEffect(() => {
    let cancelled = false;
    void api<{ evaluations: EvaluationRecord[] }>("/evaluations")
      .then((result) => { if (!cancelled) setRecords(result.evaluations); })
      .catch((error) => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const refresh = () => {
    setError("");
    setLoading(true);
    void Promise.all([
      api<{ evaluations: EvaluationRecord[] }>("/evaluations"),
      api<{ opponents: OpponentRecord[] }>("/opponents"),
    ])
      .then(([result, library]) => {
        setRecords(result.evaluations);
        setOpponents(library.opponents);
      })
      .catch((error) => setError(error.message))
      .finally(() => setLoading(false));
  };
  const run = (path: string, input: unknown) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    void api<EvaluationRecord>(path, { method: "POST", body: jsonBody(input) })
      .then((result) => {
        setRecords((current) => [result, ...current.filter((record) => record.id !== result.id)]);
        setSelected(result.id);
        setComparisonVersion(0);
      })
      .catch((error) => setError(error.message))
      .finally(() => {
        submitting.current = false;
        setBusy(false);
      });
  };
  const opponentName = (id: string) => opponents.find((record) => record.id === id)?.name ?? "AI 对手";

  return (
    <Modal title="策略评估" close={close} wide busy={busy}>
      <ErrorNote value={error} />
      <div className="section-toolbar">
        <span className="muted">手动运行，对照复用版本 A 的起点与随机配置。</span>
        <Button onClick={refresh} disabled={busy || loading}>刷新记录</Button>
      </div>
      {detail ? (
        <section className="evaluation-detail">
          <div className="section-toolbar">
            <h3>被评估席位：{detail.evaluatedPlayer}</h3>
            <Button disabled={busy} onClick={() => setSelected(null)}>返回评估列表</Button>
          </div>
          <p>
            固定对手：{opponentName(detail.players[1 - evaluatedIndex]!.opponentId)}
            {" · v"}{detail.players[1 - evaluatedIndex]!.version}
          </p>
          <RunResult label="版本 A" run={detail.baseline} openMatch={openMatch} />
          {detail.comparisons.map((item) => (
            <RunResult key={item.matchId} label="版本 B" run={item} openMatch={openMatch} />
          ))}
          <Field label="版本 B · 策略版本">
            <select value={comparisonVersion} disabled={busy} onChange={(event) => setComparisonVersion(Number(event.target.value))}>
              <option value={0}>请选择</option>
              {availableVersions.map((version) => (
                <option key={version.version} value={version.version}>v{version.version}</option>
              ))}
            </select>
          </Field>
          {!readyToCompare && <p className="muted">等待版本 A 完成后再运行对照。</p>}
          {readyToCompare && !availableVersions.length && <p className="muted">暂无其它策略版本，可在更新策略后刷新记录。</p>}
          <Button
            kind="primary"
            disabled={busy || !readyToCompare || !availableVersions.some((version) => version.version === comparisonVersion)}
            onClick={() => run(`/evaluations/${detail.id}/comparisons`, { version: comparisonVersion })}
          >运行版本 B</Button>
          <p className="muted">单组结果仅反映此起点；判断总体提升需要多个场景。</p>
        </section>
      ) : (
        <>
          <div className="versus-form">
            {(["A", "B"] as const).map((seat, index) => {
              const opponent = opponents.find((record) => record.id === choices[index]);
              return (
                <section key={seat}>
                  <h3>席位 {seat}</h3>
                  <Field label={`席位 ${seat} · AI 对手`}>
                    <select value={choices[index]} disabled={busy} onChange={(event) => {
                      const id = event.target.value;
                      setChoices((values) => values.map((value, i) => i === index ? id : value));
                      const latest = opponents.find((record) => record.id === id)?.strategies.at(-1)?.version ?? 0;
                      setVersions((values) => values.map((value, i) => i === index ? latest : value));
                    }}>
                      <option value="">请选择</option>
                      {opponents.map((record) => <option key={record.id} value={record.id}>{record.name ?? "未命名 AI"}</option>)}
                    </select>
                  </Field>
                  <Field label={`席位 ${seat} · 策略版本`}>
                    <select value={versions[index]} disabled={busy} onChange={(event) => setVersions((values) => values.map((value, i) => i === index ? Number(event.target.value) : value))}>
                      <option value={0}>请选择</option>
                      {opponent?.strategies.map((version) => <option key={version.version} value={version.version}>v{version.version}</option>)}
                    </select>
                  </Field>
                </section>
              );
            })}
          </div>
          <Field label="被评估席位">
            <select value={evaluatedPlayer} disabled={busy} onChange={(event) => setEvaluatedPlayer(event.target.value as PlayerId)}>
              <option value="A">A</option><option value="B">B</option>
            </select>
          </Field>
          <Button kind="primary" disabled={busy} onClick={() => {
            if (choices.some((id, index) => !opponents.some((opponent) => opponent.id === id && opponent.strategies.some((version) => version.version === versions[index])))) {
              setError("请选择双方 AI 与策略版本");
              return;
            }
            if (choices[0] === choices[1]) {
              setError("请选择两名独立 AI 对手");
              return;
            }
            const input: CreateEvaluationInput = {
              players: [
                { opponentId: choices[0]!, version: versions[0]! },
                { opponentId: choices[1]!, version: versions[1]! },
              ], evaluatedPlayer,
            };
            run("/evaluations", input);
          }}>{busy ? "创建中…" : "运行版本 A"}</Button>
          <div className="evaluation-records">
            <h3>评估记录</h3>
            {!records.length ? <Empty title={loading ? "加载中…" : "暂无评估"} /> : records.map((record) => (
              <button className="match-row" key={record.id} disabled={busy} onClick={() => {
                setSelected(record.id);
                setComparisonVersion(0);
                setError("");
              }}>
                <span>
                  <b>{record.baseline.match?.players.map((player) => player.name).join(" vs ") ?? record.players.map((player) => opponentName(player.opponentId)).join(" vs ")}</b>
                  <small>{new Date(record.createdAt).toLocaleString("zh-CN")} · 被评估席位 {record.evaluatedPlayer}</small>
                </span>
                <span>{record.comparisons.length} 次对照</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function RunResult({ label, run, openMatch }: { label: string; run: EvaluationRun; openMatch: (id: string) => void }) {
  const match = run.match;
  const result = match?.result;
  const outcome = result?.kind === "win"
    ? `席位 ${result.winner} 获胜`
    : result?.kind === "draw" ? "平局" : result?.kind === "abnormal" ? "异常结束"
      : match ? `${phaseNames[match.phase]} · ${statusNames[match.runtime.status]}` : "已创建";
  return (
    <div className="evaluation-run">
      <b>{label} · v{run.version}</b>
      <span>{outcome}</span>
      <Button onClick={() => openMatch(run.matchId)}>查看对局</Button>
    </div>
  );
}
