import { createHash } from 'node:crypto';
import { projectTable, resolveSelection } from '../../../packages/game-core/src/index.ts';
import type { GameState, PlayerId, Position, Selection } from '../../../packages/protocol/src/index.ts';
import type { MatchRecord } from './match.ts';

interface Moment { turn: number; revision: number; eventId: string }
export interface InPlayFact {
  position: Position;
  lineageRef: string;
  firstInPlay: Moment | null;
  /** 宝可梦叠牌增加的记录时点，不是规则合法性裁定。 */
  lastEvolution: Moment | null;
  lastStackChange: Moment | null;
}
const moment = (row: MatchRecord): Moment => ({ turn: row.state.flow.turnNumber, revision: row.state.revision, eventId: row.event?.A.id ?? `initial:${row.state.id}` });
function location(state: GameState, groupId: string) {
  for (const zone of Object.values(state.zones)) {
    const index = zone.contents.items.findIndex(item => item?.kind === 'group' && item.id === groupId);
    if (index >= 0) return { zone, index };
  }
  return null;
}
function hiddenShuffle(row: MatchRecord, groupId: string, viewer: PlayerId): boolean {
  if (row.request?.command.kind !== 'shuffle') return false;
  const selection = (row.request.command as { selection: Selection }).selection;
  if (!resolveSelection(row.state, selection).some(item => item.kind === 'group' && item.id === groupId)) return false;
  const at = location(row.state, groupId);
  if (!at) return true;
  const item = projectTable(row.state, viewer).zones.find(zone => zone.id === at.zone.id)!.items[at.index];
  return item?.kind !== 'group' || item.stack.at(-1)?.kind !== 'card';
}

/** 从有效分支提取公开场上事实；不暴露持久卡牌ID，不把私有区身份穿过洗牌关联起来。 */
export function publicInPlayFacts(records: readonly MatchRecord[], state: GameState, revoked: Record<string, string>, viewer: PlayerId): InPlayFact[] {
  const view = projectTable(state, viewer), other = projectTable(state, viewer === 'A' ? 'B' : 'A');
  // 处置前的交流快照可能仍带撤销分支状态；只有真实牌桌变更和恢复点参与身份时序。
  const tableChanges = new Set(['move', 'shuffle', 'create_group', 'remove_group', 'set_state', 'system_restore']);
  const effective = records.filter(row => row.kind === 'init' || row.event && !revoked[row.event.A.id] && tableChanges.has(row.request?.command.kind ?? ''));
  const facts: InPlayFact[] = [];
  for (const zone of view.zones.filter(zone => zone.kind === 'active' || zone.kind === 'bench')) {
    for (const [index, item] of zone.items.entries()) {
      const counterpart = other.zones.find(z => z.id === zone.id)!.items[index];
      if (item?.kind !== 'group' || item.stack.at(-1)?.kind !== 'card' || counterpart?.kind !== 'group' || counterpart.stack.at(-1)?.kind !== 'card') continue;
      const raw = state.zones[zone.id]!.contents.items[index];
      if (raw?.kind !== 'group') continue;
      const group = state.groups[raw.id]!, baseId = group.stack[0];
      if (!baseId) continue;
      const history: MatchRecord[] = []; let uncertainBoundary: MatchRecord | null = null;
      for (let n = effective.length - 1; n >= 0; n--) {
        const row = effective[n]!, old = row.state.groups[raw.id], at = location(row.state, raw.id);
        if (!old || old.stack[0] !== baseId || !at) break;
        if (hiddenShuffle(row, raw.id, viewer)) { uncertainBoundary = row; break; }
        if (at.zone.kind === 'staging') continue;
        if (at.zone.kind !== 'active' && at.zone.kind !== 'bench') break;
        history.push(row);
      }
      history.reverse();
      const first = history[0];
      if (!first) continue;
      let lastEvolution: Moment | null = null, lastStackChange: Moment | null = null;
      for (let n = 1; n < history.length; n++) {
        const before = history[n - 1]!.state.groups[raw.id]!.stack, after = history[n]!.state.groups[raw.id]!.stack;
        if (before.join('|') === after.join('|')) continue;
        lastStackChange = moment(history[n]!);
        const top = after.at(-1), definition = top ? history[n]!.state.definitions[history[n]!.state.cards[top]!.definitionId] : null;
        if (after.length > before.length && definition?.kind === 'pokemon') lastEvolution = lastStackChange;
      }
      const anchor = uncertainBoundary?.event?.A.id ?? first.event?.A.id ?? String(first.sequence);
      facts.push({ position: { zoneId: zone.id, index }, lineageRef: 'p_' + createHash('sha256').update(JSON.stringify([state.id, raw.id, baseId, anchor])).digest('hex').slice(0, 20), firstInPlay: uncertainBoundary ? null : moment(first), lastEvolution, lastStackChange });
    }
  }
  return facts;
}
