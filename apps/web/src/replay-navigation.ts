import type { PublicEvent } from '../../../packages/protocol/src/index.ts';
import { eventTable } from './event-presentation.ts';
import type { ActionStep } from './action-history.ts';

/** 导航使用完整行动，内部帧仍是服务端原始事件下标。 */
export function previousActionIndex(actions: ActionStep[], index: number): number {
  return actions.filter(action => action.endIndex < index).at(-1)?.endIndex ?? 0;
}
export function nextAction(actions: ActionStep[], index: number): ActionStep | undefined {
  return actions.find(action => action.endIndex > index);
}
export function actionAt(actions: ActionStep[], index: number): ActionStep | undefined {
  return actions.find(action => index > action.startIndex && index <= action.endIndex);
}

/** 行动内部逐次展示可见变化；连续的移动和数值变化也保持原顺序。 */
export function actionKeyframes(action: ActionStep, events: PublicEvent[]): number[] {
  const frames: number[] = [];
  let previous = action.startIndex ? eventTable(events[action.startIndex - 1]) : undefined;
  for (let index = action.startIndex; index < action.endIndex; index++) {
    const event = events[index];
    if (!event) continue;
    const table = eventTable(event);
    const visual = ['look', 'show', 'shuffle', 'random', 'system_restore', 'debug_restore'].includes(event.commandKind)
      || (table && JSON.stringify(table.zones) !== JSON.stringify(previous?.zones));
    if (visual) frames.push(index + 1);
    if (table) previous = table;
  }
  if (frames.at(-1) !== action.endIndex) frames.push(action.endIndex);
  return frames;
}
