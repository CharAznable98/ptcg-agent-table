import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  appendContextMessage, appendContextSnapshot, compactHistoryReceipt, createAppendContext, snapshotUpdates, userMessage,
  type AppendContext,
} from '../../../packages/agent/src/context.ts';
import type { Json, ModelItem, Observation } from '../../../packages/agent/src/types.ts';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function content(item: ModelItem): Record<string, unknown> | null {
  if (item.role !== 'user' || typeof item.content !== 'string') return null;
  try { return record(JSON.parse(item.content)); } catch { return null; }
}
function turnOf(observation: Observation): number | null {
  const flow = record(record(record(observation.data)?.data)?.flow);
  return typeof flow?.turnNumber === 'number' ? flow.turnNumber : null;
}

/** 原始轨迹留在messages和journal；此对象仅保存模型实际可达的编码段。 */
export interface HumanActionContext {
  version: 1;
  wire: AppendContext;
  sourceMessages: number;
  observationHashes: Record<string, string>;
  callTools: Record<string, string>;
  review: Json | null;
  reviewStart: number | null;
}
export interface HumanContextSource {
  messages: ModelItem[];
  context?: HumanActionContext;
  recovery?: { messageStart: number };
}
export function createHumanActionContext(): HumanActionContext {
  return { version: 1, wire: createAppendContext(), sourceMessages: 0, observationHashes: {}, callTools: {}, review: null, reviewStart: null };
}

function freshObservations(context: HumanActionContext, observations: Observation[]): Observation[] {
  return observations.filter(observation => {
    const fingerprint = hash(observation);
    if (context.observationHashes[observation.id] === fingerprint) return false;
    context.observationHashes[observation.id] = fingerprint; return true;
  });
}

function appendFrame(context: HumanActionContext, value: Record<string, unknown>): void {
  const { snapshot, observations, ...fields } = value;
  if (!record(snapshot) || typeof value.revision !== 'number') throw new Error('INVALID_HUMAN_CONTEXT_FRAME');
  const turn = record(record(snapshot)?.flow)?.turnNumber;
  const all = Array.isArray(observations) ? observations as Observation[] : [];
  const included = all.filter(event => typeof turn !== 'number' || turnOf(event) === null || turnOf(event)! >= turn - 1);
  const omitted = all.filter(event => !included.includes(event));
  // 初次建立段给出明确覆盖范围。后续frame按游标到达，重放只补充新事实或撤销标记。
  const historyCoverage = context.wire.revision === null ? {
    fromTurn: typeof turn === 'number' ? Math.max(0, turn - 1) : null,
    throughTurn: typeof turn === 'number' ? turn : null,
    older: omitted.length ? { count: omitted.length, firstEventId: omitted[0]!.id, lastEventId: omitted.at(-1)!.id, readTool: 'read_history' } : null,
  } : undefined;
  appendContextSnapshot(context.wire, snapshot as Json, value.revision, {
    ...fields, observations: freshObservations(context, included),
    ...(context.wire.revision === null ? { stateFormat: 'append-state-v1', observationFormat: 'compact-events-v1' } : {}),
    ...(historyCoverage ? { historyCoverage } : {}),
  });
}

function reviewDelta(previous: Json, next: Json) {
  return snapshotUpdates(previous, next).flatMap(update => {
    if ('remove' in update || update.path.length !== 1) return [update];
    const key = update.path[0]!, old = record(previous)?.[key], value = update.value;
    // 进度数组只追加新增/更改项；回滚缩短时完整替换，避免保留失效提交。
    if (!Array.isArray(old) || !Array.isArray(value) || value.length < old.length) return [update];
    return value.flatMap((item, index) => isDeepStrictEqual(old[index], item) ? [] : [{ path: [key, index], value: item }]);
  });
}

