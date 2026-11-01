import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Json, MatchView, PublicEvent } from '../../../packages/protocol/src/index.ts';
import { Match } from '../src/Match.tsx';
import { buildActionHistory } from '../src/action-history.ts';
import { actionAt, actionKeyframes, nextAction, previousActionIndex } from '../src/replay-navigation.ts';
import { view } from './fixtures.ts';

afterEach(() => vi.restoreAllMocks());
function history(): PublicEvent[] {
  return [1, 2, 3, 4].map(index => {
    const table = structuredClone(view);
    const object = table.zones.find(zone => zone.id === 'A:bench')!.items[0]!;
    if (object.kind !== 'group') throw new Error('fixture');
    object.state.damageCounters = index;
    table.revision = index;
    return { id: `event-${index}`, sequence: index, revision: index, at: '2026-11-01T00:00:00Z', actor: 'A', commandKind: 'set_state', label: '状态变化',
      action: { id: index <= 2 ? 'first' : 'second', label: index <= 2 ? '第一行动' : '第二行动' },
      data: { command: { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:bench', index: 0 } }, field: { key: 'damageCounters', value: index } }, table } as unknown as Json };
  });
}
describe('完整行动回放导航', () => {
  it('选择先攻阶段只有准备选择可用，不显示普通操牌拖拽暗示', async () => {
    const initial: MatchView = { ...structuredClone(view), flow: { ...view.flow, phase: 'setup', choice: { kind: 'choose_first', playerId: 'A' } } };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(path.includes('/events?') ? '' : JSON.stringify(initial)))));
    render(<Match id="match-test" back={() => {}} />);
    await screen.findByLabelText('牌桌视角');
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '牌桌操作' })).toBeNull();
    expect(screen.queryByRole('button', { name: '运行 AI' })).toBeNull();
  });
  it('前后导航只落在行动边界，暂停在行动内部仍能定位该行动', () => {
    const actions = buildActionHistory(history());
    expect(actions.map(action => [action.startIndex, action.endIndex])).toEqual([[0, 2], [2, 4]]);
    expect(previousActionIndex(actions, 4)).toBe(2);
    expect(previousActionIndex(actions, 2)).toBe(0);
    expect(nextAction(actions, 0)?.id).toBe(actions[0]!.id);
    expect(nextAction(actions, 3)?.id).toBe(actions[1]!.id);
    expect(nextAction(actions, 4)).toBeUndefined();
    expect(actionAt(actions, 1)?.id).toBe(actions[0]!.id);
    expect(actionAt(actions, 0)).toBeUndefined();
  });
  it('连续同类变化也逐帧展示，保留查看结果与最终状态', () => {
    const events = history();
    const action = buildActionHistory(events)[0]!;
    expect(actionKeyframes(action, events)).toEqual([1, 2]);
    events[0]!.commandKind = 'look';
    expect(actionKeyframes(action, events)).toEqual([1, 2]);
  });
  it('页面滑条使用行动数，下一步自动走到完整行动结果', async () => {
    const events = history();
    const live: MatchView = { ...structuredClone(view), revision: 4, viewer: 'omniscient', mode: 'ai_ai', players: view.players.map(player => ({ ...player, kind: 'ai' })), events };
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path.includes('/events?')) return Promise.resolve(new Response(''));
      const replay = path.includes('/replay?');
      const index = replay ? Number(new URL(path, 'http://localhost').searchParams.get('index')) : 4;
      const table = index ? (events[index - 1]!.data as unknown as { table: MatchView }).table : view;
      return Promise.resolve(new Response(JSON.stringify({ ...live, ...table, viewer: 'omniscient', mode: 'ai_ai', players: live.players, events: events.slice(0, index), ...(replay ? { replay: { index, total: 4 } } : {}) })));
    });
    vi.stubGlobal('fetch', fetch);
    render(<Match id="match-test" back={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '逐步回放' }));
    const slider = await screen.findByRole('slider', { name: '回放进度' });
    expect(slider).toHaveAttribute('max', '2');
    fireEvent.click(screen.getByRole('button', { name: '回到开始' }));
    await waitFor(() => expect(slider).toHaveValue('0'));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() => expect(slider).toHaveValue('1'));
    await waitFor(() => expect(fetch.mock.calls.some(([path]) => path.includes('/replay?') && new URL(path, 'http://localhost').searchParams.get('index') === '2')).toBe(true));
    expect(fetch.mock.calls.some(([path]) => path.includes('/replay?') && new URL(path, 'http://localhost').searchParams.get('index') === '1')).toBe(true);
    expect(screen.getByText('1 / 2 行动')).toBeInTheDocument();
  });
  it('进入回放读取期间不把旧终局横幅当作历史结果', async () => {
    const events = history();
    const completed: MatchView = { ...structuredClone(view), mode: 'ai_ai', viewer: 'omniscient', players: view.players.map(player => ({ ...player, kind: 'ai' })), events, flow: { ...view.flow, phase: 'finished', result: { kind: 'win', winner: 'A', reason: '历史终局' } } };
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => path.includes('/replay?')
      ? new Promise(() => {}) : Promise.resolve(new Response(path.includes('/events?') ? '' : JSON.stringify(completed)))));
    render(<Match id="match-test" back={() => {}} />);
    await screen.findByText('历史终局');
    fireEvent.click(screen.getByRole('button', { name: '逐步回放' }));
    expect(screen.queryByText('历史终局')).toBeNull();
    expect(screen.getAllByText('正在读取历史牌桌').length).toBeGreaterThan(0);
  });
});
