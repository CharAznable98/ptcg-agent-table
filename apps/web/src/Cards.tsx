import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type {
  CardData,
  GameCommand,
  GroupView,
  ObjectView,
  Position,
  ZoneView,
} from "../../../packages/protocol/src/index.ts";
import { Button } from "./ui.tsx";
import { CardBack } from "./CardBack.tsx";
import { useDirectTable } from "./direct-manipulation.tsx";
import {
  conditionNames,
  positionKey,
  positionLabel,
  zoneNames,
} from "./table-utils.ts";

// 关闭详情仍恢复键盘焦点，但这次程序触发的 focus 不代表再次请求预览。
const inspectorFocusRestores = new WeakSet<HTMLElement>();
export function restoreInspectorFocus(target: HTMLElement) {
  inspectorFocusRestores.add(target);
  try {
    target.focus();
  } finally {
    inspectorFocusRestores.delete(target);
  }
}

function cardCategory(card: CardData): string {
  if (card.kind === "pokemon")
    return `${card.stage} · ${card.types.join(" / ")}`;
  if (card.kind === "energy")
    return card.subtype === "basic" ? `${card.energyType}能量` : "特殊能量";
  return (
    {
      item: "物品",
      tool: "宝可梦道具",
      supporter: "支援者",
      stadium: "竞技场",
    }[card.subtype] ?? "训练家"
  );
}
function objectName(object: ObjectView): string {
  if (object.kind === "card") return object.card.name;
  if (object.kind === "hidden") return "隐藏卡牌";
  const top = object.stack.at(-1);
  return top?.kind === "card" ? top.card.name : "卡牌组";
}
/** 总览只显示识别信息；卡文在详情中阅读，避免依赖微小字号。 */
export function CardFace({
  card,
  compact = false,
}: {
  card: CardData;
  compact?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [card.imageUrl]);
  const hasImage = Boolean(card.imageUrl && !imageFailed);
  return (
    <div
      className={`card-face type-${card.kind} ${compact ? "compact" : ""} ${hasImage ? "has-image" : "text-card"}`}
    >
      <div className="card-title">
        <strong>{card.name}</strong>
        {card.kind === "pokemon" && (
          <span>
            HP <b>{card.hp}</b>
          </span>
        )}
      </div>
      {hasImage && (
        <img
          className="card-image"
          src={card.imageUrl}
          alt={card.name}
          onError={() => setImageFailed(true)}
        />
      )}
      {(!hasImage || !compact) && (
        <div className="card-summary">
          <span>{cardCategory(card)}</span>
          {card.kind === "pokemon" && card.evolvesFrom && (
            <span>由 {card.evolvesFrom} 进化</span>
          )}
        </div>
      )}
      {!compact && (
        <>
          <div className="card-text">
            {card.kind === "pokemon" ? (
              <>
                {card.abilities.map((ability, index) => (
                  <div key={`ability-${index}`}>
                    <b className="ability">特性 · {ability.name}</b>
                    <p>{ability.text}</p>
                    {!!ability.tags?.length && (
                      <small>{ability.tags.join("、")}</small>
                    )}
                  </div>
                ))}
                {card.attacks.map((attack, index) => (
                  <div key={`attack-${index}`}>
                    <div className="attack">
                      <b>
                        {attack.energyCost
                          .map((item) => `${item.type}×${item.count}`)
                          .join(" ")}{" "}
                        {attack.name}
                      </b>
                      <strong>{attack.damageText}</strong>
                    </div>
                    <p>{attack.text}</p>
                    {!!attack.tags?.length && (
                      <small>{attack.tags.join("、")}</small>
                    )}
                  </div>
                ))}
              </>
            ) : (
              card.text && <p>{card.text}</p>
            )}
            {card.rulesText && <p className="rules-text">{card.rulesText}</p>}
            {!!card.tags?.length && (
              <p className="card-tags">{card.tags.join("、")}</p>
            )}
          </div>
          {card.kind === "pokemon" && (
            <div className="card-foot">
              <span>
                弱点{" "}
                {card.weaknesses
                  .map((item) => `${item.type}${item.modifier}`)
                  .join(" ") || "无"}
              </span>
              <span>
                抗性{" "}
                {card.resistances
                  .map((item) => `${item.type}${item.modifier}`)
                  .join(" ") || "无"}
              </span>
              <span>撤退 {card.retreatCost}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
function AttachedSummary({ object }: { object: GroupView }) {
  const direct = useDirectTable();
  if (direct?.manual) return object.attached.length ? (
    <div className="attached-summary manual-attached" aria-label="附着卡">
      {object.attached.map((member, index) => (
        <button key={index} type="button" disabled={!direct.enabled} title={direct.canPick(member) ? "拖动调整附着卡" : undefined}
          {...direct.sourceProps({ position: member.position, kind: "card" }, direct.canPick(member))}>
          {member.kind === "card" ? member.card.name : "隐藏卡牌"}
        </button>
      ))}
    </div>
  ) : null;
  const labels = new Map<string, number>();
  for (const member of object.attached) {
    const name =
      member.kind === "card"
        ? member.card.kind === "energy" && member.card.subtype === "basic"
          ? `${member.card.energyType}能量`
          : member.card.name
        : "隐藏卡牌";
    labels.set(name, (labels.get(name) ?? 0) + 1);
  }
  return labels.size ? (
    <div className="attached-summary" aria-label="附着卡">
      {[...labels].map(([name, count]) => (
        <span key={name} title={`${name} ${count} 张`}>
          <span className="attached-name">{name}</span><b className="attached-count">×{count}</b>
        </span>
      ))}
    </div>
  ) : null;
}
function ManualStateTools({ object, busy, onChange }: { object: GroupView; busy: boolean; onChange: (field: Extract<GameCommand, { kind: "set_state" }>["field"]) => void }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const lastControl = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<HTMLElement | null>(null);
  const wasBusy = useRef(busy);
  useEffect(() => { setTarget(document.querySelector<HTMLElement>(".table-column")); }, []);
  useEffect(() => {
    const followFocus = (event: FocusEvent) => {
      const focused = event.target;
      if (!(focused instanceof HTMLElement)) return;
      if (toolbarRef.current?.contains(focused)) lastControl.current = focused;
      else if (focused !== document.body && focused !== document.documentElement) {
        lastControl.current = null;
        pendingFocus.current = null;
      }
    };
    document.addEventListener("focusin", followFocus);
    return () => document.removeEventListener("focusin", followFocus);
  }, []);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    const lostFocus = focused === document.body || focused === document.documentElement;
    if (busy && !wasBusy.current && (lostFocus || toolbarRef.current?.contains(focused))) {
      pendingFocus.current = lastControl.current;
    } else if (!busy && wasBusy.current) {
      const control = pendingFocus.current;
      if (lostFocus && control?.isConnected) {
        const available = !control.matches(":disabled") ? control : toolbarRef.current?.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled)");
        available?.focus({ preventScroll: true });
      }
      pendingFocus.current = null;
    }
    wasBusy.current = busy;
  }, [busy]);
  const name = objectName(object);
  const toolbar = <section ref={toolbarRef} className="manual-state-toolbar" aria-busy={busy || undefined} aria-label={`${positionLabel(object.position)}${name}状态调整`}>
    <span className="manual-target-name" title={`${positionLabel(object.position)}${name}`}>{name}</span>
    <span className="manual-target-damage">伤害 <b>{object.state.damageCounters * 10}</b></span>
    <div className="manual-state-buttons">
      <button type="button" aria-label={`${name}减少10伤害`} disabled={busy || !object.state.damageCounters}
        onClick={() => !busy && onChange({ key: "damageCounters", value: Math.max(0, object.state.damageCounters - 1) })}>−10</button>
      <button type="button" aria-label={`${name}增加10伤害`} disabled={busy}
        onClick={() => !busy && onChange({ key: "damageCounters", value: object.state.damageCounters + 1 })}>+10</button>
      <select aria-label={`${name}调整特殊状态`} disabled={busy} value="" onChange={(event) => {
        if (busy) return;
        const condition = event.target.value;
        onChange({ key: "specialConditions", value: condition === "clear" ? [] : object.state.specialConditions.includes(condition) ? object.state.specialConditions.filter((value) => value !== condition) as ("poisoned" | "burned" | "asleep" | "paralyzed" | "confused")[] : [...object.state.specialConditions, condition] as ("poisoned" | "burned" | "asleep" | "paralyzed" | "confused")[] });
      }}>
        <option value="" disabled>特殊状态</option>
        {Object.entries(conditionNames).map(([value, label]) => <option key={value} value={value}>{object.state.specialConditions.includes(value) ? "清除" : "设置"}{label}</option>)}
        <option value="clear">清除全部</option>
      </select>
    </div>
  </section>;
  return target ? createPortal(toolbar, target) : null;
}
/** 焦点在信息区时只滚动额外信息，卡名、HP 和伤害始终留在固定区域。 */
function scrollGroupExtra(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget) return;
  const panel = event.currentTarget;
  const page = Math.max(20, panel.clientHeight);
  let next: number;
  switch (event.key) {
    case "Home": next = 0; break;
    case "End": next = panel.scrollHeight - panel.clientHeight; break;
    case "ArrowUp": next = panel.scrollTop - 20; break;
    case "ArrowDown": next = panel.scrollTop + 20; break;
    case "PageUp": next = panel.scrollTop - page; break;
    case "PageDown": next = panel.scrollTop + page; break;
    default: return;
  }
  event.preventDefault();
  event.stopPropagation();
  panel.scrollTop = Math.max(0, Math.min(next, panel.scrollHeight - panel.clientHeight));
}
export function ObjectCard({
  object,
  selected,
  onSelect,
  onInspect,
  onPreview,
  highlighted = [],
  interactive = true,
  miniature = false,
  showBack = false,
}: {
  object: ObjectView;
  selected: Position[];
  onSelect: (position: Position) => void;
  onInspect: (object: ObjectView) => void;
  onPreview?: (object: ObjectView | null) => void;
  highlighted?: Position[];
  interactive?: boolean;
  miniature?: boolean;
  showBack?: boolean;
}) {
  const direct = useDirectTable();
  const chosen = selected.some(
    (item) => positionKey(item) === positionKey(object.position),
  );
  const located = highlighted.some(
    (item) =>
      item.zoneId === object.position.zoneId &&
      item.index === object.position.index &&
      (!object.position.member ||
        positionKey(item) === positionKey(object.position)),
  );
  const top = object.kind === "group" ? object.stack.at(-1) : object;
  const name = objectName(object);
  const canDrag = direct?.canPick(object) ?? false;
  const ghost = direct?.isGhost(object.position) ?? false;
  const directTarget = direct?.targetProps(object.position) ?? {};
  return (
    <div
      className={`${object.kind === "group" ? "group-object" : "single-object"} ${chosen ? "selected" : ""} ${located ? "is-located" : ""} ${miniature ? "miniature" : ""} ${canDrag ? "can-manipulate" : ""} ${ghost ? "setup-ghost" : ""}`}
      data-position-key={ghost ? undefined : positionKey(object.position)}
      data-displayed-position={ghost ? positionKey(object.position) : undefined}
      data-draft-source={ghost ? positionKey(direct!.sourcePosition(object.position)) : undefined}
      {...directTarget}
    >
      <button
        className="object-button"
        aria-label={`${interactive && !direct ? "选择" : "查看"}${positionLabel(object.position)}${object.kind === "group" ? "卡牌组" : name}`}
        aria-pressed={interactive && !direct ? chosen : undefined}
        title={canDrag ? "拖动操牌；空格提起，移至目标后回车放下" : undefined}
        {...(direct?.sourceProps({ position: object.position, kind: "card" }, canDrag) ?? {})}
        onMouseEnter={() => !direct?.dragging && onPreview?.(object)}
        onMouseLeave={() => onPreview?.(null)}
        onFocusCapture={(event) => {
          if (!direct?.dragging && !inspectorFocusRestores.has(event.target as HTMLElement))
            onPreview?.(object);
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            onPreview?.(null);
        }}
        onClick={() => {
          if (direct?.active) { direct.drop(object.position); return; }
          if (direct?.manual && direct.enabled) { onSelect(object.position); return; }
          interactive && !direct ? onSelect(object.position) : onInspect(object);
        }}
      >
        {!showBack && top?.kind === "card" ? (
          <CardFace card={top.card} compact />
        ) : (
          <CardBack label={object.kind === "group" ? "卡牌组" : "隐藏"} />
        )}
        {object.kind === "group" && object.stack.length > 1 && <span className="group-stack-count" aria-label={`叠牌 ${object.stack.length}`}>叠牌 {object.stack.length}</span>}
      </button>
      {object.kind !== "group" && <div className="object-card-title" title={name}>
        {name}
      </div>}
      {object.kind === "group" && (
        <>
          <div className="group-info" role="group" aria-label={`${name}信息`}>
          <div className="group-required">
          <div className="object-card-title" title={name}>{name}</div>
          <div className="group-badges">
            {top?.kind === "card" && top.card.kind === "pokemon" && (
              <span>HP {top.card.hp}</span>
            )}
            {!ghost && <b
              className={`damage ${object.state.damageCounters ? "has-damage" : ""}`}
            >
              伤害 {object.state.damageCounters * 10}
            </b>}
          </div>
          </div>
          {(object.state.specialConditions.length > 0 || object.attached.length > 0) && <div className="group-extra" role="group" aria-label={`${name}状态与附着`} tabIndex={0} title="状态与附着，可滚动查看" onKeyDown={scrollGroupExtra}>
          {!!object.state.specialConditions.length && (
            <div className="conditions">
              {object.state.specialConditions.map((condition) => (
                <span key={condition}>
                  {conditionNames[condition] ?? condition}
                </span>
              ))}
            </div>
          )}
          <AttachedSummary object={object} />
          </div>}
          </div>
          {direct?.manual && direct.onState && chosen && <ManualStateTools object={object} busy={!direct.enabled} onChange={(field) => direct.onState?.(object.position, field)} />}
        </>
      )}
      {interactive && !direct && object.kind !== "hidden" && (
        <button className="inspect" onClick={() => onInspect(object)}>
          {object.kind === "group" ? "展开卡牌组" : "查看牌面"}
        </button>
      )}
    </div>
  );
}
export function Zone({
  zone,
  selected,
  onSelect,
  onInspect,
  onDestination,
  onPreview,
  highlighted = [],
  interactive = true,
}: {
  zone: ZoneView;
  selected: Position[];
  onSelect: (position: Position) => void;
  onInspect: (object: ObjectView) => void;
  onDestination: (zoneId: string, index: number) => void;
  onPreview?: (object: ObjectView | null) => void;
  highlighted?: Position[];
  interactive?: boolean;
}) {
  const direct = useDirectTable();
  const pile = ["deck", "discard", "lost"].includes(zone.kind);
  const [expanded, setExpanded] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (expanded) popover.current?.focus();
  }, [expanded]);
  function closePile() {
    setExpanded(false);
    onPreview?.(null);
    expandButton.current?.focus();
  }
  const indexes = zone.items.map((_, index) => index);
  const shown = pile ? indexes.slice(0, 1) : indexes;
  const renderObject = (index: number, showBack = false) => {
    const item = zone.items[index];
    return item ? (
      <div className="zone-position" key={index}>
        <span className="position-number">{index + 1}</span>
        <ObjectCard
          object={item}
          selected={selected}
          onSelect={onSelect}
          onInspect={onInspect}
          onPreview={onPreview}
          highlighted={highlighted}
          interactive={interactive}
          showBack={showBack}
        />
      </div>
    ) : (
      <button
        key={index}
        className={`empty-slot ${highlighted.some((position) => position.zoneId === zone.id && position.index === index) ? "is-located" : ""}`}
        data-position-key={positionKey({ zoneId: zone.id, index })}
        {...(direct?.targetProps({ zoneId: zone.id, index }) ?? {})}
        aria-label={`${zoneNames[zone.kind]}第${index + 1}位${interactive ? "作为目标" : "空位"}`}
        onClick={() => direct?.active ? direct.drop({ zoneId: zone.id, index }) : !direct && interactive && onDestination(zone.id, index)}
        disabled={direct ? !direct.enabled : !interactive}
      >
        <span>{interactive ? "+" : "空"}</span>
        <small>{index + 1}</small>
      </button>
    );
  };
  return (
    <section
      className={`zone zone-${zone.kind} ${pile ? "pile" : ""} ${highlighted.some((position) => position.zoneId === zone.id) ? "is-located" : ""}`}
      aria-label={`${zone.playerId ?? ""}${zoneNames[zone.kind]}`}
      data-zone-id={zone.id}
      style={zone.kind === "bench" ? { "--bench-slots": Math.max(1, zone.items.length) } as CSSProperties : undefined}
      {...(direct?.targetProps({ zoneId: zone.id, index: zone.layout === "slots" ? Math.max(0, zone.items.findIndex((item) => !item)) : zone.items.length }) ?? {})}
    >
      <header>
        <h3>{zoneNames[zone.kind]}</h3>
        <span>
          {zone.items.filter(Boolean).length}
          {zone.layout === "slots" ? ` / ${zone.items.length}` : " 张"}
        </span>
        {pile && zone.items.length > 1 && (
          <button
            ref={expandButton}
            aria-expanded={expanded}
            onClick={() => (expanded ? closePile() : setExpanded(true))}
          >
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </header>
      <div className="zone-content">
        {shown.map((index) =>
          renderObject(index, zone.kind === "deck" || zone.kind === "prizes"),
        )}
        {!zone.items.length && !interactive && (
          <span className="zone-empty">空</span>
        )}
        {zone.layout === "sequence" && interactive && (
          <button
            className="empty-slot add-position"
            data-position-key={positionKey({
              zoneId: zone.id,
              index: zone.items.length,
            })}
            {...(direct?.targetProps({ zoneId: zone.id, index: zone.items.length }) ?? {})}
            onClick={() => direct?.active ? direct.drop({ zoneId: zone.id, index: zone.items.length }) : !direct && onDestination(zone.id, zone.items.length)}
            disabled={direct ? !direct.enabled : false}
            aria-label={`${zoneNames[zone.kind]}末尾作为目标`}
          >
            <span>+</span>
            <small>{zone.items.length ? "末尾" : "空区域"}</small>
          </button>
        )}
      </div>
      {expanded && (
        <div
          className="pile-popover"
          role="dialog"
          aria-label={`${zone.playerId ?? ""}${zoneNames[zone.kind]}内容`}
          aria-modal="false"
          ref={popover}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closePile();
            }
          }}
        >
          <header>
            <h3>{zoneNames[zone.kind]} · 从顶部开始</h3>
            <Button title="关闭区域内容" onClick={closePile}>
              关闭
            </Button>
          </header>
          <div className="pile-popover-content">
            {indexes.map((index) => renderObject(index))}
          </div>
        </div>
      )}
    </section>
  );
}
function Markers({
  values,
}: {
  values: Record<string, string | number | boolean>;
}) {
  return Object.keys(values).length ? (
    <dl className="card-markers">
      {Object.entries(values).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{String(value)}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}
export function ObjectInspector({
  object,
  close,
  selected,
  onSelect,
  pinned = true,
}: {
  object: ObjectView;
  close: () => void;
  selected: Position[];
  onSelect: (position: Position) => void;
  pinned?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [member, setMember] = useState<string | null>(null);
  const cards =
    object.kind === "group" ? [...object.stack, ...object.attached] : [];
  const focused =
    object.kind === "group"
      ? (cards.find((item) => positionKey(item.position) === member) ??
        object.stack.at(-1) ??
        object.attached[0])
      : object;
  useEffect(() => {
    if (!pinned) return;
    const previousFocus = document.activeElement;
    panel.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        restoreInspectorFocus(previousFocus);
    };
  }, [pinned]);
  return (
    <div
      className={`card-inspector ${pinned ? "is-pinned" : "is-preview"}`}
      role={pinned ? "dialog" : "tooltip"}
      aria-label="卡牌详情"
      aria-modal={pinned ? "false" : undefined}
      tabIndex={pinned ? -1 : undefined}
      ref={panel}
      style={!pinned ? { pointerEvents: "none" } : undefined}
    >
      <header>
        <h2>{objectName(object)}</h2>
        {pinned && (
          <Button title="关闭卡牌详情" onClick={close}>
            关闭
          </Button>
        )}
      </header>
      <div className="inspector-scroll">
        {object.kind === "group" && (
          <>
            <div className="inspector-state">
              <b>累计伤害 {object.state.damageCounters * 10}</b>
              <span>
                {object.state.specialConditions
                  .map((item) => conditionNames[item] ?? item)
                  .join("、") || "无特殊状态"}
              </span>
            </div>
            <Markers values={object.state.markers} />
            {pinned &&
              (["stack", "attached"] as const).map((relation) => (
                <section className="inspector-members" key={relation}>
                  <h3>
                    {relation === "stack" ? "叠牌（由底到顶）" : "附着卡"}{" "}
                    {object[relation].length}
                  </h3>
                  <div className="inspector-member-list">
                    {object[relation].map((card, index) => (
                      <button
                        key={positionKey(card.position)}
                        className={
                          selected.some(
                            (item) =>
                              positionKey(item) === positionKey(card.position),
                          )
                            ? "selected"
                            : ""
                        }
                        aria-label={`查看并选择${positionLabel(card.position)}${objectName(card)}`}
                        aria-pressed={focused === card}
                        onClick={() => {
                          setMember(positionKey(card.position));
                          onSelect(card.position);
                        }}
                      >
                        <span>{index + 1}</span>
                        <b>{objectName(card)}</b>
                      </button>
                    ))}
                    {!object[relation].length && (
                      <span className="muted">无</span>
                    )}
                  </div>
                </section>
              ))}
            {!pinned && <AttachedSummary object={object} />}
          </>
        )}
        {focused?.kind === "card" ? (
          <>
            <div className="large-card">
              <CardFace
                key={positionKey(focused.position)}
                card={focused.card}
              />
            </div>
            <Markers values={focused.markers} />
          </>
        ) : (
          <p>{focused ? "当前视角不可见。" : "空卡牌组"}</p>
        )}
      </div>
    </div>
  );
}
