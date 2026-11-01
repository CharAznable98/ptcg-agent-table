import test from 'node:test';
import assert from 'node:assert/strict';
import { createHumanActionContext, humanActionInput, type HumanContextSource } from '../src/human-action-context.ts';
import { applySnapshotUpdates } from '../../../packages/agent/src/context.ts';
import type { ModelItem } from '../../../packages/agent/src/types.ts';

const user = (value: unknown): ModelItem => ({ role: 'user', content: JSON.stringify(value) });
const card = { kind: 'pokemon', name: '合成牌面', hp: 90, text: '合成牌文'.repeat(200) };
const snapshot = (turnNumber = 10) => ({ flow: { phase: 'turn', turnNumber }, zones: [{ id: 'A:active', items: [{ kind: 'group', stack: [{ card }], state: { damageCounters: 0 } }] }], inPlayFacts: [{ lineageRef: 'g_current', firstInPlay: { eventId: 'old-first', turnNumber: 2 } }] });
const event = (n: number, turnNumber: number) => ({ id: `e${n}`, revision: n, data: { id: `e${n}`, sequence: n, at: '2026-01-01T00:00:00Z', actor: 'A', label: 'declare', revision: n, commandKind: 'declare', data: { command: { kind: 'declare', text: '合成记录'.repeat(100) }, flow: { turnNumber }, observedCards: [{ card }] } } });
const setup = () => [user({ stage: 'human_action_rules', rules: '合成规则' }), user({ stage: 'human_action_setup', intent: { kind: 'ability' }, sourceCard: card })];
const frame = (revision: number, observations = [event(revision, 10)], table = snapshot()) => user({ stage: 'human_action', revision, snapshot: table, observations, choices: [] });
const decoded = (input: ModelItem[]) => input.filter(x => x.role === 'user').map(x => JSON.parse(x.content as string));

test('human沿用AI目录与快照增量，输入前缀稳定且不反复追加完整牌桌', () => {
  const state: HumanContextSource = { messages: [...setup(), frame(100)], context: createHumanActionContext() };
  const first = humanActionInput(state, () => ({}));
  const changed = snapshot(); changed.zones[0]!.items[0]!.state.damageCounters = 3;
  state.messages.push({ type: 'function_call', call_id: 'c1', name: 'execute_atomic', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: '{"status":"committed"}' }, frame(101, [event(101, 10)], changed));
  const second = humanActionInput(state, () => ({}));
  assert.deepEqual(second.slice(0, first.length), first);
  const values = decoded(second);
  assert.equal(values.filter(x => x.snapshot).length, 1);
  assert.equal(values.filter(x => x.knownCards).length, 1);
  assert.ok(values.some(x => x.snapshotUpdates));
  const anchor = values.find(x => x.snapshot).snapshot;
  const result = values.filter(x => x.snapshotUpdates).reduce((prev, x) => applySnapshotUpdates(prev, x.snapshotUpdates), anchor);
  // 卡文已共享成cardRef，状态和在场时点仍必须精确恢复。
  assert.equal(result.zones[0].items[0].state.damageCounters, 3);
  assert.equal(result.inPlayFacts[0].firstInPlay.eventId, 'old-first');
});

test('新行动只送当前及前一回合观察，明确保留旧历史读取位置', () => {
  const history = Array.from({ length: 500 }, (_, n) => event(n, n < 480 ? 2 : n < 490 ? 9 : 10));
  const state: HumanContextSource = { messages: [...setup(), frame(500, history)], context: createHumanActionContext() };
  const input = humanActionInput(state, () => ({}));
  const values = decoded(input), context = values.find(x => x.stage === 'human_action');
  assert.equal(context.observations.length, 20);
  assert.equal(context.historyCoverage.older.lastEventId, 'e479');
  assert.ok(JSON.stringify(input).length < JSON.stringify(state.messages).length / 5);
  assert.equal(history.length, 500, '原始消息不得改变');
});

test('旧状态迁移直接使用权威review和最新牌桌，不再重编码海量旧消息', () => {
  const messages = [...setup(), ...Array.from({ length: 100 }, (_, n) => frame(n, [event(n, 2)])), frame(100)];
  const state: HumanContextSource = { messages };
  const review = { choices: [{ choiceId: 'number', number: 3, applied: 2 }], committedSteps: [{ eventId: 'valid' }] };
  const input = humanActionInput(state, () => review);
  assert.equal(decoded(input).filter(x => x.snapshot).length, 1);
  assert.ok(decoded(input).some(x => x.actionReview?.choices?.[0]?.applied === 2));
  assert.ok(input.length < 12);
  assert.equal(messages.length, 103);
});