function appendReview(context: HumanActionContext, review: unknown): void {
  const raw = structuredClone(record(review) ?? {});
  const history = Array.isArray(raw.relatedHistory) ? raw.relatedHistory : [];
  const observations = history.flatMap(item => {
    const event = record(item);
    return event && typeof event.id === 'string' && typeof event.revision === 'number' ? [{ id: event.id, revision: event.revision, data: event as Json }] : [];
  });
  const value = { ...raw, ...(history.length ? { relatedHistory: observations.map(item => ({ observationRef: item.id, ...(record(item.data)?.revokedBy ? { revokedBy: record(item.data)!.revokedBy } : {}) })) } : {}) } as Json;
  const retrievedObservations = freshObservations(context, observations);
  if (context.review === null) appendContextMessage(context.wire, userMessage({ actionReview: value, ...(retrievedObservations.length ? { retrievedObservations } : {}) }));
  else {
    const updates = reviewDelta(context.review, value);
    if (updates.length || retrievedObservations.length) appendContextMessage(context.wire, userMessage({ reviewUpdates: updates, ...(retrievedObservations.length ? { retrievedObservations } : {}) }));
  }
  context.review = value;
}

function appendMessage(context: HumanActionContext, raw: ModelItem): void {
  if (raw.type === 'function_call' && typeof raw.call_id === 'string' && typeof raw.name === 'string') context.callTools[raw.call_id] = raw.name;
  let item = raw;
  let retrievedObservations: Observation[] = [];
  if (raw.type === 'function_call_output' && typeof raw.call_id === 'string') {
    if (context.callTools[raw.call_id] === 'read_history' && typeof raw.output === 'string') {
      let receipt: Record<string, unknown> | null = null;
      try { receipt = record(JSON.parse(raw.output)); } catch { /* 非JSON反馈原样保留。 */ }
      if (receipt) {
        const entries = record(receipt.data)?.entries;
        if (receipt.status === 'read' && Array.isArray(entries)) retrievedObservations = freshObservations(context, entries.flatMap(entry => {
          const event = record(entry);
          return event && typeof event.id === 'string' && typeof event.revision === 'number' ? [{ id: event.id, revision: event.revision, data: event as Json }] : [];
        }));
        // 新旧读取结果都指向本段可达观察；新定义紧随原生反馈，调用配对仍连续。
        const compact = compactHistoryReceipt(receipt, new Set(Object.keys(context.observationHashes)));
        item = { ...raw, output: JSON.stringify(compact) };
      }
    }
    delete context.callTools[raw.call_id];
  }
  appendContextMessage(context.wire, item);
  if (retrievedObservations.length) appendContextMessage(context.wire, userMessage({ retrievedObservations }));
}

/** 无旧工具轨迹重放的迁移／修正段：当前事实来自宿主账本，完整旧历史仍可按需读取。 */
function startReviewSegment(state: HumanContextSource, review: unknown): HumanActionContext {
  const context = createHumanActionContext();
  context.reviewStart = state.recovery?.messageStart ?? null;
  for (const item of state.messages) {
    const value = content(item);
    if (value && ['human_action_rules', 'human_action_setup'].includes(String(value.stage))) appendContextMessage(context.wire, item);
  }
  appendReview(context, review);
  const latestFrame = state.messages.findLastIndex(item => content(item)?.stage === 'human_action');
  if (latestFrame < 0) throw new Error('HUMAN_CONTEXT_FRAME_REQUIRED');
  appendFrame(context, content(state.messages[latestFrame]!)!);
  context.sourceMessages = latestFrame + 1;
  state.context = context; return context;
}

/** 共用AI的卡文目录、事件目录、快照差量；仅编排人类行动的事实窗口，不参与任何游戏抉择。 */
export function humanActionInput(state: HumanContextSource, review: () => unknown): ModelItem[] {
  const changedReview = state.recovery && state.context?.reviewStart !== state.recovery.messageStart;
  const context = !state.context || changedReview ? startReviewSegment(state, review()) : state.context;
  if (context.sourceMessages > state.messages.length) throw new Error('HUMAN_CONTEXT_SOURCE_TRUNCATED');
  for (; context.sourceMessages < state.messages.length; context.sourceMessages++) {
    const item = state.messages[context.sourceMessages]!, value = content(item);
    if (value?.stage === 'human_action') appendFrame(context, value);
    else appendMessage(context, item);
  }
  if (state.recovery) appendReview(context, review());
  return context.wire.items.slice();
}
