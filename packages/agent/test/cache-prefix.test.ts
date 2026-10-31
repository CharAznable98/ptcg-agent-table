import test from 'node:test';
import assert from 'node:assert/strict';
import { playerInput } from '../src/context.ts';
import { restoreEvents } from '../src/event-context.ts';
import type { ModelItem, PlayerFrame, PlayerSession } from '../src/types.ts';

const card = (name: string) => ({ name, kind: 'pokemon', hp: 60, text: '合成牌面资料'.repeat(30) });
const event = (id: number, turn: number, face?: unknown) => ({ id: `event-${id}`, revision: id, data: { id: `event-${id}`, revision: id, sequence: id, at: '2026-10-30T00:00:00Z', actor: 'A', commandKind: 'declare', label: 'declare', data: { command: { kind: 'declare', text: '完成' }, flow: { phase: 'turn', turnOwner: 'A', turnNumber: turn }, ...(face ? { observedCard: face } : {}) } } });
const user = (content: unknown): ModelItem => ({ role: 'user', content: JSON.stringify(content) });
const frame = { revision: 5, snapshot: {} } as PlayerFrame;
const session = (messages: ModelItem[]) => ({ playerId: 'A', deck: { cards: [{ count: 60, card: card('己方') }] }, strategy: { version: 1, content: '保持资源' }, messages } as unknown as PlayerSession);

function restore(input: ModelItem[]) {
  const cards: Record<string, unknown> = {}, flows: Record<string, unknown> = {};
  const rows = input.map(item => {
    const field = item.role === 'user' ? 'content' : item.type === 'function_call_output' ? 'output' : null;
    return { item, field, value: field ? JSON.parse(item[field] as string) : null };
  });
  for (const { value } of rows) { Object.assign(cards, value?.knownCards); Object.assign(flows, value?.eventFlows); }
  const expand = (value: any): any => Array.isArray(value) ? value.map(expand) : !value || typeof value !== 'object' ? value : Object.keys(value).length === 1 && value.cardRef ? structuredClone(cards[value.cardRef]) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  return rows.filter(row => !row.value?.knownCards && !row.value?.eventFlows).map(({ item, field, value }) => {
    if (!field) return item;
    const { observationFormat: _format, ...body } = value;
    return { ...item, [field]: expand(restoreEvents(body, flows)) };
  });
}

test('新增牌面、流程和第二次相同流程不会改写已有历史前缀', () => {
  const s = session([user({ observations: [event(1, 1)] })]);
  const first = playerInput(s, frame, 8);
  s.messages.push(user({ observations: [event(2, 1, card('对方新牌'))] }));
  const second = playerInput(s, frame, 8);
  assert.deepEqual(second.slice(0, first.length), first, 'EXISTING_PREFIX_REWRITTEN_ON_CARD_OR_FLOW_DISCOVERY');
  s.messages.push(user({ observations: [event(3, 2)] }));
  const third = playerInput(s, frame, 8);
  assert.deepEqual(third.slice(0, second.length), second, 'EXISTING_PREFIX_REWRITTEN_ON_NEW_TURN');
});

test('增量资料完整还原工具牌面和观察，不打断原生调用反馈', () => {
  const feedback = { status: 'read', card: card('查看所得') };
  const pair = [{ type: 'function_call', call_id: 'look', name: 'look', arguments: '{}' }, { type: 'function_call_output', call_id: 'look', output: JSON.stringify(feedback) }];
  const s = session([user({ observations: [event(1, 1)] }), ...pair, user({ observations: [event(2, 2, card('公开所得'))] })]);
  const input = playerInput(s, frame, 8), original = structuredClone(s);
  const callAt = input.findIndex(item => item.type === 'function_call');
  assert.equal(input[callAt + 1]!.type, 'function_call_output');
  const restored = restore(input);
  const decoded = s.messages.map(item => item.role === 'user' ? { ...item, content: JSON.parse(item.content as string) } : item.type === 'function_call_output' ? { ...item, output: JSON.parse(item.output as string) } : item);
  assert.deepEqual(restored.slice(1, -1), decoded);
  assert.deepEqual((restored[0]!.content as any).deck, s.deck);
  assert.deepEqual(s, original);
});
