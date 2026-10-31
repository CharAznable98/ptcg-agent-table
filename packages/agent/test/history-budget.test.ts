import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime, MemorySessionStore, loadPrompts } from '../src/index.ts';
import { playerInput } from '../src/context.ts';
import { historyBytes } from '../src/card-context.ts';
import type { PlayerFrame, ModelReply } from '../src/types.ts';
import { eventContext, restoreEvents } from '../src/event-context.ts';

const result = (): ModelReply => { const args = JSON.stringify({ text: '旧事实已纳入摘要，仍保留原件。', evidenceRefs: [] }); return { id: 'compact', model: 'test', output: [], calls: [{ callId: 'compact', name: 'submit_result', arguments: args }], usage: null }; };
async function setup() {
  const store = new MemorySessionStore(), runtime = new AgentRuntime({ store, prompts: await loadPrompts(), model: { async generate() { return result(); } }, trace: { async append() {} }, match: { async observe() { throw Error('UNUSED'); }, async execute() { throw Error('UNUSED'); } } });
  const session = await runtime.create({ matchId: 'budget', playerId: 'A', deck: {}, strategy: { version: 4, content: '' }, rules: '' });
  return { store, runtime, session };
}

test('摘要后活跃窗口只保留少量已消费原文，原件与未消费调用反馈仍完整保护', async () => {
  const { store, runtime, session } = await setup();
  session.observations = Array.from({ length: 12 }, (_, i) => ({ id: 'event-' + i, revision: i, data: { fact: '旧事实'.repeat(1000) } }));
  session.messages = session.observations.map(event => ({ role: 'user', content: JSON.stringify({ observations: [event] }) }));
  session.context!.deliveredMessages = session.messages.length;
  const pending = [{ type: 'function_call', call_id: 'pending', name: 'read_history', arguments: '{}' }, { type: 'function_call_output', call_id: 'pending', output: JSON.stringify({ text: '必须原样交给玩家'.repeat(3000) }) }];
  session.messages.push(...pending);
  await store.save(session); await runtime.compact('budget', 'A');
  const after = (await store.load('budget', 'A'))!;
  assert.ok(historyBytes(after.messages.slice(after.context!.wire!.historyStart, after.context!.deliveredMessages)) <= 12_000, 'SUMMARIZED_HISTORY_RETAINED_TWICE');
  assert.deepEqual(after.messages.slice(after.context!.deliveredMessages), pending);
  assert.deepEqual(after.messages, session.messages, '原始消息不能因压缩被改写');
  assert.deepEqual(after.observations, session.observations);
});

test('历史事件的相同流程不反复发送，原始观察不修改', async () => {
  const { session } = await setup();
  const flow = { phase: 'turn', turnOwner: 'A', operator: 'A', turnNumber: 8, firstPlayer: 'B', choice: null, handoffReturnTo: null, proposedResult: null, result: null };
  const observations = Array.from({ length: 30 }, (_, i) => ({ id: `event-${i}`, revision: i, data: { id: `event-${i}`, revision: i, sequence: i, at: '2026-10-30T00:00:00Z', actor: 'A', commandKind: 'declare', label: 'declare', data: { command: { kind: 'declare', text: '已完成' }, flow } } }));
  session.messages = [{ role: 'user', content: JSON.stringify({ observations }) }];
  const original = JSON.stringify(session.messages);
  const input = playerInput(session, { revision: 30, snapshot: {} } as PlayerFrame, 8);
  assert.equal(JSON.stringify(input).split('handoffReturnTo').length - 1, 1, 'FLOW_REPEATED_IN_EVERY_EVENT');
  assert.equal(JSON.stringify(session.messages), original);
});

test('事件压紧可还原别名、不同身份/版本、自定义标签和撤销信息，不误处理标记', () => {
  const flow = { phase: 'turn', turnOwner: 'A', turnNumber: 8 };
  const original = { observations: ['one', 'two'].map((id, index) => ({ id: 'e' + index, revision: index, data: { id, revision: index + 1, sequence: index, at: 'now', actor: 'A', commandKind: 'declare', label: '自定义说明', revokedBy: 'restore', data: { command: { kind: 'declare' }, flow, marker: { id: 'not-an-observation', revision: 1, event: { x: 1 } } } } })), snapshot: { flow }, arbitrary: { id: 'unrelated', revision: 4, event: { x: 3 } } };
  const packed = eventContext(original);
  assert.deepEqual(restoreEvents(packed.value, packed.eventFlows), original);
  assert.deepEqual(packed.value.snapshot, original.snapshot);
  assert.equal(Object.keys(packed.eventFlows).length, 1);
});
