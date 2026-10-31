import { useState } from "react";
import type {
  GameCommand,
  MatchView,
  PlayerId,
  Position,
  Selection,
} from "../../../packages/protocol/src/index.ts";
type StateCommand = Extract<GameCommand, { kind: "set_state" }>;
type StateField = StateCommand["field"];
type StateTarget = StateCommand["target"];
import { Button, ErrorNote, Field, JsonEditor, ConfirmAction } from "./ui.tsx";
import {
  conditionNames,
  containerFor,
  containerKey,
  containers,
  destinationFor,
  objectAt,
  positionLabel,
  selectionFromPositions,
} from "./table-utils.ts";
export interface DestinationPick {
  key: string;
  index: number;
}
export function Operations({
  view,
  selected,
  setSelected,
  destination,
  setDestination,
  execute,
  busy,
  enabled,
  canConcede = enabled,
}: {
  view: MatchView;
  selected: Position[];
  setSelected: (value: Position[]) => void;
  destination: DestinationPick;
  setDestination: (value: DestinationPick) => void;
  execute: (command: GameCommand) => Promise<void>;
  busy: boolean;
  enabled: boolean;
  canConcede?: boolean;
}) {
  const [tab, setTab] = useState("move");
  const [error, setError] = useState("");
  const [concede, setConcede] = useState(false);
  const [sourceMode, setSourceMode] = useState<"selected" | "range" | "all">(
    "selected",
  );
  const [sourceKey, setSourceKey] = useState("A:deck");
  const [start, setStart] = useState(1);
  const [count, setCount] = useState(1);
  const [stateKey, setStateKey] = useState("damageCounters");
  const [damage, setDamage] = useState(0);
  const [conditions, setConditions] = useState<string[]>([]);
  const [visibility, setVisibility] = useState("public");
  const [markerName, setMarkerName] = useState("");
  const [markerValue, setMarkerValue] = useState("true");
  const [targetKind, setTargetKind] = useState<"selected" | "A" | "B">(
    "selected",
  );
  const [randomMode, setRandomMode] = useState<
    "coins" | "until_tails" | "selection"
  >("coins");
  const [coinCount, setCoinCount] = useState(1);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"turn" | "check">("check");
  const [turnOwner, setTurnOwner] = useState<PlayerId | "none">("none");
  const [resultKind, setResultKind] = useState<"win" | "draw">("win");
  const [winner, setWinner] = useState<PlayerId>("A");
  const [reason, setReason] = useState("");
  const [raw, setRaw] = useState('{\n  "kind": "declare",\n  "text": ""\n}');
  const options = containers(view).filter((item) => {
    const zoneId =
      item.container.kind === "zone"
        ? item.container.zoneId
        : item.container.position.zoneId;
    const kind = view.zones.find((zone) => zone.id === zoneId)?.kind;
    return kind !== "lost" && kind !== "staging";
  });
  const selection = (): Selection => {
    if (sourceMode === "selected") return selectionFromPositions(selected);
    const container = options.find((item) => item.key === sourceKey)?.container;
    if (!container) throw new Error("请选择来源");
    return {
      container,
      range:
        sourceMode === "all"
          ? { mode: "all" }
          : { mode: "range", start: start - 1, count },
    };
  };
  async function run(build: () => GameCommand) {
    try {
      setError("");
      await execute(build());
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const sourcePicker = (
    <>
      <div className="selection-note">
        <b>已选 {selected.length} 个对象</b>
        <Button kind="text" onClick={() => setSelected([])}>
          清空
        </Button>
        {selected.map((item) => (
          <small key={positionLabel(item)}>{positionLabel(item)}</small>
        ))}
      </div>
      <Field label="来源方式">
        <select
          value={sourceMode}
          onChange={(event) =>
            setSourceMode(event.target.value as typeof sourceMode)
          }
        >
          <option value="selected">牌桌点选（单个或同源多选）</option>
          <option value="range">指定连续范围</option>
          <option value="all">来源全部</option>
        </select>
      </Field>
      {sourceMode !== "selected" && (
        <>
          <Field label="来源区域或卡牌组">
            <select
              value={sourceKey}
              onChange={(event) => setSourceKey(event.target.value)}
            >
              {options.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label} · {item.size} 位
                </option>
              ))}
            </select>
          </Field>
          {sourceMode === "range" && (
            <div className="form-grid">
              <Field label="起始位置（从 1 开始）">
                <input
                  min="1"
                  type="number"
                  value={start}
                  onChange={(event) => setStart(Number(event.target.value))}
                />
              </Field>
              <Field label="数量">
                <input
                  min="1"
                  type="number"
                  value={count}
                  onChange={(event) => setCount(Number(event.target.value))}
                />
              </Field>
            </div>
          )}
        </>
      )}
    </>
  );
  const destinationPicker = (
    <div className="destination-picker">
      <Field label="目标区域或卡牌组">
        <select
          value={destination.key}
          onChange={(event) =>
            setDestination({ key: event.target.value, index: 0 })
          }
        >
          {options.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="插入位置（从 1 开始；牌库第 1 位为顶部）">
        <input
          type="number"
          min="1"
          value={destination.index + 1}
          onChange={(event) =>
            setDestination({
              ...destination,
              index: Math.max(0, Number(event.target.value) - 1),
            })
          }
        />
      </Field>
    </div>
  );
  return (
    <aside className="operation-panel">
      <div className="operation-heading">
        <h2>牌桌操作</h2>
        <span className={`authority ${enabled ? "can-act" : ""}`}>
          {enabled ? `${view.viewer} 正在操作` : "当前只读"}
        </span>
      </div>
      <div className="operation-tabs">
        {[
          ["move", "移动"],
          ["shuffle", "洗牌"],
          ["state", "状态"],
          ["reveal", "查看 / 展示"],
          ["random", "随机"],
          ["group", "空组"],
          ["flow", "流程"],
          ["advanced", "JSON"],
        ].map(([key, label]) => (
          <button
            className={tab === key ? "active" : ""}
            key={key}
            onClick={() => {
              setTab(key!);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="operation-body">
        <ErrorNote value={error} />
        {!enabled && (
          <p className="muted">
            {view.replay
              ? "回放模式只读。"
              : "轮到你或收到异议回应请求时，即可提交操作。"}
          </p>
        )}
        {["move", "shuffle", "reveal"].includes(tab) && sourcePicker}
        {tab === "move" && (
          <>
            {destinationPicker}
            <Button
              kind="primary full"
              disabled={!enabled || busy}
              onClick={() =>
                void run(() => ({
                  kind: "move",
                  source: selection(),
                  destination: destinationFor(
                    destination.key,
                    destination.index,
                    view,
                  ),
                }))
              }
            >
              移动到目标
            </Button>
          </>
        )}
        {tab === "shuffle" && (
          <>
            <p className="muted">
              只打乱所选范围中的对象，范围以外的位置保持不变。
            </p>
            <Button
              kind="primary full"
              disabled={!enabled || busy}
              onClick={() =>
                void run(() => ({ kind: "shuffle", selection: selection() }))
              }
            >
              洗牌
            </Button>
          </>
        )}
        {tab === "reveal" && (
          <>
            <p className="muted">
              查看仅向自己提供牌面；展示一次性向双方提供牌面。两者均保留记录。
            </p>
            <div className="actions">
              <Button
                disabled={!enabled || busy}
                onClick={() =>
                  void run(() => ({ kind: "look", selection: selection() }))
                }
              >
                仅自己查看
              </Button>
              <Button
                kind="primary"
                disabled={!enabled || busy}
                onClick={() =>
                  void run(() => ({ kind: "show", selection: selection() }))
                }
              >
                向双方展示
              </Button>
            </div>
          </>
        )}
        {tab === "state" && (
          <>
            <div className="selection-note">
              目标：
              {selected[0] ? positionLabel(selected[0]) : "请点选卡牌或卡牌组"}
            </div>
            <Field label="状态对象">
              <select
                value={targetKind}
                onChange={(event) =>
                  setTargetKind(event.target.value as typeof targetKind)
                }
              >
                <option value="selected">点选的对象</option>
                <option value="A">玩家 A 的标记</option>
                <option value="B">玩家 B 的标记</option>
              </select>
            </Field>
            <Field label="字段">
              <select
                value={stateKey}
                onChange={(event) => setStateKey(event.target.value)}
              >
                <option value="damageCounters">伤害指示物</option>
                <option value="specialConditions">特殊状态</option>
                <option value="visibility">可见范围</option>
                <option value="marker">自定义标记</option>
              </select>
            </Field>
            {stateKey === "damageCounters" && (
              <Field label="伤害指示物数量（每个 10 点伤害）">
                <input
                  type="number"
                  min="0"
                  value={damage}
                  onChange={(event) => setDamage(Number(event.target.value))}
                />
              </Field>
            )}
            {stateKey === "specialConditions" && (
              <div className="conditions-picker">
                {Object.entries(conditionNames).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={conditions.includes(key)}
                      onChange={(event) =>
                        setConditions(
                          event.target.checked
                            ? [...conditions, key]
                            : conditions.filter((item) => item !== key),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
            {stateKey === "visibility" && (
              <Field label="谁能持续看到牌面">
                <select
                  value={visibility}
                  onChange={(event) => setVisibility(event.target.value)}
                >
                  <option value="public">公开可见</option>
                  <option value="hidden">双方不可见</option>
                  <option value="A">仅 A 可见</option>
                  <option value="B">仅 B 可见</option>
                  <option value="default">恢复所在区域默认可见范围</option>
                </select>
              </Field>
            )}
            {stateKey === "marker" && (
              <>
                <Field label="标记名称">
                  <input
                    value={markerName}
                    onChange={(event) => setMarkerName(event.target.value)}
                    placeholder="如：本回合已使用特性"
                  />
                </Field>
                <Field
                  label="标记值"
                  hint="支持文字、数字、true/false；填 null 删除标记。"
                >
                  <input
                    value={markerValue}
                    onChange={(event) => setMarkerValue(event.target.value)}
                  />
                </Field>
              </>
            )}
            <Button
              kind="primary full"
              disabled={!enabled || busy}
              onClick={() =>
                void run(() => {
                  const position = selected[0];
                  if (!position && targetKind === "selected")
                    throw new Error("请先点选状态对象");
                  const object = position ? objectAt(view, position) : null;
                  const target: StateTarget =
                    targetKind !== "selected"
                      ? { kind: "player", playerId: targetKind }
                      : object?.kind === "group"
                        ? {
                            kind: "group",
                            position: {
                              zoneId: position!.zoneId,
                              index: position!.index,
                            },
                          }
                        : { kind: "card", position: position! };
                  let field: StateField;
                  if (stateKey === "damageCounters")
                    field = { key: "damageCounters", value: damage };
                  else if (stateKey === "specialConditions")
                    field = { key: "specialConditions", value: conditions };
                  else if (stateKey === "visibility")
                    field = {
                      key: "visibility",
                      value:
                        visibility === "default"
                          ? null
                          : visibility === "A" || visibility === "B"
                            ? { mode: "players", playerIds: [visibility] }
                            : { mode: visibility as "public" | "hidden" },
                    };
                  else {
                    let value: string | number | boolean | null = markerValue;
                    try {
                      const parsed = JSON.parse(markerValue);
                      if (
                        parsed === null ||
                        ["string", "number", "boolean"].includes(typeof parsed)
                      )
                        value = parsed;
                    } catch {}
                    field = { key: "marker", name: markerName, value };
                  }
                  return { kind: "set_state", target, field };
                })
              }
            >
              更新状态
            </Button>
          </>
        )}
        {tab === "random" && (
          <>
            <Field label="随机操作">
              <select
                value={randomMode}
                onChange={(event) =>
                  setRandomMode(event.target.value as typeof randomMode)
                }
              >
                <option value="coins">投掷多枚硬币</option>
                <option value="until_tails">持续投币，直到反面</option>
                <option value="selection">随机选择位置</option>
              </select>
            </Field>
            {randomMode === "coins" && (
              <Field label="硬币数量">
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={coinCount}
                  onChange={(event) => setCoinCount(Number(event.target.value))}
                />
              </Field>
            )}
            {randomMode === "selection" && sourcePicker}
            <Button
              kind="primary full"
              disabled={!enabled || busy}
              onClick={() =>
                void run(() =>
                  randomMode === "coins"
                    ? { kind: "random", mode: "coins", count: coinCount }
                    : randomMode === "until_tails"
                      ? { kind: "random", mode: "until_tails" }
                      : {
                          kind: "random",
                          mode: "selection",
                          selection: selection(),
                        },
                )
              }
            >
              产生并记录随机结果
            </Button>
          </>
        )}
        {tab === "group" && (
          <>
            {destinationPicker}
            <Button
              kind="primary full"
              disabled={!enabled || busy}
              onClick={() =>
                void run(() => ({
                  kind: "create_group",
                  destination: destinationFor(
                    destination.key,
                    destination.index,
                    view,
                  ),
                }))
              }
            >
              在目标位置创建空卡牌组
            </Button>
            <hr />
            <p className="muted">
              删除前须移走叠牌及附着卡。删除对象使用当前点选位置。
            </p>
            <Button
              disabled={!enabled || busy}
              onClick={() =>
                void run(() => {
                  if (!selected[0]) throw new Error("请点选要删除的空卡牌组");
                  return { kind: "remove_group", position: selected[0] };
                })
              }
            >
              删除选中的空卡牌组
            </Button>
          </>
        )}
        {tab === "flow" && (
          <>
            <Field label="宣告">
              <textarea
                value={text}
                rows={3}
                onChange={(event) => setText(event.target.value)}
                placeholder="使用特性、招式、结束回合或说明效果…"
              />
            </Field>
            <Button
              disabled={!enabled || busy || !text.trim()}
              onClick={() => void run(() => ({ kind: "declare", text }))}
            >
              记录宣告
            </Button>
            <hr />
            <div className="form-grid">
              <Field label="回合阶段">
                <select
                  value={phase}
                  onChange={(event) => {
                    const next = event.target.value as typeof phase;
                    setPhase(next);
                    setTurnOwner(
                      next === "check" ? "none" : view.flow.operator,
                    );
                  }}
                >
                  <option value="check">宝可梦检查</option>
                  <option value="turn">玩家回合</option>
                </select>
              </Field>
              <Field label="回合归属">
                <select
                  value={turnOwner}
                  disabled={phase === "check"}
                  onChange={(event) =>
                    setTurnOwner(event.target.value as typeof turnOwner)
                  }
                >
                  <option value="A">玩家 A</option>
                  <option value="B">玩家 B</option>
                  {phase === "check" && <option value="none">无</option>}
                </select>
              </Field>
            </div>
            <Button
              disabled={!enabled || busy}
              onClick={() =>
                void run(() => ({
                  kind: "set_turn",
                  phase,
                  playerId:
                    phase === "check"
                      ? null
                      : turnOwner === "none"
                        ? view.flow.operator
                        : turnOwner,
                }))
              }
            >
              更新回合与阶段
            </Button>
            <hr />
            <Field label="操作权交接理由">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="如：请选择替换上场的宝可梦"
              />
            </Field>
            <Button
              disabled={!enabled || busy || !reason.trim()}
              onClick={() =>
                void run(() => ({
                  kind: "handoff",
                  to: view.flow.operator === "A" ? "B" : "A",
                  reason,
                  ...(view.flow.handoffReturnTo ? { returning: true } : {}),
                }))
              }
            >
              {view.flow.handoffReturnTo ? "交还操作权" : "将操作权交给对方"}
            </Button>
            <hr />
            <Field label="报告结果">
              <select
                value={resultKind}
                onChange={(event) =>
                  setResultKind(event.target.value as typeof resultKind)
                }
              >
                <option value="win">一方获胜</option>
                <option value="draw">平局</option>
              </select>
            </Field>
            {resultKind === "win" && (
              <Field label="胜方">
                <select
                  value={winner}
                  onChange={(event) =>
                    setWinner(event.target.value as PlayerId)
                  }
                >
                  <option value="A">A</option>
                  <option value="B">B</option>
                </select>
              </Field>
            )}
            <Field label="结果依据">
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
              />
            </Field>
            <div className="actions">
              <Button
                disabled={!enabled || busy || !reason.trim()}
                onClick={() =>
                  void run(() => ({
                    kind: "report_result",
                    result:
                      resultKind === "win"
                        ? { kind: "win", winner, reason }
                        : { kind: "draw", reason },
                  }))
                }
              >
                报告并请对方确认
              </Button>
              <Button
                kind="danger text"
                disabled={!canConcede || busy}
                onClick={() => setConcede(true)}
              >
                认输
              </Button>
            </div>
          </>
        )}
        {tab === "advanced" && (
          <>
            <JsonEditor
              label="高级原子命令"
              value={raw}
              onChange={setRaw}
              rows={14}
            />
            <Button
              disabled={!enabled || busy}
              onClick={() => void run(() => JSON.parse(raw) as GameCommand)}
            >
              提交此命令
            </Button>
          </>
        )}
      </div>
      {concede && (
        <ConfirmAction
          title="确认认输"
          description={<p>认输会立即正式结束本局。确认以当前席位认输？</p>}
          confirmLabel="确认认输并结束本局"
          close={() => setConcede(false)}
          onConfirm={async () => {
            await execute({ kind: "concede" });
          }}
        />
      )}
    </aside>
  );
}
