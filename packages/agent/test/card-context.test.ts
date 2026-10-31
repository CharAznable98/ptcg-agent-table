import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, MemorySessionStore, loadPrompts } from '../src/index.ts';
import { playerInput, contextBytes } from '../src/context.ts';
import type { ModelReply, PlayerSession, PlayerFrame } from '../src/types.ts';

const card = { name: '合成卡牌', kind: 'pokemon', hp: 60, text: 'UNIQUE_CARD_TEXT_' + '牌面说明'.repeat(2000) };
function call(name: string, args: unknown, id: string): ModelReply { const arguments_ = JSON.stringify(args); return { id, model: 'test', output: [{ type: 'function_call', call_id: id, name, arguments: arguments_ }], calls: [{ callId: id, name, arguments: arguments_ }], usage: null }; }
function decode(input: Record<string, unknown>[]): Record<string, unknown>[] {
  const catalogItems = input.filter(item => item.role === 'user' && JSON.parse(item.content as string).knownCards);
  const known = Object.assign({}, ...catalogItems.map(item => JSON.parse(item.content as string).knownCards));
  const restore = (value: any): any => Array.isArray(value) ? value.map(restore) : !value || typeof value !== 'object' ? value : Object.keys(value).length === 1 && value.cardRef ? known[value.cardRef] : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v)]));
  return input.filter(item => !catalogItems.includes(item)).map(item => item.role === 'user' ? { ...item, content: restore(JSON.parse(item.content as string)) } : item.type === 'function_call_output' ? { ...item, output: restore(JSON.parse(item.output as string)) } : item);
}

test('玩家输入共享相同牌面，完整还原数量、位置与原始工具反馈', async () => {
  const store = new MemorySessionStore();
  const runtime = new AgentRuntime({ model: { async generate() { throw new Error('UNUSED'); } }, match: { async observe() { throw new Error('UNUSED'); }, async execute() { throw new Error('UNUSED'); } }, store, prompts: await loadPrompts(), trace: { async append() {} } });
  const session = await runtime.create({ matchId: 'cards', playerId: 'A', deck: { cards: [{ card, count: 60 }] }, strategy: { version: 3, content: '' }, rules: '' });
  const result = { status: 'read', data: { cards: [{ position: { zoneId: 'A:deck', index: 3 }, card }] } };
  session.messages = [{ type: 'function_call', call_id: 'read', name: 'look', arguments: '{}' }, { type: 'function_call_output', call_id: 'read', output: JSON.stringify(result) }];
  const snapshot = { viewer: 'A', ownDeck: session.deck, zones: [{ id: 'A:hand', items: [0, 1, 2].map(index => ({ kind: 'card', position: { zoneId: 'A:hand', index }, card })) }, { id: 'B:hand', items: [{ kind: 'hidden' }] }] };
  const frame = { revision: 1, snapshot } as unknown as PlayerFrame;
  const input = playerInput(session, frame, 8), text = JSON.stringify(input);
  assert.equal(text.split('UNIQUE_CARD_TEXT_').length - 1, 1, 'DUPLICATED_CARD_DEFINITIONS');
  const decoded = decode(input);
  assert.deepEqual((decoded[0]!.content as any).deck, session.deck);
  assert.deepEqual(decoded.find(item => item.type === 'function_call_output')!.output, result);
  assert.deepEqual((decoded.at(-1)!.content as any).snapshot, { viewer: snapshot.viewer, zones: snapshot.zones });
  assert.equal(session.messages[1]!.output, JSON.stringify(result), '原始反馈不得改写');
});

test('重复牌面不挤占动态历史预算，20次观察保留而无需反复压缩', async () => {
  let step = 0, compactions = 0; const sizes: number[] = [], store = new MemorySessionStore();
  const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), trace: { async append() {} },
    model: { async generate(request) { if (request.role === 'compactor') { compactions++; return call('submit_result', { text: '摘要', evidenceRefs: [] }, 'compact'); } sizes.push(contextBytes(request.input)); return call('advance', {}, `step-${step}`); } },
    match: {
      async observe(matchId, playerId, after) { return { matchId, playerId, cursor: String(step), revision: step, status: step === 20 ? 'finished' : 'active', snapshot: {}, observations: after === String(step) ? [] : [{ id: `event-${step}`, revision: step, data: { knownCard: card, step } }], tools: [{ name: 'advance', description: '确定操作', effect: 'command', inputSchema: Type.Object({}) }] }; },
      async execute() { step++; return { status: 'committed', revision: step, data: {}, continuation: 'continue' }; },
    },
  });
  await runtime.create({ matchId: 'budget', playerId: 'A', deck: { cards: [{ card, count: 60 }] }, strategy: { version: 3, content: '' }, rules: '' });
  assert.equal((await runtime.activate('budget', 'A')).status, 'finished');
  assert.equal(compactions, 0, 'CARD_COPIES_TRIGGER_COMPACTION');
  assert.ok(Math.max(...sizes) < 40_000);
  assert.equal((await store.load('budget', 'A'))!.observations.length, 21);
});
