import { useEffect, useRef, useState } from "react";
import type {
  CardData,
  GroupView,
  ObjectView,
  Position,
  ZoneView,
} from "../../../packages/protocol/src/index.ts";
import { Button } from "./ui.tsx";
import { CardBack } from "./CardBack.tsx";
import {
  conditionNames,
  positionKey,
  positionLabel,
  zoneNames,
} from "./table-utils.ts";

// 关闭详情仍恢复键盘焦点，但这次程序触发的 focus 不代表再次请求预览。
const inspectorFocusRestores = new WeakSet<HTMLElement>();
function restoreInspectorFocus(target: HTMLElement) {
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
          {name} ×{count}
        </span>
      ))}
    </div>
  ) : null;
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
  return (
    <div
      className={`${object.kind === "group" ? "group-object" : "single-object"} ${chosen ? "selected" : ""} ${located ? "is-located" : ""} ${miniature ? "miniature" : ""}`}
      data-position-key={positionKey(object.position)}
      onMouseEnter={() => onPreview?.(object)}
      onMouseLeave={() => onPreview?.(null)}
      onFocusCapture={(event) => {
        if (!inspectorFocusRestores.has(event.target as HTMLElement))
          onPreview?.(object);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          onPreview?.(null);
      }}
    >
      <button
        className="object-button"
        aria-label={`${interactive ? "选择" : "查看"}${positionLabel(object.position)}${object.kind === "group" ? "卡牌组" : name}`}
        aria-pressed={interactive ? chosen : undefined}
        onClick={() =>
          interactive ? onSelect(object.position) : onInspect(object)
        }
      >
        {!showBack && top?.kind === "card" ? (
          <CardFace card={top.card} compact />
        ) : (
          <CardBack label={object.kind === "group" ? "卡牌组" : "隐藏"} />
        )}
      </button>
      <div className="object-card-title" title={name}>
        {name}
      </div>
      {object.kind === "group" && (
        <>
          <div className="group-badges">
            {top?.kind === "card" && top.card.kind === "pokemon" && (
              <span>HP {top.card.hp}</span>
            )}
            <b
              className={`damage ${object.state.damageCounters ? "has-damage" : ""}`}
            >
              伤害 {object.state.damageCounters * 10}
            </b>
            {object.stack.length > 1 && <span>叠牌 {object.stack.length}</span>}
          </div>
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
        </>
      )}
      {interactive && object.kind !== "hidden" && (
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
        aria-label={`${zoneNames[zone.kind]}第${index + 1}位${interactive ? "作为目标" : "空位"}`}
        onClick={() => interactive && onDestination(zone.id, index)}
        disabled={!interactive}
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
            onClick={() => onDestination(zone.id, zone.items.length)}
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
