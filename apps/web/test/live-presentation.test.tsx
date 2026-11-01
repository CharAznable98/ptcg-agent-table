import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Json, MatchView, PublicEvent } from '../../../packages/protocol/src/index.ts';
import { advanceLivePresentation, LIVE_FRAME_MS, liveFrameIndexes, liveViewAt, receiveLiveView, useLivePresentation } from '../src/live-presentation.ts';
import { view } from './fixtures.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function sequence(count: number): MatchView {
  const next = structuredClone(view);
  next.events = Array.from({ length: count }, (_, offset): PublicEvent => {
    const table = structuredClone(view);
    table.revision += offset + 1;
    const target = table.zones.find(zone => zone.id === 'A:bench')!.items[0]!;
    if (target.kind !== 'group') throw new Error('fixture');
    target.state.damageCounters = offset + 3;
    return { id: `frame-${offset + 1}`, sequence: offset + 1, revision: table.revision, at: '2026-11-01T00:00:00Z', actor: 'A', commandKind: 'set_state', label: '伤害变化',
      action: { id: 'same-action', label: '完整行动' },
      data: { table, command: { kind: 'set_state', target: { kind: 'group', position: target.position }, field: { key: 'damageCounters', value: offset + 3 } } } as unknown as Json };
  });
  if (count) {
    const table = (next.events.at(-1)!.data as unknown as { table: MatchView }).table;
    next.zones = table.zones;
    next.revision = table.revision;
  }
  return next;
}
function damage(next: MatchView) {
  const target = next.zones.find(zone => zone.id === 'A:bench')!.items[0]!;
  return target.kind === 'group' ? target.state.damageCounters : -1;
}
function Harness({ next, active = true }: { next: MatchView; active?: boolean }) {
  const { displayView, pendingSteps, skipToLatest } = useLivePresentation(next, active);
  return <><output aria-label="当前伤害">{damage(displayView!)}</output><output aria-label="待展示">{pendingSteps}</output><button onClick={skipToLatest}>显示最新</button></>;
}

describe('实时逐步展示队列', () => {
  it('批量收到同一行动的连续数值操作时逐步保留，投影只使用事件中的席位快照', () => {
    const initial = sequence(0), final = sequence(3);
    expect(liveFrameIndexes(initial, final)).toEqual([1, 2, 3]);
    let state = receiveLiveView(null, initial);
    state = receiveLiveView(state, final);
    expect([state.index, state.frames, state.holding]).toEqual([1, [2, 3], true]);
    expect(damage(liveViewAt(final, state.index))).toBe(3);
    state = advanceLivePresentation(state);
    expect(damage(liveViewAt(final, state.index))).toBe(4);
    state = advanceLivePresentation(state);
    expect(damage(liveViewAt(final, state.index))).toBe(5);
    expect(advanceLivePresentation(state).holding).toBe(false);
    const foreign = sequence(1);
    (foreign.events[0]!.data as unknown as { table: MatchView }).table.viewer = 'omniscient';
    expect(liveFrameIndexes(initial, foreign)).toEqual([]);
  });
  it('新批次追加队尾，重复SSE刷新不重新展示或重启正在播放的帧', () => {
    let state = receiveLiveView(receiveLiveView(null, sequence(0)), sequence(2));
    const generation = state.generation;
    state = receiveLiveView(state, sequence(4));
    expect([state.index, state.frames, state.generation]).toEqual([1, [2, 3, 4], generation]);
    state = receiveLiveView(state, sequence(4));
    expect(state.frames).toEqual([2, 3, 4]);
    expect(state.generation).toBe(generation);
  });
  it('同一行动中的移动、连续数值变化均保留，缺失快照的旧事件不臆造中间牌桌', () => {
    const initial = sequence(0), mixed = sequence(3);
    mixed.events[0]!.commandKind = 'move';
    const first = (mixed.events[0]!.data as unknown as { table: MatchView }).table;
    first.zones.find(zone => zone.id === 'A:hand')!.items.pop();
    expect(liveFrameIndexes(initial, mixed)).toEqual([1, 2, 3]);
    mixed.events[0]!.data = { command: { kind: 'move' } };
    expect(liveFrameIndexes(initial, mixed)).toEqual([2, 3]);
  });
  it('切视角、恢复、记录分支和主动关闭动画时丢弃旧队列', () => {
    const state = receiveLiveView(receiveLiveView(null, sequence(0)), sequence(3));
    const changedViewer = { ...sequence(3), viewer: 'B' as const };
    expect(receiveLiveView(state, changedViewer).holding).toBe(false);
    expect(receiveLiveView(state, sequence(1)).holding).toBe(false);
    const restored = sequence(4); restored.events[3]!.commandKind = 'debug_restore';
    expect(receiveLiveView(state, restored).holding).toBe(false);
    expect(receiveLiveView(state, sequence(3), false).frames).toEqual([]);
  });
  it('真实React渲染按固定节奏前进，追加通知不覆盖当前画面，允许立即跳到最新', () => {
    vi.useFakeTimers();
    const rendered = render(<Harness next={sequence(0)} />);
    rendered.rerender(<Harness next={sequence(3)} />);
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('3');
    expect(screen.getByLabelText('待展示')).toHaveTextContent('3');
    act(() => vi.advanceTimersByTime(LIVE_FRAME_MS / 2));
    rendered.rerender(<Harness next={sequence(4)} />);
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('3');
    act(() => vi.advanceTimersByTime(LIVE_FRAME_MS / 2));
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('4');
    act(() => vi.advanceTimersByTime(LIVE_FRAME_MS));
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('5');
    fireEvent.click(screen.getByRole('button', { name: '显示最新' }));
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('6');
    expect(screen.getByLabelText('待展示')).toHaveTextContent('0');
    act(() => vi.advanceTimersByTime(LIVE_FRAME_MS * 3));
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('6');
  });
  it('回放模式立即展示请求的帧，恢复实时从最新开始，不重放历史积压', () => {
    vi.useFakeTimers();
    const rendered = render(<Harness next={sequence(0)} />);
    rendered.rerender(<Harness next={sequence(3)} />);
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('3');
    rendered.rerender(<Harness next={sequence(2)} active={false} />);
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('4');
    expect(screen.getByLabelText('待展示')).toHaveTextContent('0');
    rendered.rerender(<Harness next={sequence(3)} />);
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('5');
    expect(screen.getByLabelText('待展示')).toHaveTextContent('0');
  });
  it('减少动态效果偏好直接显示最新状态，不添加等待', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const rendered = render(<Harness next={sequence(0)} />);
    rendered.rerender(<Harness next={sequence(3)} />);
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('5');
    expect(screen.getByLabelText('待展示')).toHaveTextContent('0');
  });
  it('没有新增事件的快照刷新立即显示真实数值，不把旧手动伤害重新提交', () => {
    const rendered = render(<Harness next={sequence(0)} />);
    const refreshed = sequence(0), target = refreshed.zones.find(zone => zone.id === 'A:bench')!.items[0]!;
    if (target.kind !== 'group') throw new Error('fixture');
    target.state.damageCounters = 8;
    refreshed.revision++;
    rendered.rerender(<Harness next={refreshed} />);
    expect(screen.getByLabelText('当前伤害')).toHaveTextContent('8');
    expect(screen.getByLabelText('待展示')).toHaveTextContent('0');
  });
});
