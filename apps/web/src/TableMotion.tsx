import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { CardData, MatchView, ObjectView, Position, PublicEvent } from '../../../packages/protocol/src/index.ts';
import { CardFace } from './Cards.tsx';
import { CardBack } from './CardBack.tsx';
import { eventTable, presentEvent } from './event-presentation.ts';
import { objectAt, positionKey } from './table-utils.ts';
import { buildActionHistory } from './action-history.ts';
import { LIVE_FRAME_MS } from './live-presentation.ts';
import './table-motion.css';

type Rect = { x: number; y: number; width: number; height: number };
type Ghost = { from: Rect; to: Rect; card?: CardData };
type Pulse = { rect: Rect; text?: string; shuffle?: boolean };
const fields = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function cardOf(object: ObjectView | null): CardData | undefined {
  const top = object?.kind === 'group' ? object.stack.at(-1) : object;
  return top?.kind === 'card' ? top.card : undefined;
}
function selectedSources(event: PublicEvent): Position[] {
  const source = fields(fields(fields(event.data).command).source), container = fields(source.container), range = fields(source.range);
  const table = eventTable(event);
  const indexes = range.mode === 'indices' ? range.indices as number[]
    : range.mode === 'range' ? Array.from({ length: Math.min(Number(range.count) || 0, 3) }, (_, index) => Number(range.start) + index)
    : Array.from({ length: Math.min(table?.zones.find(zone => zone.id === container.zoneId)?.items.length ?? 0, 3) }, (_, index) => index);
  return indexes.slice(0, 3).map(index => container.kind === 'group'
    ? { ...container.position as Position, member: { relation: container.relation as 'stack' | 'attached', index } }
    : { zoneId: String(container.zoneId), index });
}
function rectangle(rectangles: Map<string, Rect>, position: Position): Rect | undefined {
  return rectangles.get(positionKey(position)) ?? rectangles.get(positionKey({ zoneId: position.zoneId, index: position.index })) ?? rectangles.get(position.zoneId);
}

/** 一次只接收展示队列中的一帧，模型和网络继续接收后续状态。 */
export function TableMotion({ view }: { view: MatchView }) {
  const layer = useRef<HTMLDivElement>(null);
  const previous = useRef<{ view: MatchView; rectangles: Map<string, Rect> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [motion, setMotion] = useState<{ key: string; ghosts: Ghost[]; pulses: Pulse[] } | null>(null);
  useLayoutEffect(() => {
    const root = layer.current?.parentElement;
    if (!root) return;
    const origin = root.getBoundingClientRect(), rectangles = new Map<string, Rect>();
    const save = (key: string, element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) rectangles.set(key, { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height });
    };
    root.querySelectorAll('[data-zone-id]').forEach(element => save(element.getAttribute('data-zone-id')!, element));
    root.querySelectorAll('[data-position-key]').forEach(element => save(element.getAttribute('data-position-key')!, element.querySelector('.object-button') ?? element));
    const old = previous.current;
    previous.current = { view, rectangles };
    if (!old || old.view.viewer !== view.viewer || old.view.id !== view.id || old.view.revision === view.revision) return;
    if (timer.current) clearTimeout(timer.current);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setMotion(null); return; }
    const event = view.events.at(-1);
    if (!event || view.events.length <= old.view.events.length) { setMotion(null); return; }
    const before = view.events.at(-2), presentation = presentEvent(event, before);
    const pulses: Pulse[] = presentation.positions.slice(0, 5).flatMap(position => {
      const rect = rectangle(rectangles, position);
      return rect ? [{ rect, shuffle: event.commandKind === 'shuffle' }] : [];
    });
    const ghosts: Ghost[] = [];
    const action = buildActionHistory(view.events).at(-1);
    if (action?.motion === 'swap' && action.startIndex === old.view.events.length) {
      const first = selectedSources(action.events[0]!)[0], second = selectedSources(action.events[1]!)[0];
      if (first && second) for (const [source, target] of [[first, second], [second, first]]) {
        const from = rectangle(old.rectangles, source!), to = rectangle(rectangles, target!);
        const card = cardOf(objectAt(old.view, source!));
        if (from && to) ghosts.push({ from, to, ...(card ? { card } : {}) });
      }
    } else if (event.commandKind === 'move') {
      const sources = selectedSources(event);
      sources.forEach((source, index) => {
        const from = rectangle(old.rectangles, source), target = presentation.positions[index];
        const to = target && rectangle(rectangles, target);
        const historicalBefore = eventTable(before);
        const oldObject = objectAt(old.view, source);
        // 跳过的中间步骤可能已改变同一位置；此时只显示变化高亮。
        const sameSource = !historicalBefore || JSON.stringify(oldObject) === JSON.stringify(objectAt(historicalBefore, source));
        if (from && to && sameSource && from.width < 220 && oldObject) {
          const card = cardOf(oldObject);
          ghosts.push({ from, to, ...(card ? { card } : {}) });
        }
      });
    }
    if (event.commandKind === 'set_state') {
      const command = fields(fields(event.data).command), field = fields(command.field), target = fields(command.target);
      if (field.key === 'damageCounters' && target.position) {
        const at = target.position as Position, oldObject = objectAt(old.view, at), next = Number(field.value) * 10;
        const difference = oldObject?.kind === 'group' ? next - oldObject.state.damageCounters * 10 : 0;
        const pulse = pulses[0];
        if (pulse && difference) pulse.text = difference > 0 ? `+${difference}` : String(difference);
      }
    }
    setMotion({ key: `${view.viewer}:${event.id}`, ghosts, pulses });
    timer.current = setTimeout(() => setMotion(null), LIVE_FRAME_MS);
  }, [view]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <div className="table-motion-layer" aria-hidden="true" ref={layer}>
    {motion?.pulses.map((pulse, index) => <div key={`${motion.key}:pulse:${index}`} className={`table-motion-pulse ${pulse.shuffle ? 'shuffle-pulse' : ''}`} style={{ left: pulse.rect.x, top: pulse.rect.y, width: pulse.rect.width, height: pulse.rect.height }}>
      {pulse.text && <span className="table-motion-number">{pulse.text}</span>}
    </div>)}
    {motion?.ghosts.map((ghost, index) => <div key={`${motion.key}:ghost:${index}`} className="table-motion-ghost" style={{ left: ghost.from.x, top: ghost.from.y, width: ghost.from.width, height: ghost.from.height, '--motion-x': `${ghost.to.x - ghost.from.x}px`, '--motion-y': `${ghost.to.y - ghost.from.y}px` } as CSSProperties}>
      {ghost.card ? <CardFace card={ghost.card} compact /> : <CardBack label="隐藏" />}
    </div>)}
  </div>;
}
