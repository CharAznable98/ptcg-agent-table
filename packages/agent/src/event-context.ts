import { createHash } from 'node:crypto';
import type { ModelItem } from './types.ts';

const object = (value: unknown): ModelItem | null => value && typeof value === 'object' && !Array.isArray(value) ? value as ModelItem : null;
const fields = ['observations', 'retrievedObservations'];
/** 只处理宿主的观察数组，不解释卡文、标记或工具结果里的相似对象。 */
function mapRoots<T>(input: T, map: (root: ModelItem) => ModelItem): T {
  if (Array.isArray(input)) return input.map(item => item?.role === 'user' && object(item.content) ? { ...item, content: map(item.content) } : item) as T;
  return (object(input) ? map(input as ModelItem) : input) as T;
}
const mapObservations = (root: ModelItem, map: (value: unknown) => unknown): ModelItem => Object.fromEntries(Object.entries(root).map(([key, value]) => [key, fields.includes(key) && Array.isArray(value) ? value.map(map) : value]));
function observation(value: unknown): { outer: ModelItem; event: ModelItem; payload: ModelItem } | null {
  const outer = object(value), event = object(outer?.data), payload = object(event?.data);
  if (!outer || Object.hasOwn(outer, 'event') || typeof outer.id !== 'string' || typeof outer.revision !== 'number' || !event || typeof event.id !== 'string' || typeof event.revision !== 'number' || typeof event.sequence !== 'number' || typeof event.at !== 'string' || typeof event.actor !== 'string' || typeof event.label !== 'string' || typeof event.commandKind !== 'string' || !payload || typeof object(payload.command)?.kind !== 'string') return null;
  return { outer, event, payload };
}

/** 无损移除事件信封中的重复身份字段，并共享重复的历史flow。当前快照不改。 */
export function eventContext<T>(input: T, shareUniqueFlows = false): { value: T; eventFlows: Record<string, unknown>; packedEvents: number } {
  const counts = new Map<string, number>(), eventFlows: Record<string, unknown> = {};
  mapRoots(input, root => mapObservations(root, value => { const found = observation(value), flow = object(found?.payload.flow); if (flow) { const key = JSON.stringify(flow); counts.set(key, (counts.get(key) ?? 0) + 1); } return value; }));
  let packedEvents = 0;
  const walk = (value: unknown): unknown => {
    const found = observation(value);
    if (found) {
      const event = { ...found.event }, payload = { ...found.payload }, flow = object(payload.flow);
      if (event.id === found.outer.id) delete event.id;
      if (event.revision === found.outer.revision) delete event.revision;
      if (event.label === event.commandKind) delete event.label;
      if (event.commandKind === object(payload.command)?.kind) delete event.commandKind;
      if (flow) {
        const key = JSON.stringify(flow);
        if (shareUniqueFlows || (counts.get(key) ?? 0) > 1) {
          const id = 'f_' + createHash('sha256').update(key).digest('hex').slice(0, 16);
          if (eventFlows[id] && JSON.stringify(eventFlows[id]) !== key) throw new Error('FLOW_REFERENCE_COLLISION');
          eventFlows[id] = structuredClone(flow); payload.flow = { flowRef: id };
        }
      }
      event.data = payload; packedEvents++;
      const { data: _data, ...outer } = found.outer;
      return { ...outer, event };
    }
    return value;
  };
  return { value: mapRoots(input, root => mapObservations(root, walk)), eventFlows, packedEvents };
}

/** 用于审计和工具消费端，重建完整原始观察，不增加或推断事实。 */
export function restoreEvents<T>(input: T, eventFlows: Record<string, unknown>): T {
  const walk = (value: unknown): unknown => {
    const item = object(value);
    if (!item) return value;
    if (typeof item.id === 'string' && typeof item.revision === 'number' && !Object.hasOwn(item, 'data') && object(item.event)) {
      const { event: packed, ...outer } = item, event = { ...packed as ModelItem }, payload = { ...object(event.data)! };
      const ref = object(payload.flow);
      if (ref && Object.keys(ref).length === 1 && typeof ref.flowRef === 'string') {
        if (!Object.hasOwn(eventFlows, ref.flowRef)) throw new Error('UNKNOWN_FLOW_REFERENCE');
        payload.flow = structuredClone(eventFlows[ref.flowRef]);
      }
      event.data = payload;
      if (!Object.hasOwn(event, 'id')) event.id = outer.id;
      if (!Object.hasOwn(event, 'revision')) event.revision = outer.revision;
      if (!Object.hasOwn(event, 'commandKind')) event.commandKind = object(payload.command)!.kind;
      if (!Object.hasOwn(event, 'label')) event.label = event.commandKind;
      return { ...outer, data: event };
    }
    return value;
  };
  return mapRoots(input, root => mapObservations(root, walk));
}

export function sharedEventContext<T extends ModelItem>(input: T): T {
  const { value, eventFlows, packedEvents } = eventContext(input);
  return packedEvents ? { ...value, observationFormat: 'compact-events-v1', eventFlows } : value;
}

export function eventMessages(messages: ModelItem[], shareUniqueFlows = false) {
  const fields = messages.map(item => item.role === 'user' ? 'content' : item.type === 'function_call_output' ? 'output' : null);
  const decoded = messages.map((item, index) => {
    const field = fields[index]; if (!field || typeof item[field] !== 'string') { fields[index] = null; return item; }
    try { return { ...item, [field]: JSON.parse(item[field] as string) }; } catch { fields[index] = null; return item; }
  });
  const result = eventContext(decoded, shareUniqueFlows);
  return { ...result, items: result.value.map((item, index) => fields[index] ? { ...item, [fields[index]!]: JSON.stringify(item[fields[index]!]) } : item) };
}

export function eventHistoryBytes(messages: ModelItem[]): number {
  const { items, packedEvents, eventFlows } = eventMessages(messages);
  return Buffer.byteLength(JSON.stringify({ items, ...(packedEvents ? { observationFormat: 'compact-events-v1', eventFlows } : {}) }));
}
