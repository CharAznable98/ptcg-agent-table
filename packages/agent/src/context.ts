import { playerStrategyProjection } from './policy.ts';
import { Type } from '@sinclair/typebox';
import { isDeepStrictEqual } from 'node:util';
import type { ContextProgress, Json, ModelItem, Observation, PlayerFrame, PlayerSession } from './types.ts';
import { cardMessages, historyBytes } from './card-context.ts';
import { eventMessages } from './event-context.ts';

export const contextBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const userMessage = (value: unknown): ModelItem => ({ role: 'user', content: JSON.stringify(value) });

/** 只移除本请求已通过固定资料提供的副本，不改变权限投影或原始观察。 */
export function currentSnapshot(snapshot: Json): Json {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const { ownDeck: _deck, ...live } = snapshot;
  return live;
}

export function migrateContext(session: PlayerSession): boolean {
  if (session.context) return false;
  const legacySnapshots: Json[] = [];
  for (const message of session.messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    let value: Record<string, Json>;
    try { value = JSON.parse(message.content) as Record<string, Json>; } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'snapshot')) continue;
    legacySnapshots.push(currentSnapshot(value.snapshot!));
  }
  session.context = { version: 2, observationOffset: 0, toolOffset: 0, ...(legacySnapshots.length ? { legacySnapshots } : {}) };
  return true;
}

type Wire = NonNullable<ContextProgress['wire']>;
export type SnapshotUpdate = { path: (string | number)[]; value: Json } | { path: (string | number)[]; remove: true };
const object = (value: Json): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value);
const equal = isDeepStrictEqual;

/** 区域完整替换，绝不把上一版公开身份合并进重新隐藏的位置。其余快照字段按顶层替换/删除。 */
export function snapshotUpdates(previous: Json, next: Json): SnapshotUpdate[] {
  if (equal(previous, next)) return [];
  if (!object(previous) || !object(next)) return [{ path: [], value: structuredClone(next) }];
  const updates: SnapshotUpdate[] = [];
  for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) updates.push({ path: [key], remove: true });
  for (const [key, value] of Object.entries(next)) {
    if (equal(previous[key], value)) continue;
    if (key === 'zones' && Array.isArray(previous[key]) && Array.isArray(value) && previous[key].length === value.length) {
      const old = previous[key];
      value.forEach((zone, index) => { if (!equal(old[index], zone)) updates.push({ path: [key, index], value: structuredClone(zone) }); });
    } else updates.push({ path: [key], value: structuredClone(value) });
  }
  return updates;
}

/** 宿主审计/消费端可独立恢复快照；路径只来自本模块生成的区域和顶层字段。 */
export function applySnapshotUpdates(previous: Json, updates: SnapshotUpdate[]): Json {
  let next = structuredClone(previous);
  for (const update of updates) {
    if (!update.path.length) {
      if ('remove' in update) throw new Error('CANNOT_REMOVE_SNAPSHOT_ROOT');
      next = structuredClone(update.value); continue;
    }
    let parent: Json = next;
    for (const key of update.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('INVALID_SNAPSHOT_UPDATE_PATH');
      parent = (parent as Record<string | number, Json>)[key]!;
    }
    if (!parent || typeof parent !== 'object') throw new Error('INVALID_SNAPSHOT_UPDATE_PATH');
    const key = update.path.at(-1)!;
    if (typeof key === 'string' && ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('INVALID_SNAPSHOT_UPDATE_PATH');
    if ('remove' in update) delete (parent as Record<string | number, Json>)[key];
    else Object.defineProperty(parent, key, { value: structuredClone(update.value), enumerable: true, writable: true, configurable: true });
  }
  return next;
}

/** 只能由首次建立/旧格式迁移或成功压缩开始新段；原始消息水位始终是绝对位置。 */
export function startContextSegment(session: PlayerSession, historyStart = 0): Wire {
  if (!session.context) migrateContext(session);
  const wire: Wire = { format: 'append-state-v1', epoch: (session.context!.wire?.epoch ?? -1) + 1, historyStart, sourceMessages: historyStart, items: [], lastSnapshot: null, revision: null, summaryKey: JSON.stringify(session.summary ?? null), catalogs: { cards: {}, flows: {} } };
  session.context!.wire = wire;
  session.context!.deliveredWireItems = 0;
  return wire;
}

function appendWire(wire: Wire, raw: ModelItem, observations: Observation[] = []): void {
  const cards = cardMessages([linkNativeObservations(raw, observations)]);
  const events = eventMessages(cards.items, true);
  const knownCards: Record<string, unknown> = {}, eventFlows: Record<string, unknown> = {};
  for (const [kind, incoming, delta] of [['cards', cards.knownCards, knownCards], ['flows', events.eventFlows, eventFlows]] as const) {
    const catalog = wire.catalogs[kind];
    for (const [id, value] of Object.entries(incoming)) {
      if (Object.hasOwn(catalog, id)) {
        if (!equal(catalog[id], value)) throw new Error('CONTEXT_REFERENCE_COLLISION');
      } else { catalog[id] = value; delta[id] = value; }
    }
  }
  const item = events.items[0]!;
  const catalog = { ...(Object.keys(knownCards).length ? { knownCards } : {}), ...(Object.keys(eventFlows).length ? { eventFlows } : {}) };
  // 原生调用/反馈不插队；反馈用到的新定义紧随其后，在同次请求内可完整解析。
  if (Object.keys(catalog).length && item.type !== 'function_call_output') wire.items.push(userMessage(catalog));
  wire.items.push(item);
  if (Object.keys(catalog).length && item.type === 'function_call_output') wire.items.push(userMessage(catalog));
}

function liveMessage(item: ModelItem): ModelItem {
  if (item.role !== 'user' || typeof item.content !== 'string') return item;
  try {
    const value = JSON.parse(item.content) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'snapshot')) return item;
    const { snapshot: _snapshot, memory: _memory, ...events } = value;
    return userMessage(events);
  } catch { return item; }
}

