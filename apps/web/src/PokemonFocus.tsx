import { useEffect, useRef, useState } from "react";
import type { CardData, GroupView, HumanActionIntent, MatchView, ObjectView, Position } from "../../../packages/protocol/src/index.ts";
import { CardFace, restoreInspectorFocus } from "./Cards.tsx";
import { Button } from "./ui.tsx";
import { conditionNames, positionKey, positionLabel } from "./table-utils.ts";
import "./pokemon-focus.css";

type Pokemon = Extract<CardData, { kind: "pokemon" }>;
export function pokemonOf(object: ObjectView | null): Pokemon | null {
  const top = object?.kind === "group" ? object.stack.at(-1) : object;
  return top?.kind === "card" && top.card.kind === "pokemon" ? top.card : null;
}
export function pokemonIntent(view: MatchView, source: Position, kind: "attack" | "ability", index: number): HumanActionIntent | null {
  const zone = view.zones.find(zone => zone.id === source.zoneId);
  const pokemon = pokemonOf(zone?.items[source.index] ?? null);
  if (zone?.playerId !== view.viewer || !pokemon) return null;
  if (kind === "ability") return pokemon.abilities[index] ? { kind, source, abilityIndex: index } : null;
  const target = view.zones.find(zone => zone.kind === "active" && zone.playerId !== view.viewer)?.items.find(item => item?.kind === "group")?.position;
  return zone.kind === "active" && pokemon.attacks[index] && target ? { kind, source, attackIndex: index, target } : null;
}
function Cost({ items }: { items: { type: string; count: number }[] }) {
  return <span className="pokemon-cost" aria-label={items.length ? items.map(item => `${item.type}能量 ${item.count}`).join("，") : "无能量要求"}>
    {items.length ? items.map((item, index) => <span key={index}>{item.type}{item.count > 1 ? ` ×${item.count}` : ""}</span>) : <span>无</span>}
  </span>;
}

