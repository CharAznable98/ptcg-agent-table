import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MatchView } from '../../../packages/protocol/src/index.ts';
import { Match } from '../src/Match.tsx';
import { view } from './fixtures.ts';

afterEach(() => vi.restoreAllMocks());
describe('手动兜底的连续状态调整', () => {
  it('开始直接操牌时收起固定详情，目标区域保持可用', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(path.includes('/events?') ? '' : JSON.stringify(view)))));
    await act(async () => { render(<Match id="match-test" back={() => {}} />); });
    const source = await screen.findByRole('button', { name: '查看A · 手牌 第 1 位叶芽' });
    fireEvent.click(source);
    expect(screen.getByRole('dialog', { name: '卡牌详情' })).toBeInTheDocument();
    fireEvent.keyDown(source, { key: ' ' });
    expect(screen.queryByRole('dialog', { name: '卡牌详情' })).toBeNull();
    expect(source).toHaveAttribute('aria-grabbed', 'true');
    fireEvent.keyDown(source, { key: 'Escape' });
    expect(source).toHaveAttribute('aria-grabbed', 'false');
  });
  it('同一组连续增加伤害不要求重新选择，后续命令使用实际新版本', async () => {
    const current: MatchView = structuredClone(view);
    const group = current.zones.find(zone => zone.id === 'A:bench')!.items[0]!;
    if (group.kind !== 'group') throw new Error('fixture');
    group.state.damageCounters = 0;
    const submitted: { revision: number; command: { kind: string; target: unknown; field: { key: string; value: number } } }[] = [];
    const fetch = vi.fn().mockImplementation((path: string, options?: RequestInit) => {
      if (path.includes('/events?')) return Promise.resolve(new Response(''));
      if (path.endsWith('/commands')) {
        const input = JSON.parse(String(options!.body));
        submitted.push(input);
        group.state.damageCounters = input.command.field.value;
        current.revision++;
        return Promise.resolve(new Response(JSON.stringify({ status: 'committed', eventId: `manual-${submitted.length}`, revision: current.revision, result: {} })));
      }
      return Promise.resolve(new Response(JSON.stringify(current)));
    });
    vi.stubGlobal('fetch', fetch);
    // 先收敛首次加载与席位初始化，再检验连续操作期间的选择和版本。
    await act(async () => { render(<Match id="match-test" back={() => {}} />); });
    fireEvent.click(await screen.findByLabelText('行动更多操作'));
    fireEvent.click(screen.getByRole('button', { name: '手动调整' }));
    await screen.findByRole('button', { name: '结束调整' });
    fireEvent.click(screen.getByRole('button', { name: '查看A · 备战区 第 1 位卡牌组' }));
    fireEvent.click(await screen.findByRole('button', { name: /增加10伤害$/ }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /增加10伤害$/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /增加10伤害$/ }));
    await waitFor(() => expect(submitted).toHaveLength(2));
    expect(submitted.map(input => input.command.field.value)).toEqual([1, 2]);
    expect(submitted[1]!.revision).toBe(submitted[0]!.revision + 1);
    expect(submitted.map(input => input.command.target)).toEqual([
      { kind: 'group', position: { zoneId: 'A:bench', index: 0 } },
      { kind: 'group', position: { zoneId: 'A:bench', index: 0 } },
    ]);
    expect(fetch.mock.calls.some(([path]) => path.endsWith('/actions'))).toBe(false);
  });
});