export function playerInput(session: PlayerSession, frame: PlayerFrame, maxActions: number, availableTools?: string[]): ModelItem[] {
  const wire = session.context?.wire ?? startContextSegment(session);
  if (wire.summaryKey !== JSON.stringify(session.summary ?? null)) throw new Error('CONTEXT_SUMMARY_CHANGED_WITHOUT_COMPACTION');
  if (wire.sourceMessages > session.messages.length) throw new Error('CONTEXT_SOURCE_MESSAGES_TRUNCATED');
  if (!wire.items.length) {
    appendWire(wire, userMessage({ playerId: session.playerId, deck: session.deck, initialStrategy: playerStrategyProjection(session.strategy, session.policyScope), observationFormat: 'compact-events-v1', stateFormat: wire.format }));
    if (session.summary) appendWire(wire, userMessage({ memory: session.summary, memoryCoverage: {
      observationsThrough: session.context!.observationOffset, toolsThrough: session.context!.toolOffset,
      lastEventId: session.observations[session.context!.observationOffset - 1]?.id ?? null,
      lastRevision: session.observations[session.context!.observationOffset - 1]?.revision ?? null,
    } }));
  }
  const available = new Map<string, Observation>();
  for (const item of session.messages.slice(wire.historyStart)) {
    if (item.role !== 'user' || typeof item.content !== 'string') continue;
    try { for (const event of JSON.parse(item.content).observations ?? []) if (typeof event.id === 'string') available.set(event.id, event); } catch { /* 非观察消息不加入来源集合。 */ }
  }
  const availableObservations = [...available.values()];
  for (; wire.sourceMessages < session.messages.length; wire.sourceMessages++) appendWire(wire, liveMessage(session.messages[wire.sourceMessages]!), availableObservations);
  const snapshot = currentSnapshot(frame.snapshot);
  const execution = { mode: 'sequential', maxActionsPerDecision: maxActions, availableTools: availableTools ?? frame.tools?.map(tool => tool.name) ?? [],
    ...(maxActions > 1 && (frame.toolCatalog ?? frame.tools ?? []).some(tool => tool.argumentEncoding === 'ptcg-positions-v1') ? { argumentFormat: 'ptcg-positions-v1' } : {}) };
  appendWire(wire, userMessage({ revision: frame.revision, ...(wire.revision === null ? { snapshot } : { snapshotUpdates: snapshotUpdates(wire.lastSnapshot, snapshot) }), execution }));
  wire.lastSnapshot = structuredClone(snapshot); wire.revision = frame.revision;
  // 后续追加不改变已交给网关的数组；消息本身一旦编码便不再修改。
  return wire.items.slice();
}

/** 静态定义不挤占动态预算；此处测量当前活跃输入，触发器另看已消费可压缩前缀。 */
function dynamicItems(items: ModelItem[], excludeAnchor = false): ModelItem[] {
  return items.filter(item => {
    if (item.role !== 'user' || typeof item.content !== 'string') return true;
    try {
      const value = JSON.parse(item.content);
      return !value.knownCards && !value.eventFlows && !Object.hasOwn(value, 'initialStrategy')
        && (!excludeAnchor || !Object.hasOwn(value, 'snapshot') && !Object.hasOwn(value, 'memory'));
    } catch { return true; }
  });
}

