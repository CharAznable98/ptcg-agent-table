import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, executeCore } from '../../../packages/game-core/src/index.ts';
import type { ModelItem } from '../../../packages/agent/src/index.ts';
import type { CardData, CommandReceipt, Entropy, GameCommand, PlayerSpec, PublicEvent, Viewer } from '../../../packages/protocol/src/index.ts';
import type { MatchMeta, MatchRecord, MatchRuntime } from '../src/match.ts';
import { committedHumanSteps } from '../src/human-action-evidence.ts';

const actionId = 'action-test';
const damage: GameCommand = { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 5 } };
const draw: GameCommand = { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } };
const step = (command: GameCommand, choiceIds: string[] = [], effectText?: string, effectStep?: string) => ({ command, choiceIds, ...(effectText ? { effectText } : {}), ...(effectStep ? { effectStep } : {}) });
function call(callId: string, name: string, args: unknown, output: unknown): ModelItem[] {
  return [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }, { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) }];
}
function fixture(): Pick<MatchRuntime, 'records' | 'meta'> {
  let identifier = 0;
  const entropy: Entropy = { uuid: () => `id-${++identifier}`, integer: () => 0 };
  const pokemon: CardData = { kind: 'pokemon', name: '合成证据测试宝可梦', hp: 80, stage: '基础', types: ['草'], abilities: [], attacks: [], weaknesses: [], resistances: [], retreatCost: 0 };
  const players = ['A', 'B'].map(id => ({ id, name: id, kind: 'human', deck: { cards: [{ card: pokemon, count: 60 }] } })) as [PlayerSpec, PlayerSpec];
  const initial = createGame({ id: 'evidence-test', players }, entropy);
  initial.flow = { phase: 'turn', turnOwner: 'A', operator: 'A', turnNumber: 1, firstPlayer: 'A', choice: null, handoffReturnTo: null, proposedResult: null, result: null };
  const first = initial.zones['A:deck']!.contents.items.shift()!;
  assert.equal(first.kind, 'card');
  initial.groups['group-1'] = { id: 'group-1', stack: [first.id], attached: [], state: { damageCounters: 2, specialConditions: [], markers: {} } };
  initial.zones['A:active']!.contents.items[0] = { kind: 'group', id: 'group-1' };
  const meta: MatchMeta = {
    createdAt: '2026-11-01T00:00:00Z', rules: '合成规则', mode: 'local',
    prompts: { schemaVersion: 1, version: 'test', player: 'test', judge: 'test', summary: 'test', compactor: 'test', toolDescriptions: {}, feedback: {} },
    model: { schemaVersion: 1, model: 'test', reasoningEffort: 'medium', fast: false, connection: { kind: 'local_codex_credentials' } },
    strategies: {}, runtime: { status: 'idle' }, summaries: {}, dispute: null, tasks: [], bonusCards: { A: [], B: [] }, revoked: {},
  };
  const records: MatchRecord[] = [{ kind: 'init', sequence: 0, state: initial, meta }];
  for (const command of [damage, draw]) {
    const before = records.at(-1)!.state;
    const result = executeCore(before, command, { kind: 'player', playerId: 'A' }, entropy);
    assert.equal(result.changed, true);
    const sequence = records.length, id = `event-${sequence}`;
    const event: PublicEvent = { id, sequence, revision: result.state.revision, at: '2026-11-01T00:00:00Z', actor: 'A', commandKind: command.kind, label: command.kind, data: {}, action: { id: actionId, label: '合成行动' } };
    records.push({ kind: 'commit', sequence, actor: { kind: 'player', playerId: 'A' }, request: { requestId: `request-${sequence}`, revision: before.revision, command }, receipt: { status: 'committed', eventId: id, revision: result.state.revision, result: result.result }, event: { A: event, B: structuredClone(event), omniscient: structuredClone(event) } as Record<Viewer, PublicEvent>, state: result.state, meta });
  }
  return { records, meta };
}
const receipt = (match: Pick<MatchRuntime, 'records'>, index: number): CommandReceipt => match.records[index]!.receipt!;

test('旧原子回执关联真实提交，返回原始前态而不是当前牌桌', () => {
  const match = fixture();
  const messages = call('atomic', 'execute_atomic', step(damage, ['target', 'number'], '合成放置说明'), receipt(match, 1));
  const entries = committedHumanSteps(match, actionId, messages);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.choiceIds, ['target', 'number']);
  assert.equal(entries[0]!.before, match.records[0]!.state);
  assert.equal(entries[0]!.before.groups['group-1']!.state.damageCounters, 2);
  assert.equal(entries[0]!.record.state.groups['group-1']!.state.damageCounters, 5);
  assert.equal(entries[0]!.effectText, '合成放置说明');
});