/** 牌桌只保留卡牌和状态，选中宝可梦后才展开完整行动。 */
export function PokemonFocus({ object, view, enabled, onIntent, onInspectMember, close }: {
  object: GroupView; view: MatchView; enabled: boolean;
  onIntent: (intent: HumanActionIntent) => void;
  onInspectMember: (object: ObjectView) => void; close: () => void;
}) {
  const card = pokemonOf(object)!;
  const [retreating, setRetreating] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const zone = view.zones.find(zone => zone.id === object.position.zoneId);
  const own = zone?.playerId === view.viewer && view.players.some(player => player.id === view.viewer && player.kind === "human") && !view.replay;
  const active = zone?.kind === "active";
  const locked = !enabled || !own;
  const bench = view.zones.find(zone => zone.kind === "bench" && zone.playerId === view.viewer)?.items.filter((item): item is GroupView => item?.kind === "group") ?? [];
  useEffect(() => {
    const previous = document.activeElement;
    const element = panel.current;
    const root = panel.current?.closest(".table-column");
    const sourceKey = positionKey(object.position);
    (panel.current?.querySelector<HTMLElement>(".pokemon-action:not(:disabled)") ?? panel.current?.querySelector<HTMLElement>(".pokemon-focus-close"))?.focus({ preventScroll: true });
    return () => {
      const current = document.activeElement;
      if (current instanceof HTMLElement && current !== document.body && current.isConnected && !element?.contains(current) && !current.closest("[inert]")) return;
      const source = [...(root?.querySelectorAll<HTMLElement>("[data-position-key]") ?? [])].find(element => element.dataset.positionKey === sourceKey)?.querySelector<HTMLElement>(".object-button");
      const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected && !previous.matches(":disabled") ? previous : source;
      if (target) restoreInspectorFocus(target);
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (retreating) setRetreating(false); else closeRef.current();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [retreating]);
  useEffect(() => { if (locked) setRetreating(false); }, [locked]);
  function useAction(kind: "attack" | "ability", index: number) {
    if (locked) return;
    const intent = pokemonIntent(view, object.position, kind, index);
    if (intent) onIntent(intent);
  }
  const members = [...object.stack.slice(0, -1), ...object.attached];
  return <div className="pokemon-focus-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="pokemon-focus" role="dialog" aria-label={`${card.name}的卡牌与行动`} aria-modal="false" ref={panel}>
      <header><div><h2>{card.name}</h2><span>{positionLabel(object.position)}</span></div><button type="button" className="button pokemon-focus-close" aria-label="关闭宝可梦" onClick={close}>关闭</button></header>
      <div className="pokemon-focus-body">
        <div className="pokemon-portrait">
          <CardFace card={card} compact />
          <div className="pokemon-vitals"><b>HP {card.hp}</b><span>伤害 {object.state.damageCounters * 10}</span></div>
          {!!object.state.specialConditions.length && <div className="pokemon-conditions">{object.state.specialConditions.map(condition => <span key={condition}>{conditionNames[condition] ?? condition}</span>)}</div>}
          <div className="pokemon-traits"><span>弱点 {card.weaknesses.map(item => `${item.type}${item.modifier}`).join(" ") || "无"}</span><span>抗性 {card.resistances.map(item => `${item.type}${item.modifier}`).join(" ") || "无"}</span><span>撤退 {card.retreatCost}</span></div>
        </div>
        <div className="pokemon-action-list">
          {retreating ? <section className="pokemon-retreat-targets" aria-label="选择换上的宝可梦">
            <header><h3>选择换上的宝可梦</h3><Button onClick={() => setRetreating(false)}>返回</Button></header>
            {bench.map(target => <button type="button" className="pokemon-retreat-target" key={positionKey(target.position)} onClick={() => {
              if (!locked) onIntent({ kind: "retreat", source: object.position, target: target.position });
            }}><span>{pokemonOf(target)?.name ?? "宝可梦"}</span><small>{positionLabel(target.position)}</small></button>)}
          </section> : <>
            {card.abilities.map((ability, index) => {
              const content = <><div className="pokemon-action-heading"><span className="pokemon-action-kind">特性</span><strong>{ability.name}</strong></div><p>{ability.text}</p></>;
              return own ? <button type="button" className="pokemon-action ability-action" disabled={locked} key={`ability-${index}`} aria-label={`使用特性${ability.name}`} onClick={() => useAction("ability", index)}>{content}</button>
                : <section className="pokemon-action is-readonly" key={`ability-${index}`}>{content}</section>;
            })}
            {card.attacks.map((attack, index) => {
              const content = <><div className="pokemon-action-heading"><Cost items={attack.energyCost} /><strong>{attack.name}</strong><b className="pokemon-action-damage">{attack.damageText}</b></div>{attack.text && <p>{attack.text}</p>}</>;
              return own && active ? <button type="button" className="pokemon-action attack-action" disabled={locked || !pokemonIntent(view, object.position, "attack", index)} key={`attack-${index}`} aria-label={`使用招式${attack.name}`} onClick={() => useAction("attack", index)}>{content}</button>
                : <section className="pokemon-action is-readonly" key={`attack-${index}`}>{content}</section>;
            })}
            {own && active && <button type="button" className="pokemon-retreat" disabled={locked || !bench.length} onClick={() => setRetreating(true)}><Cost items={card.retreatCost ? [{ type: "无色", count: card.retreatCost }] : []} /><span>撤退</span></button>}
            {card.rulesText && <p className="pokemon-rules">{card.rulesText}</p>}
            {!!members.length && <details className="pokemon-members"><summary>叠牌与附着 {members.length}</summary><div>{members.map(member => <button type="button" key={positionKey(member.position)} onClick={() => onInspectMember(member)}>{member.kind === "card" ? member.card.name : "隐藏卡牌"}<small>{member.position.member?.relation === "attached" ? "附着" : "叠牌"}</small></button>)}</div></details>}
          </>}
        </div>
      </div>
    </section>
  </div>;
}
