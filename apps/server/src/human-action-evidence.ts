import type { ModelItem } from '../../../packages/agent/src/index.ts';
import type { GameCommand, GameState } from '../../../packages/protocol/src/index.ts';
import type { MatchRecord, MatchRuntime } from './match.ts';
import { canonical } from './storage.ts';

export interface CommittedHumanStep {
  command: GameCommand;
  choiceIds: string[];
  effectText?: string;
  effectStep?: string;
  record: MatchRecord;
  before: GameState;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try { return object(JSON.parse(value)); } catch { return null; }
}

/** 回执只负责关联；执行事实、命令及前态均来自本局有效提交记录。 */
export function committedHumanSteps(match: Pick<MatchRuntime, 'records' | 'meta'>, actionId: string, messages: readonly ModelItem[]): CommittedHumanStep[] {
  const outputs = new Map<string, Record<string, unknown>[]>();
  for (const message of messages) {
    if (message.type !== 'function_call_output' || typeof message.call_id !== 'string') continue;
    const output = parse(message.output);
    if (output) outputs.set(message.call_id, [...(outputs.get(message.call_id) ?? []), output]);
  }
  const commits = new Map<string, { record: MatchRecord; before: GameState; index: number } | null>();
  match.records.forEach((record, index) => {
    const event = record.event?.A, before = match.records[index - 1]?.state;
    if (record.kind !== 'commit' || !before || !event || event.action?.id !== actionId || event.revokedBy || match.meta.revoked[event.id]
      || !record.request || record.receipt?.status !== 'committed' || record.receipt.eventId !== event.id
      || record.receipt.revokedBy || record.receipt.revision !== record.state.revision || event.revision !== record.state.revision) return;
    commits.set(event.id, commits.has(event.id) ? null : { record, before, index });
  });
  const accepted = new Map<string, { step: CommittedHumanStep; index: number; binding: string } | null>();
  function accept(rawRequest: unknown, rawReceipt: unknown) {
    const request = object(rawRequest), receipt = object(rawReceipt);
    if (!request || !object(request.command) || !Array.isArray(request.choiceIds)
      || request.choiceIds.some(id => typeof id !== 'string') || new Set(request.choiceIds).size !== request.choiceIds.length
      || request.effectText !== undefined && typeof request.effectText !== 'string'
      || request.effectStep !== undefined && typeof request.effectStep !== 'string'
      || receipt?.status !== 'committed' || typeof receipt.eventId !== 'string') return;
    const commit = commits.get(receipt.eventId);
    if (!commit || receipt.revision !== commit.record.state.revision || canonical(request.command) !== canonical(commit.record.request!.command)) return;
    const metadata = {
      choiceIds: [...request.choiceIds] as string[],
      ...(typeof request.effectText === 'string' ? { effectText: request.effectText } : {}),
      ...(typeof request.effectStep === 'string' ? { effectStep: request.effectStep } : {}),
    };
    const binding = canonical(metadata), previous = accepted.get(receipt.eventId);
    // 同一事实的重复回执不重复消费；相互矛盾的选择绑定没有可恢复的唯一解释。
    if (accepted.has(receipt.eventId) && (!previous || previous.binding !== binding)) { accepted.set(receipt.eventId, null); return; }
    accepted.set(receipt.eventId, { step: { command: commit.record.request!.command as GameCommand, ...metadata, record: commit.record, before: commit.before }, index: commit.index, binding });
  }
  for (const message of messages) {
    if (message.type !== 'function_call' || typeof message.call_id !== 'string' || !['execute_atomic', 'execute_sequence'].includes(String(message.name))) continue;
    const args = parse(message.arguments);
    if (!args) continue;
    for (const output of outputs.get(message.call_id) ?? []) {
      if (message.name === 'execute_atomic') accept(args, output);
      else if (Array.isArray(args.steps) && Array.isArray(output.receipts)) {
        const receipts = output.receipts;
        args.steps.forEach((request, index) => accept(request, receipts[index]));
      }
    }
  }
  return [...accepted.values()].filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((left, right) => left.index - right.index).map(entry => entry.step);
}