test('修正review锚点不可变，后续进度只追加差量，重启保持相同前缀', () => {
  const state: HumanContextSource = { messages: [...setup(), frame(1)], context: createHumanActionContext(), recovery: { messageStart: 2 } };
  let review = { choices: [{ choiceId: 'n', number: 13, applied: 4 }], committedSteps: [{ eventId: 'a' }] };
  const first = humanActionInput(state, () => review);
  state.messages.push(frame(2)); review = { ...review, committedSteps: [...review.committedSteps, { eventId: 'b' }] };
  const second = humanActionInput(state, () => review);
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(decoded(second).filter(x => x.actionReview).length, 1);
  assert.equal(decoded(second).filter(x => x.reviewUpdates).length, 1);
  const resumed = structuredClone(state);
  assert.deepEqual(humanActionInput(resumed, () => review), second);
});

test('重复观察去重但撤销更新保留，公开身份重新隐藏时完整替换区域', () => {
  const state: HumanContextSource = { messages: [...setup(), frame(1)], context: createHumanActionContext() };
  humanActionInput(state, () => ({}));
  const hidden = snapshot(); (hidden.zones[0]!.items as unknown[]) = [{ kind: 'hidden' }];
  const revoked = { ...event(1, 10), data: { ...event(1, 10).data, revokedBy: 'restore' } };
  state.messages.push(frame(2, [revoked, event(2, 10)], hidden));
  const values = decoded(humanActionInput(state, () => ({}))), last = values.filter(x => x.stage === 'human_action').at(-1);
  assert.equal(last.observations.length, 2);
  assert.equal(last.observations[0].event.revokedBy, 'restore');
  const changed = last.snapshotUpdates[0];
  assert.deepEqual(changed.value.items, [{ kind: 'hidden' }]);
  assert.equal(JSON.stringify(changed.value).includes('cardRef'), false);
});

test('显式读取旧历史首次完整提供，再读只引用模型段内已经可达的来源', () => {
  const state: HumanContextSource = { messages: [...setup(), frame(100)], context: createHumanActionContext() };
  humanActionInput(state, () => ({}));
  const receipt = { status: 'read', revision: 100, data: { entries: [event(1, 1).data], cursor: '1', hasMore: false } };
  const request = (id: string) => [
    { type: 'function_call', call_id: id, name: 'read_history', arguments: '{"before":"e100","limit":1}' },
    { type: 'function_call_output', call_id: id, output: JSON.stringify(receipt) },
  ];
  state.messages.push(...request('h1'), frame(100));
  const first = humanActionInput(state, () => ({}));
  const firstReceipt = JSON.parse(first.find(x => x.type === 'function_call_output' && x.call_id === 'h1')!.output as string);
  assert.deepEqual(firstReceipt.data.evidenceRefs, ['e1']);
  assert.equal(decoded(first).find(x => x.retrievedObservations).retrievedObservations[0].id, 'e1');
  state.messages.push(...request('h2'), frame(100));
  const second = humanActionInput(state, () => ({}));
  assert.deepEqual(second.slice(0, first.length), first);
  const reread = JSON.parse(second.find(x => x.type === 'function_call_output' && x.call_id === 'h2')!.output as string);
  assert.equal(reread.data.entries, undefined);
  assert.deepEqual(reread.data.evidenceRefs, ['e1']);
  assert.equal(reread.data.cursor, '1');
  assert.deepEqual(JSON.parse(state.messages.find(x => x.call_id === 'h2' && x.type === 'function_call_output')!.output as string), receipt);
});

test('修正历史共享事件目录，追加一步仅增加一个进度项，重新审查开始新段', () => {
  const state: HumanContextSource = { messages: [...setup(), frame(100)], context: createHumanActionContext(), recovery: { messageStart: 2 } };
  let review = { relatedHistory: [event(98, 9).data, event(99, 9).data], committedSteps: [{ eventId: 'e98' }] };
  const first = humanActionInput(state, () => review), anchor = decoded(first).find(x => x.actionReview);
  assert.deepEqual(anchor.actionReview.relatedHistory, [{ observationRef: 'e98' }, { observationRef: 'e99' }]);
  assert.ok(anchor.retrievedObservations[0].event.data.flow.flowRef);
  review = { relatedHistory: [...review.relatedHistory, event(101, 10).data], committedSteps: [...review.committedSteps, { eventId: 'e101' }] };
  state.messages.push(frame(101));
  const second = humanActionInput(state, () => review), updates = decoded(second).findLast(x => x.reviewUpdates).reviewUpdates;
  assert.ok(updates.some((x: any) => x.path.join('.') === 'committedSteps.1'));
  assert.equal(updates.some((x: any) => x.path.join('.') === 'committedSteps'), false);
  state.recovery!.messageStart = state.messages.length;
  state.messages.push(frame(102));
  const nextSegment = humanActionInput(state, () => review);
  assert.equal(decoded(nextSegment).filter(x => x.snapshot).length, 1);
  assert.equal(decoded(nextSegment).filter(x => x.actionReview).length, 1);
  assert.equal(decoded(nextSegment).filter(x => x.stage === 'human_action').length, 1);
});
