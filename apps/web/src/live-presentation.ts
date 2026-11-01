import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MatchView, TableView } from '../../../packages/protocol/src/index.ts';
import { eventTable } from './event-presentation.ts';

/** 一帧持续到移动和数值提示结束；服务端和模型继续独立执行。 */
export const LIVE_FRAME_MS = 680;
export interface LivePresentationState {
  latest: MatchView;
  index: number;
  frames: number[];
  holding: boolean;
  generation: number;
}
const projection = (view: MatchView) => `${view.id}:${view.viewer}`;
const restoreKinds = new Set(['system_restore', 'debug_restore']);

function visibleState(table: Pick<TableView, 'zones' | 'playerMarkers'>) {
  return JSON.stringify({
    zones: table.zones.filter(zone => !['staging', 'lost'].includes(zone.kind)).map(zone => ({
      ...zone,
      // 空卡牌组是后端的机械准备，放入第一张牌时才需要占一个动画帧。
      items: zone.items.map(item => item?.kind === 'group' && !item.stack.length && !item.attached.length ? null : item),
    })),
    playerMarkers: table.playerMarkers,
  });
}

/** 每一个可见变化单独保留，包括连续的同类 move / set_state。 */
export function liveFrameIndexes(previous: MatchView, next: MatchView): number[] {
  let before: Pick<TableView, 'zones' | 'playerMarkers'> = previous;
  const frames: number[] = [];
  for (let index = previous.events.length; index < next.events.length; index++) {
    const event = next.events[index]!;
    const table = eventTable(event);
    // 事件中的 table 已由后端按席位投影；不重放其他视角的牌面。
    if (!table || table.id !== next.id || table.viewer !== next.viewer) continue;
    if (['look', 'show', 'shuffle', 'random'].includes(event.commandKind) || visibleState(table) !== visibleState(before)) frames.push(index + 1);
    before = table;
  }
  return frames;
}

export function resetLivePresentation(view: MatchView, generation = 0): LivePresentationState {
  return { latest: view, index: view.events.length, frames: [], holding: false, generation };
}

/** 只追加未接收的事件。正在展示的帧及其计时不被后续 SSE 通知替换。 */
export function receiveLiveView(state: LivePresentationState | null, view: MatchView, animate = true): LivePresentationState {
  if (!state || !animate || projection(state.latest) !== projection(view)
    || view.events.length < state.latest.events.length
    || state.latest.events.some((event, index) => event.id !== view.events[index]?.id)
    || view.events.slice(state.latest.events.length).some(event => restoreKinds.has(event.commandKind))) {
    return resetLivePresentation(view, (state?.generation ?? 0) + 1);
  }
  const appended = liveFrameIndexes(state.latest, view);
  const frames = [...state.frames, ...appended];
  if (state.holding) return { ...state, latest: view, frames };
  if (!frames.length) return { ...state, latest: view, index: view.events.length };
  return { latest: view, index: frames[0]!, frames: frames.slice(1), holding: true, generation: state.generation + 1 };
}

export function advanceLivePresentation(state: LivePresentationState): LivePresentationState {
  const [index, ...frames] = state.frames;
  if (index === undefined) return resetLivePresentation(state.latest, state.generation + 1);
  return { ...state, index, frames, holding: true, generation: state.generation + 1 };
}

/** 展示投影与操作数据分离。这里只改变牌桌和事件前缀，不产生网络请求。 */
export function liveViewAt(view: MatchView, index: number): MatchView {
  if (index >= view.events.length) return view;
  const table = eventTable(view.events[index - 1]);
  if (!table || table.id !== view.id || table.viewer !== view.viewer) return view;
  return { ...view, ...table, events: view.events.slice(0, index) };
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const changed = () => setReduced(media.matches);
    media.addEventListener?.('change', changed);
    return () => media.removeEventListener?.('change', changed);
  }, []);
  return reduced;
}

export function useLivePresentation(view: MatchView | null, active: boolean) {
  const [state, setState] = useState<LivePresentationState | null>(null);
  const reduced = useReducedMotion();
  const live = active && !view?.replay;
  const wasLive = useRef(live);
  useEffect(() => {
    const animate = live && wasLive.current && !reduced;
    wasLive.current = live;
    setState(current => view ? receiveLiveView(current, view, animate) : null);
  }, [view, live, reduced]);
  useEffect(() => {
    if (!state?.holding || !live || reduced) return;
    const timer = setTimeout(() => setState(current => current?.holding ? advanceLivePresentation(current) : current), LIVE_FRAME_MS);
    return () => clearTimeout(timer);
    // 同一帧收到后续事件时不能重启计时。
  }, [state?.generation, state?.holding, live, reduced]);
  const sameProjection = Boolean(view && state && projection(view) === projection(state.latest));
  const displayView = useMemo(() => {
    if (!view || !live || reduced || !sameProjection || !state
      || !state.holding && !state.frames.length && view.events.length === state.latest.events.length) return view;
    return liveViewAt(state.latest, state.index);
  }, [view, live, reduced, sameProjection, state?.index, state?.latest, state?.holding, state?.frames.length]);
  const pendingSteps = live && !reduced && sameProjection && state
    ? state.frames.length + (state.holding ? 1 : 0) + (view && view.events.length > state.latest.events.length ? 1 : 0) : 0;
  const skipToLatest = useCallback(() => {
    if (view) setState(current => resetLivePresentation(view, (current?.generation ?? 0) + 1));
  }, [view]);
  return { displayView, pendingSteps, presenting: pendingSteps > 0, skipToLatest };
}
