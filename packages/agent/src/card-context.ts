import { createHash } from 'node:crypto';
import type { ModelItem } from './types.ts';
import { eventHistoryBytes } from './event-context.ts';

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);

/** 只共享相同牌面值；实例、位置、数量和权限均保留，原始对象不修改。 */
export function cardContext<T>(input: T): { value: T; knownCards: Record<string, unknown> } {
  const knownCards: Record<string, unknown> = {}, ids = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    if (typeof object.name === 'string' && ['pokemon', 'trainer', 'energy'].includes(String(object.kind))) {
      const serialized = JSON.stringify(object);
      let id = ids.get(serialized);
      if (!id) {
        const identity = canonical(object);
        id = 'c_' + createHash('sha256').update(identity).digest('hex').slice(0, 16);
        if (knownCards[id] && canonical(knownCards[id]) !== identity) throw new Error('CARD_REFERENCE_COLLISION');
        knownCards[id] = structuredClone(object); ids.set(serialized, id);
      }
      return { cardRef: id };
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, walk(item)]));
  };
  return { value: walk(input) as T, knownCards };
}

export function sharedCardContext<T extends ModelItem>(input: T): T & { knownCards?: Record<string, unknown> } {
  const { value, knownCards } = cardContext(input);
  return { ...value, ...(Object.keys(knownCards).length ? { knownCards } : {}) };
}

/** Native消息的JSON字段先投影再重新序列化，保留调用ID和调用/反馈结构。 */
export function cardMessages(messages: ModelItem[]): { items: ModelItem[]; knownCards: Record<string, unknown> } {
  const decoded = messages.map(item => {
    const field = item.role === 'user' ? 'content' : item.type === 'function_call_output' ? 'output' : null;
    if (!field || typeof item[field] !== 'string') return { item, field: null };
    try { return { item: { ...item, [field]: JSON.parse(item[field] as string) }, field }; } catch { return { item, field: null }; }
  });
  const { value, knownCards } = cardContext(decoded.map(row => row.item));
  return { items: value.map((item, index) => decoded[index]!.field ? { ...item, [decoded[index]!.field!]: JSON.stringify(item[decoded[index]!.field!]) } : item), knownCards };
}

/** 固定牌面表另外提供；动态历史预算只计算事实、位置和引用。 */
export const historyBytes = (messages: ModelItem[]): number => eventHistoryBytes(cardMessages(messages).items);
