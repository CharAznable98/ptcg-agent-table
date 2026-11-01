import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandReceipt, GameCommand, PlayerId } from '../../../packages/protocol/src/index.ts';
import { GameService } from '../src/service.ts';
import { MatchRuntime } from '../src/match.ts';
import { humanActionRecoveryPoints } from '../src/human-action-recovery.ts';
import { seedHumanScenario } from '../../../scripts/human-action-fixtures.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-action-recovery-'));
  const service = new GameService({ dataDir: join(directory, 'data'), systemDir: join(directory, 'system'), modelFactory: () => ({ async generate() { throw new Error('恢复牌桌不应请求模型'); } }) });
  await service.init();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const match = await seedHumanScenario(service, 'recovery');
  const action = { id: randomUUID(), label: '合成完整行动' };
  match.lockHumanAction({ ...action, playerId: 'A' });
  const command = async (playerId: PlayerId, command: GameCommand, tagged = playerId === 'A') => {
    const receipt = await match.command(playerId, { requestId: randomUUID(), revision: match.state.revision, command }, tagged ? action : undefined);
    assert.equal(receipt.status, 'committed', JSON.stringify(receipt)); return receipt as Extract<CommandReceipt, { status: 'committed' }>;
  };
  const restore = (beforeEventId: string, requestId = randomUUID(), revision = match.state.revision, reason = '合成步骤执行错误，恢复后沿用人类选择重新结算') => match.restoreHumanAction('A', { requestId, revision, beforeEventId, reason }, action);
  return { directory, match, action, command, restore };
}
const damage = (value: number): GameCommand => ({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value } });
const draw = (playerId: PlayerId): GameCommand => ({ kind: 'move', source: { container: { kind: 'zone', zoneId: `${playerId}:deck` }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: `${playerId}:hand` }, index: 'end' } });

test('行动恢复追加历史、撤销本行动后续步骤，保留已披露牌面及单调版本', async t => {
  const { match, action, command, restore } = await fixture(t), before = structuredClone(match.state);
  const first = await command('A', { kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 1 } } });
  const second = await command('A', damage(4));
  const points = humanActionRecoveryPoints(match, 'A', action.id);
  assert.deepEqual(points.map(point => point.eventId), [first.eventId, second.eventId]);
  assert.equal(points[0]!.revision, before.revision);
  const raw = await readFile(match.journal.path, 'utf8'), previousRevision = match.state.revision;
  const result = await restore(first.eventId);
  assert.equal(result.status, 'committed'); if (result.status !== 'committed') return;
  assert.deepEqual(result.result, { restoredBefore: first.eventId, revokedEvents: [first.eventId, second.eventId], reason: '合成步骤执行错误，恢复后沿用人类选择重新结算' });
  assert.equal(match.state.revision, previousRevision + 1);
  assert.deepEqual({ ...match.state, revision: before.revision }, before);
  assert.equal((await readFile(match.journal.path, 'utf8')).startsWith(raw), true);
  assert.equal(match.meta.revoked[first.eventId], result.eventId); assert.equal(match.meta.revoked[second.eventId], result.eventId);
  const history = match.history('A').entries;
  assert.ok(JSON.stringify(history.find(event => event.id === first.eventId)!.data).includes('reveals'));
  assert.equal(history.find(event => event.id === first.eventId)!.revokedBy, result.eventId);
  assert.equal(history.at(-1)!.commandKind, 'system_restore'); assert.deepEqual(history.at(-1)!.action, action);
  assert.deepEqual(humanActionRecoveryPoints(match, 'A', action.id), [], '恢复操作自身不能作为恢复点反向恢复坏状态');
});

