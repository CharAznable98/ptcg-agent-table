import type { CardData, GameCommand, PlayerId } from '../../../packages/protocol/src/index.ts';
import type { MatchRuntime } from './match.ts';

/** 明示需玩家主动宣告的每回合特性不属于自动开局处理。 */
export function turnStartTexts(card: CardData): string[] {
  return [card.rulesText, ...('text' in card ? [card.text] : []), ...(card.kind === 'pokemon' ? card.abilities.filter(ability => !/^自己的回合时[，,]?可以使用1次[。．]/u.test(ability.text)).map(ability => ability.text) : [])].filter((value): value is string => Boolean(value));
}

/** 按有效历史定位回合边界；恢复前已撤销的抽牌不算完成。 */
export function humanTurnStart(match: MatchRuntime, playerId: PlayerId) {
  const flow = match.state.flow;
  if (flow.phase !== 'turn' || flow.operator !== playerId || flow.turnOwner !== playerId || flow.choice || flow.handoffReturnTo || match.meta.tasks.length || match.meta.dispute && match.meta.dispute.status !== 'closed') return null;
  const history = match.records.filter(record => record.kind === 'init' || record.event && !match.meta.revoked[record.event.A.id]);
  let boundary = 0;
  for (let index = history.length - 1; index > 0; index--) {
    const next = history[index]!.state.flow, before = history[index - 1]!.state.flow;
    if (next.phase === 'turn' && next.turnOwner === playerId && next.turnNumber === flow.turnNumber && (before.phase !== 'turn' || before.turnOwner !== playerId || before.turnNumber !== next.turnNumber)) { boundary = index; break; }
  }
  const records = history.slice(boundary);
  const drew = records.some(record => {
    const command = record.request?.command as GameCommand | undefined;
    if (command?.kind !== 'move') return false;
    const range = command.source.range;
    const topOne = range.mode === 'range' ? range.start === 0 && range.count === 1 : range.mode === 'indices' && range.indices.length === 1 && range.indices[0] === 0;
    return command.source.container.kind === 'zone' && command.source.container.zoneId === `${playerId}:deck` && topOne
      && command.destination.container.kind === 'zone' && ['hand', 'staging'].some(kind => command.destination.container.kind === 'zone' && command.destination.container.zoneId === `${playerId}:${kind}`);
  });
  const restored = records.findLast(record => ['debug_restore', 'system_restore'].includes(record.request?.command.kind ?? ''))?.event?.A.id ?? '';
  const cards: CardData[] = [];
  for (const zone of Object.values(match.state.zones)) if (!['hand', 'deck', 'prizes', 'discard', 'lost', 'staging'].includes(zone.kind)) {
    for (const ref of zone.contents.items) {
      if (!ref) continue;
      const ids = ref.kind === 'group' ? [...match.state.groups[ref.id]!.stack.slice(-1), ...match.state.groups[ref.id]!.attached] : [ref.id];
      for (const id of ids) { const card = match.state.definitions[match.state.cards[id]!.definitionId]!; if (turnStartTexts(card).length) cards.push(card); }
    }
  }
  const top = match.state.zones[`${playerId}:deck`]!.contents.items[0];
  const topCard = top?.kind === 'card' ? match.state.definitions[match.state.cards[top.id]!.definitionId] : undefined;
  const markerState = [match.state.playerMarkers[playerId], ...Object.values(match.state.groups).map(group => group.state.markers)];
  // 只做无效果路径的保守优化，不解析卡文决定效果。任何相关文本或持续标记交给代理。
  const requiresReview = Boolean(cards.length || topCard && turnStartTexts(topCard).length || markerState.some(markers => Object.keys(markers).some(name => name !== 'enteredTurn')));
  return { key: `${history[boundary]!.event?.A.id ?? `init:${flow.turnNumber}`}:${restored}`, drew, requiresReview, cards };
}
