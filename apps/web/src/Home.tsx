import { useEffect, useState } from "react";
import type {
  CreateMatchInput,
  CreateMatchResponse,
  DeckRecord,
  MatchMode,
  MatchSummary,
  OpponentRecord,
} from "../../../packages/protocol/src/index.ts";
import { api, jsonBody } from "./api.ts";
import { phaseNames, statusNames } from "./table-utils.ts";
import { Button, Empty, ErrorNote, Field, Modal } from "./ui.tsx";
import { Evaluations } from "./Evaluations.tsx";
export function Home({ openMatch }: { openMatch: (id: string) => void }) {
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [decks, setDecks] = useState<DeckRecord[]>([]);
  const [opponents, setOpponents] = useState<OpponentRecord[]>([]);
  const [create, setCreate] = useState(false);
  const [evaluations, setEvaluations] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([
      api<{ matches: MatchSummary[] }>("/matches"),
      api<{ decks: DeckRecord[] }>("/decks"),
      api<{ opponents: OpponentRecord[] }>("/opponents"),
    ])
      .then(([m, d, o]) => {
        setMatches(m.matches);
        setDecks(d.decks);
        setOpponents(o.opponents);
      })
      .catch((error) => setError(error.message));
  }, []);
  return (
    <main className="page home-page">
      <section className="page-heading">
        <h1>对局</h1>
        <div className="section-toolbar">
          <Button onClick={() => setEvaluations(true)}>策略评估</Button>
          <Button kind="primary" onClick={() => setCreate(true)}>
            新建对局
          </Button>
        </div>
      </section>
      <ErrorNote value={error} />
      <section className="match-list-section">
        <div className="section-toolbar">
          <h2>对局记录</h2>
          <span className="muted">{matches.length} 场对局</span>
        </div>
        {!matches.length ? (
          <Empty title="暂无对局" />
        ) : (
          <div className="match-list">
            {matches.map((match) => (
              <button
                className="match-row"
                key={match.id}
                onClick={() => openMatch(match.id)}
              >
                <span
                  className={`match-dot ${match.phase === "finished" ? "finished" : ""}`}
                />
                <span>
                  <b>
                    {match.players.map((player) => player.name).join("　vs　")}
                  </b>
                  <small>
                    {new Date(match.createdAt).toLocaleString("zh-CN")} ·{" "}
                    {match.mode === "ai_ai"
                      ? "AI 观战"
                      : match.mode === "human_ai"
                        ? "人机对战"
                        : "本地双人"}
                  </small>
                </span>
                <span className="match-status">
                  {phaseNames[match.phase]}
                  <small>
                    {statusNames[match.runtime.status]}
                  </small>
                </span>
                <span>↗</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {evaluations && (
        <Evaluations opponents={opponents} close={() => setEvaluations(false)} openMatch={openMatch} />
      )}
      {create && (
        <NewMatch
          decks={decks}
          opponents={opponents}
          close={() => setCreate(false)}
          created={(result) => {
            openMatch(result.match.id);
          }}
        />
      )}
    </main>
  );
}
function NewMatch({
  decks,
  opponents,
  close,
  created,
}: {
  decks: DeckRecord[];
  opponents: OpponentRecord[];
  close: () => void;
  created: (value: CreateMatchResponse) => void;
}) {
  const [mode, setMode] = useState<MatchMode>("local");
  const [names, setNames] = useState(["玩家 A", "玩家 B"]);
  const [choices, setChoices] = useState([
    decks[0]?.id ?? "",
    decks[0]?.id ?? "",
  ]);
  const [aiChoices, setAiChoices] = useState([
    opponents[0]?.id ?? "",
    opponents[0]?.id ?? "",
  ]);
  const [autoRun, setAutoRun] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="新建对局" close={close} wide>
      <div className="mode-choice">
        {(
          [
            ["local", "本地双人"],
            ["human_ai", "人机对战"],
            ["ai_ai", "AI 对战"],
          ] as const
        ).map(([value, title]) => (
          <button
            key={value}
            className={mode === value ? "selected" : ""}
            onClick={() => setMode(value)}
          >
            <b>{title}</b>
          </button>
        ))}
      </div>
      <ErrorNote value={error} />
      <div className="versus-form">
        {(["A", "B"] as const).map((seat, index) => {
          const ai = mode === "ai_ai" || (mode === "human_ai" && index === 1);
          return (
            <section key={seat}>
              <span className="eyebrow">玩家 {seat}</span>
              <h3>{ai ? "AI 对手" : `玩家 ${seat}`}</h3>
              {!ai && (
                <Field label="玩家名称">
                  <input
                    value={names[index]}
                    onChange={(event) =>
                      setNames(
                        names.map((name, i) =>
                          i === index ? event.target.value : name,
                        ),
                      )
                    }
                  />
                </Field>
              )}
              <Field label={ai ? "选择 AI 对手" : "选择卡组"}>
                <select
                  value={ai ? aiChoices[index] : choices[index]}
                  onChange={(event) =>
                    ai
                      ? setAiChoices(
                          aiChoices.map((value, i) =>
                            i === index ? event.target.value : value,
                          ),
                        )
                      : setChoices(
                          choices.map((value, i) =>
                            i === index ? event.target.value : value,
                          ),
                        )
                  }
                >
                  <option value="">请选择</option>
                  {ai
                    ? opponents.map((record) => (
                        <option key={record.id} value={record.id}>
                          {record.name ?? "未命名 AI"} ·{" "}
                          {record.deck.name ?? "绑定卡组"}
                        </option>
                      ))
                    : decks.map((record) => (
                        <option key={record.id} value={record.id}>
                          {record.deck.name ?? "未命名卡组"} ·{" "}
                          {record.deck.cards.reduce((n, e) => n + e.count, 0)}{" "}
                          张
                        </option>
                      ))}
                </select>
              </Field>
              {ai && !opponents.length && (
                <p className="muted">先到「资料库」创建 AI 对手。</p>
              )}
              {!ai && !decks.length && (
                <p className="muted">先到「资料库」导入或创建卡组。</p>
              )}
            </section>
          );
        })}
      </div>
      {mode !== "local" && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={autoRun}
            onChange={(event) => setAutoRun(event.target.checked)}
          />
          建局后立即运行 AI
        </label>
      )}
      <footer className="modal-footer">
        <Button onClick={close}>取消</Button>
        <Button
          kind="primary"
          disabled={busy}
          onClick={() => {
            if (
              (mode !== "ai_ai" && !choices[0]) ||
              (mode === "local" && !choices[1])
            ) {
              setError("请选择双方卡组");
              return;
            }
            if (
              (mode === "ai_ai" && !aiChoices[0]) ||
              (mode !== "local" && !aiChoices[1])
            ) {
              setError("请选择 AI 对手");
              return;
            }
            if (mode === "ai_ai" && aiChoices[0] === aiChoices[1]) {
              setError(
                "同一个 AI 对手不能同时占据两席。请创建或导入两名独立对手。",
              );
              return;
            }
            const players = ([0, 1] as const).map((index) => {
              const ai =
                mode === "ai_ai" || (mode === "human_ai" && index === 1);
              if (ai) {
                const opponent = opponents.find(
                  (item) => item.id === aiChoices[index],
                );
                if (!opponent) throw new Error("请选择 AI 对手");
                return {
                  kind: "ai" as const,
                  name: opponent.name ?? `AI ${index ? "B" : "A"}`,
                  opponentId: opponent.id,
                };
              }
              if (!choices[index]) throw new Error("请选择双方卡组");
              return {
                kind: "human" as const,
                name: names[index] || `玩家 ${index ? "B" : "A"}`,
                deckId: choices[index],
              };
            });
            setBusy(true);
            setError("");
            void api<CreateMatchResponse>("/matches", {
              method: "POST",
              body: jsonBody({
                mode,
                players: players as CreateMatchInput["players"],
                autoRun: mode === "local" ? false : autoRun,
              }),
            })
              .then(created)
              .catch((error) => setError(error.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "创建中…" : "创建对局"}
        </Button>
      </footer>
    </Modal>
  );
}
