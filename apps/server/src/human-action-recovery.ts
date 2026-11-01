import type { GameCommand, PlayerId } from '../../../packages/protocol/src/index.ts';
import type { MatchRecord, MatchRuntime } from './match.ts';

export interface HumanActionRecoveryPoint {
  eventId: string;
  label: string;
  sequence: number;
  /** 恢复目标事件之前的牌桌版本。 */
  revision: number;
}

const delegatedCommands = new Set(['move', 'shuffle', 'set_state', 'look', 'show', 'random', 'create_group', 'remove_group', 'declare', 'handoff']);

/** 只给出原行动及临时交权结算内的恢复点，不推断卡文或游戏抉择。 */
export function humanActionRecoveryPoints(match: MatchRuntime, playerId: PlayerId, actionId: string): HumanActionRecoveryPoint[] {
  if (match.state.flow.operator !== playerId || match.state.flow.phase === 'finished' || match.meta.tasks.length
    || match.meta.dispute && match.meta.dispute.status !== 'closed'
    || !match.state.players.some(player => player.id === playerId && player.kind === 'human')) return [];
  const owned = (record: MatchRecord) => record.event?.A.action?.id === actionId && record.actor?.kind === 'player' && record.actor.playerId === playerId;
  const effective = match.records.flatMap((record, index) => record.event && !match.meta.revoked[record.event.A.id] ? [{ record, index }] : []);
  const first = effective.findIndex(({ record }) => owned(record));
  if (first < 0) return [];
  const chain = effective.slice(first);
  for (const { record, index } of chain) {
    if (owned(record)) continue;
    const before = match.records[index - 1];
    const flow = before?.state.flow, command = record.request?.command as GameCommand | undefined;
    if (!before || record.actor?.kind !== 'player' || record.actor.playerId === playerId
      || flow?.operator !== record.actor.playerId || flow.handoffReturnTo !== playerId
      || flow.choice?.kind !== 'handoff' || flow.choice.playerId !== record.actor.playerId
      || !command || !delegatedCommands.has(command.kind)
      || command.kind === 'handoff' && (!command.returning || command.to !== playerId)) return [];
  }
  return chain.flatMap(({ record, index }) => {
    const before = match.records[index - 1];
    if (!owned(record) || !before || record.request?.command.kind === 'system_restore'
      || before.state.flow.operator !== playerId || ['setup', 'finished', 'result_pending'].includes(before.state.flow.phase)
      || before.meta.tasks.length || before.meta.dispute && before.meta.dispute.status !== 'closed') return [];
    return [{ eventId: record.event!.A.id, label: record.event!.A.label, sequence: record.sequence, revision: before.state.revision }];
  });
}
