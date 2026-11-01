import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupView, MatchView } from '../../../packages/protocol/src/index.ts';
import { Match } from '../src/Match.tsx';
import { view } from './fixtures.ts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function match(status: 'failed' | 'cancelled', requiresResolution: boolean): MatchView {
  const current = structuredClone(view);
  current.humanAction = { id: 'unfinished', playerId: 'A', intent: { kind: 'play', source: { zoneId: 'A:hand', index: 0 } },
    label: '使用合成效果', status, revision: current.revision, eventIds: requiresResolution ? ['committed'] : [],
    requiresResolution, ...(status === 'failed' ? { error: '后续处理失败' } : {}) };
  const group = current.zones.find(zone => zone.id === 'A:bench')!.items[0] as GroupView;
  const top = group.stack[0]!;
  if (top.kind !== 'card' || top.card.kind !== 'pokemon') throw new Error('fixture');
  top.card.abilities = [{ name: '合成特性', text: '合成效果' }];
  current.zones.push(...(['A', 'B'] as const).map(playerId => ({
    id: `${playerId}:active`, kind: 'active' as const, playerId, layout: 'slots' as const,
    defaultVisibility: { mode: 'public' as const }, items: [{ ...structuredClone(group), position: { zoneId: `${playerId}:active`, index: 0 } }],
  })));
  return current;
}

async function open(current: MatchView) {
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.includes('/events?')) return new Response('');
    if (path.endsWith('/actions/activate')) return new Response('null');
    if (path.endsWith('/control')) {
      const control = JSON.parse(String(options!.body));
      current.humanAction = { ...current.humanAction!, status: ['cancel', 'manual'].includes(control.action) ? 'cancelled' : 'running' };
      return new Response(JSON.stringify(current.humanAction));
    }
    return new Response(JSON.stringify(current));
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () => { render(<Match id={current.id} back={() => {}} />); });
  const warning = screen.queryByRole('alertdialog');
  if (warning) fireEvent.click(screen.getByRole('button', { name: '确认' }));
  return fetch;
}

describe('未完成结算', () => {
  for (const status of ['failed', 'cancelled'] as const) it(`${status} 后有已提交效果时，锁新行动并保留原行动的修正入口`, async () => {
    const fetch = await open(match(status, true));
    expect(screen.getByRole('button', { name: '结束回合' })).toBeDisabled();
    const source = screen.getByRole('button', { name: '查看A · 手牌 第 1 位叶芽' });
    expect(source).toHaveAttribute('draggable', 'false');
    fireEvent.keyDown(source, { key: ' ' });
    expect(source).not.toHaveAttribute('aria-grabbed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '查看A · 战斗场 第 1 位卡牌组' }));
    expect(screen.getByRole('button', { name: '使用招式撞击' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '使用特性合成特性' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭宝可梦' }));
    expect(screen.getByLabelText('牌桌处理状态')).toHaveTextContent('结算未完成');
    fireEvent.click(screen.getByRole('button', { name: '代理修正' }));
    await waitFor(() => expect(fetch.mock.calls.some(([path]) => path.endsWith('/unfinished/control'))).toBe(true));
    const [, options] = fetch.mock.calls.find(([path]) => path.endsWith('/unfinished/control'))!;
    expect(JSON.parse(String(options!.body)).action).toBe('retry');
    expect(fetch.mock.calls.some(([path]) => path.endsWith('/actions'))).toBe(false);
  });

  it('无副作用的合法性拒绝允许玩家改行动', async () => {
    await open(match('failed', false));
    expect(screen.getByRole('button', { name: '结束回合' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '查看A · 手牌 第 1 位叶芽' })).toHaveAttribute('draggable', 'true');
    expect(screen.queryByText('结算未完成')).toBeNull();
  });

  it('代理完成结算后解除限制，下一次行动不继承旧锁', async () => {
    const current = match('failed', true);
    const fetch = await open(current);
    fetch.mockImplementation(async (path: string) => {
      if (path.includes('/events?')) return new Response('');
      if (path.endsWith('/control')) {
        current.humanAction = { ...current.humanAction!, status: 'completed', requiresResolution: false, error: undefined };
        return new Response(JSON.stringify(current.humanAction));
      }
      return new Response(JSON.stringify(current));
    });
    fireEvent.click(screen.getByRole('button', { name: '代理修正' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '结束回合' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '查看A · 手牌 第 1 位叶芽' })).toHaveAttribute('draggable', 'true');
    expect(screen.queryByText('结算未完成')).toBeNull();
  });

  it('显式手动调整可用，退出后仍须结算；继续代理前先退出手动模式', async () => {
    const fetch = await open(match('failed', true));
    fireEvent.click(screen.getByLabelText('行动更多操作'));
    fireEvent.click(screen.getByRole('button', { name: '手动调整' }));
    await screen.findByRole('button', { name: '结束调整' });
    const source = screen.getByRole('button', { name: '查看A · 手牌 第 1 位叶芽' });
    expect(source).toHaveAttribute('draggable', 'true');
    fireEvent.click(screen.getByRole('button', { name: '结束调整' }));
    expect(source).toHaveAttribute('draggable', 'false');
    expect(screen.getByRole('button', { name: '结束回合' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '代理修正' }));
    await screen.findByRole('button', { name: '停止' });
    const controls = fetch.mock.calls.filter(([path]) => path.endsWith('/unfinished/control'));
    expect(controls.map(([, options]) => JSON.parse(String(options!.body)).action)).toEqual(['manual', 'retry']);
  });
});