export function activeContextBytes(session: PlayerSession): number {
  const wire = session.context?.wire;
  if (!wire) return historyBytes(session.messages);
  return contextBytes(dynamicItems(wire.items)) + historyBytes(session.messages.slice(wire.sourceMessages));
}

/** 触发器只计算已消费且新段无需原样重发的历史；新观察先完整交付一次。 */
export function compactionContextBytes(session: PlayerSession): { consumedBytes: number; compressibleBytes: number; anchorBytes: number } {
  const wire = session.context?.wire;
  if (!wire) return { consumedBytes: 0, compressibleBytes: 0, anchorBytes: 0 };
  const consumed = wire.items.slice(0, session.context!.deliveredWireItems ?? 0);
  const consumedBytes = contextBytes(dynamicItems(consumed));
  const compressibleBytes = contextBytes(dynamicItems(consumed, true));
  return { consumedBytes, compressibleBytes, anchorBytes: consumedBytes - compressibleBytes };
}

/** 保留已消费的完整 user／工具调用／反馈段；未消费段由调用方另外保护。 */
export function recentHistory(messages: ModelItem[], budget: number, measure: (messages: ModelItem[]) => number = contextBytes): ModelItem[] {
  const starts = messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
  let tail: ModelItem[] = [];
  for (let index = starts.length - 1; index >= 0; index--) {
    const candidate = messages.slice(starts[index]);
    if (measure(candidate) > Math.max(2, budget)) break;
    tail = candidate;
  }
  return tail;
}

