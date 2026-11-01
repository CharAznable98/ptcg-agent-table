import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Match } from '../src/Match.tsx';
import { view } from './fixtures.ts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('实时人类牌桌激活', () => {
  it('实时打开显式POST一次，刷新投影和历史读取不再次激活', async () => {
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('/events?')) return new Response('');
      if (url.endsWith('/actions/activate')) return new Response('null');
      const snapshot = url.includes('/replay?') ? { ...view, replay: { index: 0, total: 0 } } : view;
      return new Response(JSON.stringify(snapshot));
    });
    vi.stubGlobal('fetch', fetch);
    const activateCalls = () => fetch.mock.calls.filter(([url]) => url.endsWith('/actions/activate'));
    const component = render(<Match id="match-test" back={() => {}} />);
    await waitFor(() => expect(activateCalls()).toHaveLength(1));
    expect(activateCalls()[0]![1]?.method).toBe('POST');
    expect(JSON.parse(String(activateCalls()[0]![1]?.body))).toEqual({ playerId: 'A' });
    await act(async () => {});
    component.rerender(<Match id="match-test" back={() => {}} />);
    expect(activateCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '逐步回放' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('/replay?'))).toBe(true));
    expect(activateCalls()).toHaveLength(1);
  });
  it('全知AI观战不激活人类自动流程', async () => {
    const spectator = { ...view, mode: 'ai_ai', viewer: 'omniscient', players: view.players.map(player => ({ ...player, kind: 'ai' })) };
    const fetch = vi.fn(async (url: string) => new Response(url.includes('/events?') ? '' : JSON.stringify(spectator)));
    vi.stubGlobal('fetch', fetch);
    await act(async () => { render(<Match id="match-test" back={() => {}} />); });
    expect(await screen.findByLabelText('牌桌视角')).toHaveValue('omniscient');
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/actions/activate'))).toBe(false);
  });
});