test('序列部分提交只恢复对应成功步骤，拒绝项和未执行项不产生证据', () => {
  const match = fixture();
  const messages = call('sequence', 'execute_sequence', { steps: [step(damage, ['damage-count']), step(draw, ['draw-count'])], finish: false },
    { status: 'stopped', executedSteps: 1, receipts: [receipt(match, 1), { status: 'rejected', reason: '测试拒绝' }] });
  const entries = committedHumanSteps(match, actionId, messages);
  assert.deepEqual(entries.map(entry => entry.record.event!.A.id), ['event-1']);
  assert.deepEqual(entries[0]!.choiceIds, ['damage-count']);
});

test('完整序列和混合旧原子按真实提交顺序输出，重复回执只算一次', () => {
  const match = fixture();
  const messages = [
    ...call('draw', 'execute_atomic', step(draw, ['draw-count'], '合成抽取说明', '合成抽取步骤'), receipt(match, 2)),
    ...call('sequence', 'execute_sequence', { steps: [step(damage, ['damage-count']), step(draw, ['draw-count'], '合成抽取说明', '合成抽取步骤')], finish: true }, { status: 'completed', executedSteps: 2, receipts: [receipt(match, 1), receipt(match, 2)] }),
  ];
  messages.push(structuredClone(messages[1]!));
  const entries = committedHumanSteps(match, actionId, messages);
  assert.deepEqual(entries.map(entry => entry.record.event!.A.id), ['event-1', 'event-2']);
  assert.equal(entries[1]!.before, match.records[1]!.state);
  assert.equal(entries[1]!.effectStep, '合成抽取步骤');
});

test('撤销、错行动、错命令和伪造回执均不能恢复消费记录', async t => {
  for (const kind of ['revoked', 'event-revoked', 'receipt-revoked', 'other-action', 'wrong-command', 'missing-event', 'wrong-revision', 'unknown', 'not-executed', 'missing-before'] as const) await t.test(kind, () => {
    const match = fixture(); let request = step(damage, ['count']);
    let output: unknown = receipt(match, 1);
    if (kind === 'revoked') match.meta.revoked['event-1'] = 'restore';
    if (kind === 'event-revoked') match.records[1]!.event!.A.revokedBy = 'restore';
    if (kind === 'receipt-revoked') (match.records[1]!.receipt as Extract<CommandReceipt, { status: 'committed' }>).revokedBy = 'restore';
    if (kind === 'other-action') match.records[1]!.event!.A.action!.id = 'different';
    if (kind === 'wrong-command') request = step({ ...damage, field: { key: 'damageCounters', value: 6 } }, ['count']);
    if (kind === 'missing-event') output = { ...receipt(match, 1), eventId: 'invented-event' };
    if (kind === 'wrong-revision') output = { ...receipt(match, 1), revision: 999 };
    if (kind === 'unknown') output = { status: 'unknown', eventId: 'event-1', revision: 1 };
    if (kind === 'not-executed') output = { status: 'not_executed', eventId: 'event-1', revision: 1 };
    if (kind === 'missing-before') match.records = [match.records[1]!];
    assert.deepEqual(committedHumanSteps(match, actionId, call('atomic', 'execute_atomic', request, output)), []);
  });
});

test('同一提交的相互矛盾选择绑定没有唯一解释，不选择其中一份充当授权', () => {
  const match = fixture();
  const messages = [...call('one', 'execute_atomic', step(damage, ['first-choice']), receipt(match, 1)), ...call('two', 'execute_atomic', step(damage, ['second-choice']), receipt(match, 1))];
  assert.deepEqual(committedHumanSteps(match, actionId, messages), []);
});

test('无效JSON和畸形选择引用被忽略，证据提取不修改调用记录或快照', () => {
  const match = fixture();
  const messages: ModelItem[] = [
    { type: 'function_call', name: 'execute_atomic', call_id: 'bad', arguments: '{' },
    { type: 'function_call_output', call_id: 'bad', output: '{' },
    ...call('duplicate', 'execute_atomic', step(damage, ['same', 'same']), receipt(match, 1)),
    ...call('invalid', 'execute_atomic', { command: damage, choiceIds: ['ok', 2] }, receipt(match, 1)),
    ...call('valid', 'execute_atomic', step(draw, ['draw']), receipt(match, 2)),
  ];
  const original = structuredClone({ match, messages });
  assert.deepEqual(committedHumanSteps(match, actionId, messages).map(entry => entry.command), [draw]);
  assert.deepEqual({ match, messages }, original);
});
