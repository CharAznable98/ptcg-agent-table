import { useEffect, useState } from "react";
import type {
  CardData,
  DeckData,
  DeckRecord,
  OpponentRecord,
} from "../../../packages/protocol/src/index.ts";
import { api, downloadJson, importFile, jsonBody } from "./api.ts";
import {
  Button,
  Empty,
  ErrorNote,
  Field,
  FileImport,
  JsonEditor,
  Modal,
  ConfirmAction,
} from "./ui.tsx";
import { CardFace } from "./Cards.tsx";
import { parseDeck, parseCard } from "./validation.ts";
const blankCard: CardData = {
  kind: "pokemon",
  name: "新的宝可梦",
  hp: 100,
  types: ["草"],
  stage: "基础",
  abilities: [],
  attacks: [
    {
      name: "撞击",
      energyCost: [{ type: "无色", count: 1 }],
      damageText: "20",
      text: "",
    },
  ],
  weaknesses: [],
  resistances: [],
  retreatCost: 1,
};
export const exampleDeck: DeckData = {
  name: "合成练习卡组（非官方卡）",
  cards: [
    {
      count: 4,
      card: {
        ...blankCard,
        name: "练习叶芽",
        hp: 20,
        attacks: [
          {
            name: "轻击",
            energyCost: [{ type: "草", count: 1 }],
            damageText: "10",
            text: "",
          },
        ],
        rulesText: "项目合成练习卡，不是官方卡牌。",
      },
    },
    {
      count: 56,
      card: {
        kind: "energy",
        subtype: "basic",
        name: "基本草能量",
        energyType: "草",
      },
    },
  ],
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export function Library() {
  const [tab, setTab] = useState<"decks" | "opponents">("decks");
  const [decks, setDecks] = useState<DeckRecord[]>([]);
  const [opponents, setOpponents] = useState<OpponentRecord[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deletion, setDeletion] = useState<{
    kind: "decks" | "opponents";
    id: string;
    name: string;
  } | null>(null);
  const [deckEdit, setDeckEdit] = useState<{
    id?: string;
    deck: DeckData;
  } | null>(null);
  const [opponentEdit, setOpponentEdit] = useState<
    OpponentRecord | "new" | null
  >(null);
  async function load() {
    const [a, b] = await Promise.all([
      api<{ decks: DeckRecord[] }>("/decks"),
      api<{ opponents: OpponentRecord[] }>("/opponents"),
    ]);
    setDecks(a.decks);
    setOpponents(b.opponents);
  }
  useEffect(() => {
    void load().catch((error) => setError(error.message));
  }, []);
  async function action(work: () => Promise<unknown>, success: string) {
    try {
      setError("");
      await work();
      await load();
      setMessage(success);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <main className="page library-page">
      <div className="page-heading">
        <div>
          <h1>资料库</h1>
        </div>
      </div>
      <div className="section-toolbar">
        <div className="tabs">
          <button
            className={tab === "decks" ? "active" : ""}
            onClick={() => setTab("decks")}
          >
            卡组 <span>{decks.length}</span>
          </button>
          <button
            className={tab === "opponents" ? "active" : ""}
            onClick={() => setTab("opponents")}
          >
            AI 对手 <span>{opponents.length}</span>
          </button>
        </div>
        <div className="actions">
          <FileImport
            onImport={async (file) => {
              const value = await importFile(file);
              await action(
                () =>
                  api(tab === "decks" ? "/decks" : "/opponents/import", {
                    method: "POST",
                    body: jsonBody(tab === "decks" ? { deck: value } : value),
                  }),
                "导入成功",
              );
            }}
          />
          <Button
            kind="primary"
            onClick={() =>
              tab === "decks"
                ? setDeckEdit({
                    deck: {
                      name: "未命名卡组",
                      cards: [{ card: structuredClone(blankCard), count: 1 }],
                    },
                  })
                : setOpponentEdit("new")
            }
          >
            ＋ {tab === "decks" ? "新建卡组" : "创建 AI 对手"}
          </Button>
        </div>
      </div>
      <ErrorNote value={error} />
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      {tab === "decks" ? (
        <>
          {!decks.length && (
            <Empty
              title="暂无卡组"
            >
              <Button
                onClick={() =>
                  setDeckEdit({ deck: structuredClone(exampleDeck) })
                }
              >
                打开练习示例
              </Button>
            </Empty>
          )}
          <div className="collection-grid">
            {decks.map((record) => (
              <article className="deck-tile" key={record.id}>
                <div className="deck-preview">
                  {record.deck.cards
                    .slice(0, 3)
                    .reverse()
                    .map((entry, index) => (
                      <div className="preview-card" key={index}>
                        <CardFace card={entry.card} compact />
                      </div>
                    ))}
                </div>
                <div className="tile-body">
                  <span className="eyebrow">
                    {record.deck.cards.reduce((n, e) => n + e.count, 0)} 张
                  </span>
                  <h2>{record.deck.name || "未命名卡组"}</h2>
                  <p>
                    {record.deck.cards.length} 种卡牌 ·{" "}
                    {new Date(record.updatedAt).toLocaleDateString("zh-CN")}
                  </p>
                  <div className="actions">
                    <Button
                      onClick={() =>
                        setDeckEdit({
                          id: record.id,
                          deck: structuredClone(record.deck),
                        })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      onClick={() =>
                        void action(
                          async () =>
                            downloadJson(
                              await api(`/decks/${record.id}/export`),
                              `${record.deck.name || "卡组"}.json`,
                            ),
                          "已导出卡组",
                        )
                      }
                    >
                      导出
                    </Button>
                    <Button
                      kind="text danger"
                      onClick={() =>
                        setDeletion({
                          kind: "decks",
                          id: record.id,
                          name: record.deck.name || "未命名卡组",
                        })
                      }
                    >
                      删除
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <>
          {!opponents.length && (
            <Empty
              title="暂无 AI 对手"
            />
          )}
          <div className="opponent-list">
            {opponents.map((record, index) => (
              <article className="opponent-tile" key={record.id}>
                <div className="opponent-seal">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div>
                  <h2>{record.name || "未命名对手"}</h2>
                  <p>
                    {record.deck.name || "绑定卡组"} · 策略版本{" "}
                    {record.strategies.at(-1)?.version ?? 0}
                  </p>
                  <p className="strategy-preview">
                    {record.strategies.at(-1)?.content ||
                      "策略为空"}
                  </p>
                </div>
                <div className="actions">
                  <Button onClick={() => setOpponentEdit(record)}>
                    编辑 / 策略历史
                  </Button>
                  <Button
                    onClick={() =>
                      void action(
                        async () =>
                          downloadJson(
                            await api(`/opponents/${record.id}/export`),
                            `${record.name || "AI对手"}.json`,
                          ),
                        "已导出 AI 对手",
                      )
                    }
                  >
                    导出
                  </Button>
                  <Button
                    kind="text danger"
                    onClick={() =>
                      setDeletion({
                        kind: "opponents",
                        id: record.id,
                        name: record.name || "未命名 AI 对手",
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {deletion && (
        <ConfirmAction
          title={deletion.kind === "decks" ? "删除卡组" : "删除 AI 对手"}
          description={
            <p>
              确认删除「{deletion.name}」？此操作会删除已保存的
              {deletion.kind === "decks" ? "卡组" : "AI 对手及其策略历史"}。
            </p>
          }
          confirmLabel="确认删除"
          close={() => setDeletion(null)}
          onConfirm={async () => {
            await api(`/${deletion.kind}/${deletion.id}`, { method: "DELETE" });
            await load();
            setMessage("已删除");
          }}
        />
      )}
      {deckEdit && (
        <DeckEditor
          initial={deckEdit.deck}
          close={() => setDeckEdit(null)}
          save={async (deck) => {
            await api(deckEdit.id ? `/decks/${deckEdit.id}` : "/decks", {
              method: deckEdit.id ? "PUT" : "POST",
              body: jsonBody({ deck }),
            });
            await load();
            setDeckEdit(null);
            setMessage("卡组已保存");
          }}
        />
      )}
      {opponentEdit && (
        <OpponentEditor
          record={opponentEdit}
          decks={decks}
          close={() => setOpponentEdit(null)}
          save={async (value) => {
            await api(
              opponentEdit === "new"
                ? "/opponents"
                : `/opponents/${opponentEdit.id}`,
              {
                method: opponentEdit === "new" ? "POST" : "PUT",
                body: jsonBody(value),
              },
            );
            await load();
            setOpponentEdit(null);
            setMessage("AI 对手已保存");
          }}
        />
      )}
    </main>
  );
}
function DeckEditor({
  initial,
  close,
  save,
}: {
  initial: DeckData;
  close: () => void;
  save: (deck: DeckData) => Promise<void>;
}) {
  const [deck, setDeck] = useState(initial);
  const [raw, setRaw] = useState(pretty(initial));
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const [cardEdit, setCardEdit] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (next: DeckData) => {
    setDeck(next);
    setRaw(pretty(next));
  };
  return (
    <Modal title="编辑卡组" close={close} wide>
      <div className="editor-toolbar">
        <div className="tabs">
          <button
            className={mode === "visual" ? "active" : ""}
            onClick={() => {
              try {
                update(parseDeck(raw));
                setMode("visual");
                setError("");
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          >
            卡牌编辑器
          </button>
          <button
            className={mode === "json" ? "active" : ""}
            onClick={() => setMode("json")}
          >
            JSON
          </button>
        </div>
        <strong>{deck.cards.reduce((n, e) => n + e.count, 0)} / 60 张</strong>
      </div>
      <ErrorNote value={error} />
      {mode === "json" ? (
        <JsonEditor value={raw} onChange={setRaw} rows={22} />
      ) : (
        <>
          <Field label="卡组名称">
            <input
              value={deck.name ?? ""}
              onChange={(event) =>
                update({ ...deck, name: event.target.value })
              }
            />
          </Field>
          <div className="deck-entries">
            {deck.cards.map((entry, index) => (
              <div className="deck-entry" key={index}>
                <span className={`type-dot ${entry.card.kind}`} />
                <button
                  className="entry-name"
                  onClick={() => setCardEdit(index)}
                >
                  {entry.card.name}
                  <small>
                    {entry.card.kind === "pokemon"
                      ? "宝可梦"
                      : entry.card.kind === "trainer"
                        ? "训练家"
                        : "能量"}
                  </small>
                </button>
                <Field label="投入数量">
                  <input
                    aria-label={`${entry.card.name}投入数量`}
                    type="number"
                    min="1"
                    value={entry.count}
                    onChange={(event) =>
                      update({
                        ...deck,
                        cards: deck.cards.map((item, i) =>
                          i === index
                            ? { ...item, count: Number(event.target.value) }
                            : item,
                        ),
                      })
                    }
                  />
                </Field>
                <Button onClick={() => setCardEdit(index)}>编辑卡牌</Button>
                <Button
                  kind="text danger"
                  onClick={() =>
                    update({
                      ...deck,
                      cards: deck.cards.filter((_, i) => i !== index),
                    })
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
          <Button
            onClick={() => {
              update({
                ...deck,
                cards: [
                  ...deck.cards,
                  { card: structuredClone(blankCard), count: 1 },
                ],
              });
              setCardEdit(deck.cards.length);
            }}
          >
            ＋ 添加卡牌
          </Button>
        </>
      )}
      <footer className="modal-footer">
        <Button onClick={close}>取消</Button>
        <Button
          kind="primary"
          disabled={busy}
          onClick={() => {
            try {
              const value = parseDeck(mode === "json" ? raw : pretty(deck));
              setBusy(true);
              void save(value)
                .catch((error) => setError(error.message))
                .finally(() => setBusy(false));
            } catch (error) {
              setError((error as Error).message);
            }
          }}
        >
          保存卡组
        </Button>
      </footer>
      {cardEdit !== null && deck.cards[cardEdit] && (
        <CardEditor
          card={deck.cards[cardEdit]!.card}
          close={() => setCardEdit(null)}
          save={(card) => {
            update({
              ...deck,
              cards: deck.cards.map((item, i) =>
                i === cardEdit ? { ...item, card } : item,
              ),
            });
            setCardEdit(null);
          }}
        />
      )}
    </Modal>
  );
}
function CardEditor({
  card,
  close,
  save,
}: {
  card: CardData;
  close: () => void;
  save: (card: CardData) => void;
}) {
  const [value, setValue] = useState(card);
  const [raw, setRaw] = useState(pretty(card));
  const [json, setJson] = useState(false);
  const [error, setError] = useState("");
  const change = (next: CardData) => {
    setValue(next);
    setRaw(pretty(next));
  };
  return (
    <Modal title="卡牌资料" close={close}>
      <ErrorNote value={error} />
      <div className="actions">
        <Button
          onClick={() => {
            if (json) {
              try {
                change(parseCard(raw));
                setJson(false);
              } catch {
                setError("JSON 格式无效");
              }
            } else setJson(true);
          }}
        >
          {json ? "返回表单" : "完整字段 JSON"}
        </Button>
      </div>
      {json ? (
        <JsonEditor value={raw} onChange={setRaw} rows={24} />
      ) : (
        <>
          <Field label="卡牌类型">
            <select
              value={value.kind}
              onChange={(event) => {
                const kind = event.target.value;
                change(
                  kind === "pokemon"
                    ? structuredClone(blankCard)
                    : kind === "trainer"
                      ? {
                          kind: "trainer",
                          subtype: "item",
                          name: "新训练家",
                          text: "",
                        }
                      : {
                          kind: "energy",
                          subtype: "basic",
                          name: "基本草能量",
                          energyType: "草",
                        },
                );
              }}
            >
              <option value="pokemon">宝可梦</option>
              <option value="trainer">训练家</option>
              <option value="energy">能量</option>
            </select>
          </Field>
          <Field label="名称">
            <input
              value={value.name}
              onChange={(event) =>
                change({ ...value, name: event.target.value })
              }
            />
          </Field>
          <Field label="卡图 URL（可选）">
            <input
              type="url"
              placeholder="https://…"
              value={value.imageUrl ?? ""}
              onChange={(event) => {
                const next = { ...value };
                if (event.target.value) next.imageUrl = event.target.value;
                else delete next.imageUrl;
                change(next);
              }}
            />
          </Field>
          {value.kind === "pokemon" ? (
            <>
              <div className="form-grid">
                <Field label="HP">
                  <input
                    type="number"
                    value={value.hp}
                    onChange={(event) =>
                      change({ ...value, hp: Number(event.target.value) })
                    }
                  />
                </Field>
                <Field label="进化阶段">
                  <input
                    value={value.stage}
                    onChange={(event) =>
                      change({ ...value, stage: event.target.value })
                    }
                  />
                </Field>
                <Field label="属性（逗号分隔）">
                  <input
                    value={value.types.join(",")}
                    onChange={(event) =>
                      change({ ...value, types: event.target.value.split(",") })
                    }
                  />
                </Field>
                <Field label="撤退所需能量">
                  <input
                    type="number"
                    min="0"
                    value={value.retreatCost}
                    onChange={(event) =>
                      change({
                        ...value,
                        retreatCost: Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="进化来源（可选）">
                <input
                  value={value.evolvesFrom ?? ""}
                  onChange={(event) => {
                    const next = { ...value };
                    if (event.target.value)
                      next.evolvesFrom = event.target.value;
                    else delete next.evolvesFrom;
                    change(next);
                  }}
                />
              </Field>
              <Field
                label="招式、特性、弱点与抗性"
              >
                <Button onClick={() => setJson(true)}>编辑完整卡牌字段</Button>
              </Field>
            </>
          ) : (
            <>
              <Field label="子类型">
                <select
                  value={value.subtype}
                  onChange={(event) => {
                    if (value.kind === "trainer")
                      change({ ...value, subtype: event.target.value });
                    else
                      change(
                        event.target.value === "basic"
                          ? {
                              kind: "energy",
                              subtype: "basic",
                              name: value.name,
                              energyType: "草",
                            }
                          : {
                              kind: "energy",
                              subtype: "special",
                              name: value.name,
                              text: "",
                            },
                      );
                  }}
                >
                  {value.kind === "trainer" ? (
                    <>
                      <option value="item">物品</option>
                      <option value="tool">宝可梦道具</option>
                      <option value="supporter">支援者</option>
                      <option value="stadium">竞技场</option>
                    </>
                  ) : (
                    <>
                      <option value="basic">基本能量</option>
                      <option value="special">特殊能量</option>
                    </>
                  )}
                </select>
              </Field>
              {value.kind === "energy" && value.subtype === "basic" && (
                <Field label="能量属性">
                  <input
                    value={value.energyType}
                    onChange={(event) =>
                      change({ ...value, energyType: event.target.value })
                    }
                  />
                </Field>
              )}
              <Field label="效果说明">
                <textarea
                  rows={5}
                  value={value.text ?? ""}
                  onChange={(event) =>
                    change({ ...value, text: event.target.value })
                  }
                />
              </Field>
            </>
          )}
          <Field label="特别规则（可选）">
            <textarea
              value={value.rulesText ?? ""}
              onChange={(event) =>
                change({ ...value, rulesText: event.target.value })
              }
            />
          </Field>
        </>
      )}
      <footer className="modal-footer">
        <Button
          kind="primary"
          onClick={() => {
            try {
              save(parseCard(json ? raw : pretty(value)));
            } catch {
              setError("JSON 格式无效");
            }
          }}
        >
          使用此卡牌
        </Button>
      </footer>
    </Modal>
  );
}
function OpponentEditor({
  record,
  decks,
  close,
  save,
}: {
  record: OpponentRecord | "new";
  decks: DeckRecord[];
  close: () => void;
  save: (value: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(
    record === "new" ? "新 AI 对手" : (record.name ?? ""),
  );
  const [deckId, setDeckId] = useState(decks[0]?.id ?? "");
  const [deck, setDeck] = useState(
    pretty(record === "new" ? (decks[0]?.deck ?? exampleDeck) : record.deck),
  );
  const [strategy, setStrategy] = useState(
    record === "new" ? "" : (record.strategies.at(-1)?.content ?? ""),
  );
  const [version, setVersion] = useState(
    record === "new" ? 0 : (record.strategies.at(-1)?.version ?? 0),
  );
  const [error, setError] = useState("");
  return (
    <Modal title="AI 对手与长期策略" close={close} wide>
      <ErrorNote value={error} />
      <div className="form-grid">
        <div>
          <Field label="对手名称">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="从资料库绑定卡组">
            <select
              value={deckId}
              onChange={(event) => {
                setDeckId(event.target.value);
                const chosen = decks.find(
                  (item) => item.id === event.target.value,
                );
                if (chosen) setDeck(pretty(chosen.deck));
              }}
            >
              {decks.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.deck.name ?? "未命名卡组"}
                </option>
              ))}
            </select>
          </Field>
          <JsonEditor
            label="绑定卡组 JSON（保存独立副本）"
            value={deck}
            onChange={setDeck}
          />
        </div>
        <div>
          <Field
            label="当前策略"
            hint="可留空；修改保存为新版本。"
          >
            <textarea
              rows={13}
              value={strategy}
              onChange={(event) => setStrategy(event.target.value)}
            />
          </Field>
          {record !== "new" && (
            <>
              <Field label="查看历史版本">
                <select
                  value={version}
                  onChange={(event) => setVersion(Number(event.target.value))}
                >
                  {record.strategies.map((item) => (
                    <option value={item.version} key={item.version}>
                      v{item.version} ·{" "}
                      {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                      {item.source.kind === "match"
                        ? "赛后总结"
                        : item.source.kind === "initial"
                          ? "初始策略"
                          : "手动编辑"}
                    </option>
                  ))}
                </select>
              </Field>
              <pre className="strategy-history">
                {record.strategies.find((item) => item.version === version)
                  ?.content || "（空策略）"}
              </pre>
            </>
          )}
        </div>
      </div>
      <footer className="modal-footer">
        <Button onClick={close}>取消</Button>
        <Button
          kind="primary"
          onClick={() => {
            try {
              void save({ name, deck: parseDeck(deck), strategy }).catch(
                (error) => setError(error.message),
              );
            } catch {
              setError("卡组 JSON 格式无效");
            }
          }}
        >
          保存 AI 对手
        </Button>
      </footer>
    </Modal>
  );
}