test('同一恢复请求在重启后返回原回执，不二次回滚；修改原因或跨席位不能复用标识', async t => {
  const { match, action, command, restore } = await fixture(t);
  const first = await command('A', damage(4)), requestId = randomUUID(), revision = match.state.revision;
  const result = await restore(first.eventId, requestId, revision);
  const recovered = new MatchRuntime({ directory: match.directory }); await recovered.recover(); recovered.lockHumanAction({ ...action, playerId: 'A' });
  const length = recovered.records.length;
  const input = { requestId, revision, beforeEventId: first.eventId, reason: '合成步骤执行错误，恢复后沿用人类选择重新结算' };
  assert.deepEqual(await recovered.restoreHumanAction('A', input, action), result); assert.equal(recovered.records.length, length);
  await assert.rejects(recovered.restoreHumanAction('A', { ...input, reason: '换成不同的恢复请求' }, action), { code: 'REQUEST_ID_CONFLICT' });
  recovered.lockHumanAction({ ...action, playerId: 'B' });
  await assert.rejects(recovered.restoreHumanAction('B', input, action), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(recovered.records.length, length);
});

test('局部恢复保留更早的正确步骤，修正后仍可恢复到更早有效点', async t => {
  const { match, action, command, restore } = await fixture(t);
  const first = await command('A', damage(4)), second = await command('A', damage(5)), third = await command('A', damage(6));
  const recovered = await restore(second.eventId); assert.equal(recovered.status, 'committed');
  assert.equal(match.state.groups['practice:A:active:0']!.state.damageCounters, 4);
  assert.equal(match.meta.revoked[first.eventId], undefined); assert.ok(match.meta.revoked[second.eventId]); assert.ok(match.meta.revoked[third.eventId]);
  const corrected = await command('A', damage(7));
  assert.deepEqual(humanActionRecoveryPoints(match, 'A', action.id).map(point => point.eventId), [first.eventId, corrected.eventId]);
  assert.equal((await restore(first.eventId)).status, 'committed');
  assert.equal(match.state.groups['practice:A:active:0']!.state.damageCounters, 0);
});

test('恢复已落盘但提交反馈丢失，重启按同一请求收敛而不重复恢复', async t => {
  const { match, action, command, restore } = await fixture(t);
  const first = await command('A', damage(4)), requestId = randomUUID(), revision = match.state.revision;
  const append = match.journal.append.bind(match.journal);
  match.journal.append = async record => {
    await append(record);
    if (record.request?.requestId === requestId) throw new Error('合成提交反馈丢失');
  };
  await assert.rejects(restore(first.eventId, requestId, revision), { code: 'STORAGE_UNCERTAIN' });
  assert.equal(match.storageFaulted, true);
  const recovered = new MatchRuntime({ directory: match.directory }); await recovered.recover(); recovered.lockHumanAction({ ...action, playerId: 'A' });
  const length = recovered.records.length;
  const result = await recovered.restoreHumanAction('A', { requestId, revision, beforeEventId: first.eventId, reason: '合成步骤执行错误，恢复后沿用人类选择重新结算' }, action);
  assert.equal(result.status, 'committed'); assert.equal(recovered.records.length, length);
  assert.equal(recovered.state.revision, revision + 1); assert.equal(recovered.state.groups['practice:A:active:0']!.state.damageCounters, 0);
});

test('回滚覆盖同一次临时交权中的对方结算，回合归属和对方历史选择均留记录', async t => {
  const { match, action, command, restore } = await fixture(t), before = structuredClone(match.state);
  const first = await command('A', damage(4));
  const outgoing = await command('A', { kind: 'handoff', to: 'B', reason: '合成效果的对方机械处理' });
  assert.deepEqual(humanActionRecoveryPoints(match, 'A', action.id), [], '对方正持有操作权时不抢权恢复');
  const delegated = await command('B', draw('B'));
  const returned = await command('B', { kind: 'handoff', to: 'A', returning: true, reason: '合成处理已完成' });
  const after = await command('A', damage(5));
  assert.deepEqual(humanActionRecoveryPoints(match, 'A', action.id).map(point => point.eventId), [first.eventId, outgoing.eventId, after.eventId]);
  const result = await restore(first.eventId); assert.equal(result.status, 'committed');
  if (result.status !== 'committed') return;
  assert.deepEqual({ ...match.state, revision: before.revision }, before);
  for (const id of [first.eventId, outgoing.eventId, delegated.eventId, returned.eventId, after.eventId]) assert.equal(match.meta.revoked[id], result.eventId);
  assert.ok(match.history('B').entries.some(event => event.id === delegated.eventId && event.revokedBy === result.eventId));
});

test('独立玩家操作与下一回合普通动作均截断行动恢复范围', async t => {
  for (const kind of ['independent', 'next-turn'] as const) await t.test(kind, async child => {
    const { match, action, command, restore } = await fixture(child);
    const first = await command('A', damage(4));
    if (kind === 'independent') {
      match.unlockHumanAction('A', action.id);
      await command('A', { kind: 'declare', text: '另一个独立行动' }, false);
      match.lockHumanAction({ ...action, playerId: 'A' });
    } else {
      await command('A', { kind: 'set_turn', phase: 'check', playerId: null });
      await command('A', { kind: 'set_turn', phase: 'turn', playerId: 'B' });
      await command('B', draw('B'));
      await command('B', { kind: 'set_turn', phase: 'check', playerId: null });
      await command('B', { kind: 'set_turn', phase: 'turn', playerId: 'A' });
    }
    const revision = match.state.revision;
    assert.deepEqual(humanActionRecoveryPoints(match, 'A', action.id), []);
    const result = await restore(first.eventId); assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.error.code, 'RECOVERY_SCOPE_CONFLICT');
    assert.equal(match.state.revision, revision); assert.deepEqual(match.meta.revoked, {});
  });
});

test('不能借恢复越过异议和待定系统步骤，版本冲突与缺少锁也不会改牌桌', async t => {
  const { match, action, command, restore } = await fixture(t);
  const first = await command('A', damage(4)), state = structuredClone(match.state);
  const conflict = await restore(first.eventId, randomUUID(), state.revision - 1); assert.equal(conflict.status, 'rejected');
  if (conflict.status === 'rejected') assert.equal(conflict.error.code, 'REVISION_CONFLICT');
  const oldTasks = match.meta.tasks;
  match.meta.tasks = [{ id: 'pending', command: { kind: 'declare', text: '待定步骤' } }];
  assert.deepEqual(humanActionRecoveryPoints(match, 'A', action.id), []);
  assert.equal((await restore(first.eventId)).status, 'rejected');
  match.meta.tasks = oldTasks;
  match.unlockHumanAction('A', action.id);
  await assert.rejects(restore(first.eventId), { code: 'HUMAN_ACTION_SCOPE' });
  assert.deepEqual(match.state, state);
});

test('合法异议处理中不开放恢复点；旧事件和别的行动事件不成为恢复入口', async t => {
  const { match, action, command, restore } = await fixture(t);
  const older = match.records.find(record => record.actor?.kind === 'player' && record.event)!.event!.A.id;
  const first = await command('A', damage(4));
  assert.equal((await restore(older)).status, 'rejected');
  await command('A', { kind: 'object', targetEventId: first.eventId, reason: '合成异议', evidenceRefs: [first.eventId], proposal: { restoreBeforeEventId: first.eventId, shuffles: [] } });
  assert.equal(match.meta.dispute!.status, 'awaiting_response');
  const state = structuredClone(match.state);
  assert.deepEqual(humanActionRecoveryPoints(match, 'A', action.id), []);
  assert.equal((await restore(first.eventId)).status, 'rejected'); assert.deepEqual(match.state, state);
});
