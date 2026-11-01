import { applySnapshotUpdates, type SnapshotUpdate } from '../../../packages/agent/src/context.ts';
import { restoreEvents } from '../../../packages/agent/src/event-context.ts';
import type { Json, ModelItem } from '../../../packages/agent/src/types.ts';

/** 仅供脚本模型断言语义使用，真实请求仍使用相同AI共享编码。 */
export function decodeHumanInput(input: ModelItem[]): ModelItem[] {
  const values = input.map(item => item.role === 'user' && typeof item.content === 'string' ? JSON.parse(item.content) : null);
  const cards = Object.assign({}, ...values.flatMap(value => value?.knownCards ? [value.knownCards] : []));
  const flows = Object.assign({}, ...values.flatMap(value => value?.eventFlows ? [value.eventFlows] : []));
  const restore = (value: any): any => Array.isArray(value) ? value.map(restore) : !value || typeof value !== 'object' ? value
    : Object.keys(value).length === 1 && value.cardRef ? structuredClone(cards[value.cardRef])
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)]));
  let snapshot: Json = null, review: Json = null, reviewIndex = -1;
  const decoded: ModelItem[] = [];
  for (let index = 0; index < input.length; index++) {
    const item = input[index]!, value = values[index];
    if (value) {
      if (value.knownCards || value.eventFlows) continue;
      const current = restore(restoreEvents(value, flows));
      if (current.actionReview) { review = current.actionReview; reviewIndex = decoded.length; decoded.push({ role: 'user', content: '{}' }); continue; }
      if (current.reviewUpdates) { review = applySnapshotUpdates(review, current.reviewUpdates as SnapshotUpdate[]); continue; }
      if (current.snapshot) snapshot = current.snapshot;
      if (current.snapshotUpdates) snapshot = applySnapshotUpdates(snapshot, current.snapshotUpdates);
      if (current.stage === 'human_action') current.snapshot = structuredClone(snapshot);
      decoded.push({ ...item, content: JSON.stringify(current) });
    } else if (item.type === 'function_call_output' && typeof item.output === 'string') {
      decoded.push({ ...item, output: JSON.stringify(restore(JSON.parse(item.output))) });
    } else decoded.push(item);
  }
  if (reviewIndex >= 0) decoded[reviewIndex] = { role: 'user', content: JSON.stringify({ stage: 'recovery_review', ...(review as Record<string, Json>) }) };
  return decoded;
}

export function decodeHumanReview(input: ModelItem[]): Record<string, unknown> | null {
  const decoded = decodeHumanInput(input);
  const item = decoded.find(item => item.role === 'user' && JSON.parse(item.content as string).stage === 'recovery_review');
  return item ? JSON.parse(item.content as string) : null;
}