/** 读历史是既有观察的索引，不把同一整页再次送进压缩／复盘。原件不变。 */
export function reviewTools(session: PlayerSession, start = 0): ModelItem[] {
  const known = new Set(session.observations.map(event => event.id));
  return session.toolHistory.slice(start).map(item => {
    const request = item.request as { tool?: string } | undefined;
    const receipt = item.receipt as { status?: string; data?: { entries?: { id?: string; revokedBy?: string }[]; cursor?: string; previousCursor?: string; hasMore?: boolean; hasPrevious?: boolean; direction?: string; oversizedEntry?: boolean; maxBytes?: number } } | undefined;
    if (request?.tool !== 'read_history' || receipt?.status !== 'read' || !Array.isArray(receipt.data?.entries)) return item;
    const entries = receipt.data.entries;
    const novel = entries.filter(entry => !entry.id || !known.has(entry.id));
    return { ...item, receipt: { ...receipt, data: {
      source: 'observations', entryCount: entries.length, firstEventId: entries[0]?.id ?? null, lastEventId: entries.at(-1)?.id ?? null,
      evidenceRefs: [...new Set(entries.flatMap(entry => entry.id && known.has(entry.id) ? [entry.id] : []))],
      cursor: receipt.data.cursor ?? null, hasMore: receipt.data.hasMore ?? null,
      previousCursor: receipt.data.previousCursor ?? null, hasPrevious: receipt.data.hasPrevious ?? null,
      direction: receipt.data.direction ?? null, oversizedEntry: receipt.data.oversizedEntry ?? false, maxBytes: receipt.data.maxBytes ?? null,
      revokedEvidence: entries.flatMap(entry => entry.id && entry.revokedBy ? [{ id: entry.id, revokedBy: entry.revokedBy }] : []),
      ...(novel.length ? { entries: novel } : {}),
    } } };
  });
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function eventPayload(observation: Observation): Record<string, unknown> | null {
  return record(record(observation.data)?.data);
}
/** 仅将与同一实际事件完全相同的参数/结果替换为来源引用；拒绝和读取内容保留。 */
export function linkToolObservations(tools: ModelItem[], observations: Observation[], aliases: Map<string, string> = new Map()): ModelItem[] {
  const sources = new Map(observations.map(observation => [observation.id, observation]));
  return tools.map(item => {
    const request = record(item.request), receipt = record(item.receipt), data = record(receipt?.data);
    if (!request || receipt?.status !== 'committed' || data?.status !== 'committed' || typeof data.eventId !== 'string') return item;
    const source = sources.get(data.eventId), payload = source && eventPayload(source), command = record(payload?.command);
    if (!payload || !command) return item;
    const { kind, ...arguments_ } = command;
    const observationRef = aliases.get(data.eventId) ?? data.eventId;
    const argumentsRef = { observationRef, field: 'commandArguments' };
    const linkedArguments = kind === request.tool && equal(arguments_, request.arguments) && contextBytes(arguments_) > contextBytes(argumentsRef);
    const resultField = Object.hasOwn(payload, 'result') && equal(data.result, payload.result) ? 'result'
      : Object.hasOwn(payload, 'reveals') && equal(data.result, { result: payload.result, reveals: payload.reveals }) ? 'resultWithReveals' : null;
    const resultRef = resultField ? { observationRef, field: resultField } : null;
    const linkedResult = resultRef && Object.hasOwn(data, 'result') && contextBytes(data.result) > contextBytes(resultRef);
    if (!linkedArguments && !linkedResult) return item;
    return { ...item, request: { ...request, ...(linkedArguments ? { arguments: argumentsRef } : {}) },
      receipt: { ...receipt, data: { ...data, ...(linkedResult ? { result: resultRef } : {}) } } };
  });
}

/** 审计时还原上述来源引用；原始观察和工具记录始终另行完整保存。 */
export function restoreToolObservations(tools: ModelItem[], observations: Observation[], aliases: Map<string, string> = new Map()): ModelItem[] {
  const sources = new Map(observations.map(observation => [aliases.get(observation.id) ?? observation.id, observation]));
  const restore = (value: unknown) => {
    const ref = record(value);
    if (!ref || Object.keys(ref).length !== 2 || typeof ref.observationRef !== 'string' || !['commandArguments', 'result', 'resultWithReveals'].includes(String(ref.field))) return value;
    const source = sources.get(ref.observationRef), payload = source && eventPayload(source);
    if (!payload) throw new Error('UNKNOWN_TOOL_OBSERVATION_REFERENCE');
    if (ref.field === 'result') return structuredClone(payload.result);
    if (ref.field === 'resultWithReveals') return structuredClone({ result: payload.result, reveals: payload.reveals });
    const { kind: _kind, ...arguments_ } = record(payload.command)!;
    return structuredClone(arguments_);
  };
  return tools.map(item => {
    const request = record(item.request), receipt = record(item.receipt), data = record(receipt?.data);
    if (!request || !receipt || !data) return item;
    return { ...item, request: { ...request, ...(Object.hasOwn(request, 'arguments') ? { arguments: restore(request.arguments) } : {}) },
      receipt: { ...receipt, data: { ...data, ...(Object.hasOwn(data, 'result') ? { result: restore(data.result) } : {}) } } };
  });
}

/** 只有同一线上段内完整观察可达时才链接原生反馈；不改原生call_id或原始存档。 */
export function linkNativeObservations(item: ModelItem, observations: Observation[]): ModelItem {
  if (item.type !== 'function_call_output' || typeof item.output !== 'string') return item;
  let output: Record<string, unknown> | null;
  try { output = record(JSON.parse(item.output)); } catch { return item; }
  if (!output) return item;
  const link = (receipt: unknown) => linkToolObservations([{ request: {}, receipt }], observations)[0]!.receipt;
  const linked = Array.isArray(output.results) ? { ...output, results: output.results.map(value => {
    const result = record(value); return result && result.receipt ? { ...result, receipt: link(result.receipt) } : value;
  }) } : link(output);
  return { ...item, output: JSON.stringify(linked) };
}

/** 按最坏 JSON 字符转义长度预留正文和引用预算，避免中文字符数与字节数错配。 */
export function compressionBudget(maxBytes: number, evidenceIds: string[], outputRefs = evidenceIds) {
  const base = contextBytes({ text: '', evidenceRefs: [] });
  const idBytes = Math.max(1, ...evidenceIds.map(id => contextBytes(id) + 1));
  const maxEvidenceRefs = Math.min(32, evidenceIds.length, Math.floor(maxBytes / 4 / idBytes));
  const maxTextCharacters = Math.min(12_000, Math.floor((maxBytes - base - maxEvidenceRefs * idBytes) / 6));
  if (maxTextCharacters < 1) throw new Error('SUMMARY_BUDGET_TOO_SMALL');
  return {
    maxSummaryBytes: maxBytes, maxTextCharacters, maxEvidenceRefs, allowedEvidenceRefs: outputRefs,
    schema: CompressionResultSchema,
  };
}

const CompressionResultSchema = Type.Object({ text: Type.String({ minLength: 1, maxLength: 12_000 }), evidenceRefs: Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 }) }, { additionalProperties: false });
