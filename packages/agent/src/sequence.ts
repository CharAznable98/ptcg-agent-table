import type { Json } from './types.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** 只判断是否依赖洗牌前顺序；信息暴露与实时权限仍由宿主逐步检查。 */
export function independentAfterHiddenShuffle(action: { tool: string; arguments: Json }, zoneIds: string[], playerId: string): boolean {
  const args = object(action.arguments), touched = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (typeof item.zoneId === 'string' && zoneIds.includes(item.zoneId)) touched.add(item.zoneId);
    Object.values(item).forEach(visit);
  };
  visit(args);
  if (!touched.size) return true;
  if (['show_known', 'move_known'].includes(action.tool)) {
    if (zoneIds.includes(String(args.zoneId))) return false;
    const target = object(object(args.destination).container);
    return target.kind !== 'group' || !zoneIds.includes(String(object(target.position).zoneId));
  }
  const source = object(args.source), container = object(source.container), range = object(source.range), destination = object(args.destination), target = object(destination.container);
  if (action.tool === 'move') {
    if ([container, target].some(item => item.kind === 'group' && zoneIds.includes(String(object(item.position).zoneId)))) return false;
    // 仅目的地被洗，不影响已经确定的源对象；整区移动也不按洗牌前位置筛选。
    const shuffledSource = container.kind === 'zone' && zoneIds.includes(String(container.zoneId));
    if (!shuffledSource || range.mode === 'all') return true;
  }
  const selection = object(args.selection), selectedContainer = object(selection.container), selectedRange = object(selection.range);
  if (['look', 'show', 'shuffle'].includes(action.tool) && selectedContainer.kind === 'zone' && selectedRange.mode === 'all') return true;
  if (action.tool === 'set_state' && object(args.target).kind === 'zone') return true;
  return action.tool === 'move' && touched.size === 1 && container.kind === 'zone' && container.zoneId === `${playerId}:deck`
    && range.mode === 'range' && range.start === 0 && typeof range.count === 'number' && Number.isInteger(range.count) && range.count > 0
    && target.kind === 'zone' && target.zoneId === `${playerId}:hand`;
}

/** 本次序列提交时牌名已经写死；不接受动态引用或查看结果中的条件选择。 */
export function preselectedNamedSelection(action: { tool: string; arguments: Json }, zoneIds: string[]): boolean {
  const args = object(action.arguments);
  return ['show_known', 'move_known'].includes(action.tool) && zoneIds.includes(String(args.zoneId))
    && typeof args.name === 'string' && args.name.trim().length > 0;
}

/** 名称解析只放开预定目标；原始位置依赖在整段序列中仍然失效。 */
export function independentAfterNamedSelection(action: { tool: string; arguments: Json }, zoneIds: string[], playerId: string): boolean {
  const args = object(action.arguments);
  if (preselectedNamedSelection(action, zoneIds)) {
    const destination = object(object(args.destination).container);
    return destination.kind !== 'group' || !zoneIds.includes(String(object(destination.position).zoneId));
  }
  const source = object(args.source), container = object(source.container);
  if (action.tool === 'move' && container.kind === 'zone' && zoneIds.includes(String(container.zoneId)) && object(source.range).mode !== 'all') return false;
  return independentAfterHiddenShuffle(action, zoneIds, playerId);
}
