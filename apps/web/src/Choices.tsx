import { useState } from "react";
import type {
  CardData,
  GameCommand,
  MatchView,
  Position,
  PublicEvent,
} from "../../../packages/protocol/src/index.ts";
import { Button, ErrorNote, Field, JsonDetails, Modal } from "./ui.tsx";
import { CardFace } from "./Cards.tsx";
import { positionKey, positionLabel } from "./table-utils.ts";
export function SetupChoice({
  view,
  execute,
  busy,
  canAct,
}: {
  view: MatchView;
  execute: (command: GameCommand) => Promise<void>;
  busy: boolean;
  canAct: boolean;
}) {
  const choice = view.flow.choice;
  const [active, setActive] = useState("");
  const [bench, setBench] = useState<string[]>([]);
  const [bonus, setBonus] = useState(0);
  const [error, setError] = useState("");
  if (
    !choice ||
    view.replay ||
    ![
      "choose_first",
      "initial_placement",
      "mulligan_draw",
      "additional_bench",
      "result_confirm",
      "handoff",
    ].includes(choice.kind)
  )
    return null;
  const eligible = choice.eligible ?? [];
  const posFor = (key: string) =>
    eligible.find((position) => positionKey(position) === key);
  async function run(command: GameCommand) {
    try {
      setError("");
      await execute(command);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <section className="choice-banner">
      <div>
        <h2>
          {choice.kind === "choose_first"
            ? "选择先攻玩家"
            : choice.kind === "initial_placement"
              ? "摆放最初的宝可梦"
              : choice.kind === "mulligan_draw"
                ? "对方重抽，你可以补抽"
                : choice.kind === "additional_bench"
                  ? "追加备战宝可梦"
                  : choice.kind === "result_confirm"
                    ? "请确认对局结果"
                    : "操作权已交到你手中"}
        </h2>
        <p>{choice.message || (canAct ? "请完成下方选择。" : `等待玩家 ${choice.playerId} 作出选择。`)}</p>
      </div>
      {canAct && (
        <div className="choice-controls">
          <ErrorNote value={error} />
          {choice.kind === "choose_first" && (
            <div className="actions">
              <Button
                disabled={busy}
                onClick={() =>
                  void run({ kind: "choose_first", firstPlayer: "A" })
                }
              >
                A 先攻
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run({ kind: "choose_first", firstPlayer: "B" })
                }
              >
                B 先攻
              </Button>
            </div>
          )}
          {(choice.kind === "initial_placement" ||
            choice.kind === "additional_bench") && (
            <>
              {choice.kind === "initial_placement" && (
                <Field label="战斗宝可梦">
                  <select
                    value={active}
                    onChange={(event) => {
                      setActive(event.target.value);
                      setBench(
                        bench.filter((item) => item !== event.target.value),
                      );
                    }}
                  >
                    <option value="">请选择一张基础宝可梦</option>
                    {eligible.map((position) => (
                      <option
                        key={positionKey(position)}
                        value={positionKey(position)}
                      >
                        {choiceName(view, position)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field
                label={`备战宝可梦（最多 ${choice.maximum ?? 5} 只，可不放）`}
              >
                <div className="choice-cards">
                  {eligible.map((position) => {
                    const key = positionKey(position);
                    return (
                      <label
                        key={key}
                        className={bench.includes(key) ? "checked" : ""}
                      >
                        <input
                          type="checkbox"
                          checked={bench.includes(key)}
                          disabled={
                            key === active ||
                            (!bench.includes(key) &&
                              bench.length >= (choice.maximum ?? 5))
                          }
                          onChange={(event) =>
                            setBench(
                              event.target.checked
                                ? [...bench, key]
                                : bench.filter((item) => item !== key),
                            )
                          }
                        />
                        {choiceName(view, position)}
                      </label>
                    );
                  })}
                </div>
              </Field>
              <Button
                kind="primary"
                disabled={
                  busy ||
                  (choice.kind === "initial_placement" && !posFor(active))
                }
                onClick={() => {
                  const picks = bench
                    .map(posFor)
                    .filter((item): item is Position => Boolean(item));
                  void run(
                    choice.kind === "initial_placement"
                      ? {
                          kind: "initial_placement",
                          active: posFor(active)!,
                          bench: picks,
                        }
                      : { kind: "additional_bench", bench: picks },
                  ).then(() => {
                    setActive("");
                    setBench([]);
                  });
                }}
              >
                提交摆放
              </Button>
            </>
          )}
          {choice.kind === "mulligan_draw" && (
            <>
              <details>
                <summary>
                  查看对方重抽时公开的手牌（{choice.failedHands?.length ?? 0}{" "}
                  次）
                </summary>
                {choice.failedHands?.map((cards, index) => (
                  <div className="failed-hand" key={index}>
                    <b>第 {index + 1} 次</b>
                    <div className="inspector-cards">
                      {cards.map((card, i) => (
                        <div className="small-card" key={i}>
                          <CardFace card={card} compact />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </details>
              <Field
                label={`补抽数量（0～${choice.maximum ?? 0} 张，一次决定）`}
              >
                <input
                  type="number"
                  min="0"
                  max={choice.maximum ?? 0}
                  value={bonus}
                  onChange={(event) => setBonus(Number(event.target.value))}
                />
              </Field>
              <Button
                kind="primary"
                disabled={busy}
                onClick={() =>
                  void run({ kind: "mulligan_draw", count: bonus })
                }
              >
                确认补抽数量
              </Button>
            </>
          )}
          {choice.kind === "result_confirm" && (
            <>
              <p>
                {view.flow.proposedResult?.kind === "win"
                  ? `${view.flow.proposedResult.winner} 获胜`
                  : "平局"}{" "}
                · {view.flow.proposedResult?.reason}
              </p>
              <Button
                kind="primary"
                disabled={busy}
                onClick={() =>
                  void run({ kind: "confirm_result", agree: true })
                }
              >
                认可结果，正式结束
              </Button>
              <small>有异议时，请在历史中选择相应记录提出。</small>
            </>
          )}
          {choice.kind === "handoff" && (
            <p>在牌桌完成选择，或点击「继续处理」。</p>
          )}
        </div>
      )}
    </section>
  );
}
function choiceName(view: MatchView, position: Position) {
  const object = view.zones.find((zone) => zone.id === position.zoneId)?.items[
    position.index
  ];
  return `${object?.kind === "card" ? object.card.name : "卡牌"} · ${positionLabel(position)}`;
}
export function DisputePanel({
  view,
  execute,
  busy,
  canRespond,
}: {
  view: MatchView;
  execute: (command: GameCommand) => Promise<void>;
  busy: boolean;
  canRespond: boolean;
}) {
  const dispute = view.dispute;
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState("");
  if (!dispute) return null;
  async function run(command: GameCommand) {
    try {
      setError("");
      await execute(command);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <section
      className={`dispute-panel ${dispute.status === "closed" ? "closed" : ""}`}
    >
      <span className="eyebrow">
        {dispute.status === "closed" ? "已处理" : "处理中"}
      </span>
      <h3>玩家 {dispute.raisedBy} 对历史操作提出异议</h3>
      <p>{dispute.reason}</p>
      <p className="muted">
        目标：
        {view.events.find((event) => event.id === dispute.targetEventId)
          ?.label ?? dispute.targetEventId}
      </p>
      <JsonDetails label="明确处置提议" value={dispute.proposal} />
      <ErrorNote value={error} />
      {canRespond && dispute.status === "awaiting_response" && (
        <>
          <Button
            disabled={busy}
            onClick={() =>
              void run({
                kind: "respond",
                response: {
                  kind: "accept",
                  disputeId: dispute.id,
                  proposalId: dispute.proposalId,
                },
              })
            }
          >
            认可异议与此处置提议
          </Button>
          <Field label="辩护理由">
            <textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Field label="引用记录或规则编号（逗号分隔，可选）">
            <input
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </Field>
          <Button
            kind="primary"
            disabled={busy || !reason.trim()}
            onClick={() =>
              void run({
                kind: "respond",
                response: {
                  kind: "defend",
                  disputeId: dispute.id,
                  reason,
                  evidenceRefs: evidence
                    .split(/[,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean),
                },
              })
            }
          >
            提出辩护，交独立裁判
          </Button>
        </>
      )}
      {dispute.status === "awaiting_judge" && (
        <p>独立裁判正在核对相关规则和记录…</p>
      )}
      {dispute.ruling && (
        <div className="ruling">
          <b>{dispute.ruling.verdict === "uphold" ? "异议成立" : "异议驳回"}</b>
          <JsonDetails label="裁判依据与处置步骤" value={dispute.ruling} />
        </div>
      )}
    </section>
  );
}
export function ObjectionEditor({
  event,
  view,
  close,
  execute,
}: {
  event: PublicEvent;
  view: MatchView;
  close: () => void;
  execute: (command: GameCommand) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [restore, setRestore] = useState(!event.revokedBy);
  const [shuffle, setShuffle] = useState<string[]>([]);
  const [error, setError] = useState("");
  return (
    <Modal title="对历史原子命令提出异议" close={close}>
      <p className="eyebrow">
        #{event.sequence} · {event.label}
      </p>
      <JsonDetails value={event} />
      <ErrorNote value={error} />
      <Field label="异议理由">
        <textarea
          rows={4}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <Field label="规则或记录引用（可选，逗号分隔）">
        <input
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
      </Field>
      <label className="check-label">
        <input
          type="checkbox"
          checked={restore}
          disabled={Boolean(event.revokedBy)}
          onChange={(event) => setRestore(event.target.checked)}
        />
        建议恢复到该操作执行前
        {event.revokedBy ? "（此事件已撤销，不可恢复旧分支）" : ""}
      </label>
      <Field label="建议恢复后洗牌的区域（可选）">
        <div className="conditions-picker">
          {view.zones
            .filter(
              (zone) =>
                zone.kind === "deck" ||
                zone.kind === "hand" ||
                zone.kind === "prizes",
            )
            .map((zone) => (
              <label key={zone.id}>
                <input
                  type="checkbox"
                  checked={shuffle.includes(zone.id)}
                  onChange={(event) =>
                    setShuffle(
                      event.target.checked
                        ? [...shuffle, zone.id]
                        : shuffle.filter((item) => item !== zone.id),
                    )
                  }
                />
                {zone.id
                  .replace(":deck", " 牌库")
                  .replace(":hand", " 手牌")
                  .replace(":prizes", " 奖赏卡")}
              </label>
            ))}
        </div>
      </Field>
      <p className="muted">
        恢复牌桌和对局流程；原历史、已获知信息及 agent 记忆均保留。
      </p>
      <footer className="modal-footer">
        <Button onClick={close}>取消</Button>
        <Button
          kind="primary"
          disabled={!reason.trim()}
          onClick={() => {
            void execute({
              kind: "object",
              targetEventId: event.id,
              reason,
              evidenceRefs: evidence
                .split(/[,，]/)
                .map((item) => item.trim())
                .filter(Boolean),
              proposal: {
                ...(restore ? { restoreBeforeEventId: event.id } : {}),
                shuffles: shuffle.map((zoneId) => ({
                  container: { kind: "zone", zoneId },
                  range: { mode: "all" },
                })),
              },
            })
              .then(close)
              .catch((error) => setError(error.message));
          }}
        >
          提交异议
        </Button>
      </footer>
    </Modal>
  );
}
export function RevealedCards({ value }: { value: unknown }) {
  const cards: CardData[] = [];
  const walk = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    const entry = item as Record<string, unknown>;
    if (
      ["pokemon", "trainer", "energy"].includes(String(entry.kind)) &&
      typeof entry.name === "string"
    ) {
      cards.push(entry as CardData);
      return;
    }
    Object.values(entry).forEach(walk);
  };
  walk(value);
  return cards.length ? (
    <div className="inspector-cards">
      {cards.map((card, index) => (
        <div className="large-card" key={index}>
          <CardFace card={card} />
        </div>
      ))}
    </div>
  ) : null;
}
export function RandomResult({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const result = value as { coins?: string[]; positions?: Position[] };
  if (Array.isArray(result.coins))
    return (
      <div className="coin-results">
        {result.coins.map((coin, index) => (
          <div className={`coin-result ${coin}`} key={index}>
            <span>{coin === "heads" ? "✦" : "✳"}</span>
            <b>{coin === "heads" ? "正面" : "反面"}</b>
            <small>第 {index + 1} 枚</small>
          </div>
        ))}
      </div>
    );
  if (Array.isArray(result.positions))
    return (
      <div className="random-positions">
        <h3>随机选中的位置</h3>
        {result.positions.map((position) => (
          <p key={positionKey(position)}>{positionLabel(position)}</p>
        ))}
      </div>
    );
  return null;
}
