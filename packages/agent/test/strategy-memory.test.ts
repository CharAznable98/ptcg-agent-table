import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyRepository } from '../src/memory.ts';
import { renderPolicy } from '../src/policy.ts';
import type { StrategyPolicy } from '../../protocol/src/strategy.ts';
const trace = { async append() {} };
function policy(): StrategyPolicy { return { schemaVersion: 1, scope: { deckHash: 'deck', rulesHash: 'rules' }, entries: [{ id: 'legacy', revision: 1, status: 'candidate', when: '需要比较资源时', prefer: '比较当前可行路线', because: '条件影响选择', unless: ['未知信息尚未核实'], benefit: 'untested', evidence: [] }] }; }

test('迁移独立发布并保留旧正文；重启重试幂等；候选不会出现在实际策略正文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-structured-memory-'));
  const repo = new StrategyRepository(directory, trace), record = await repo.create({}, '历史原文仍保留');
  const update = { strategy: '模型不得控制此投影', policy: policy(), changeSummary: '迁移为候选', evidenceRefs: [] };
  const next = await repo.migrate({ opponentId: record.id, baseVersion: 1, update });
  assert.equal(next.version, 2);
  assert.match(next.content, /候选/);
  assert.deepEqual(next.source, { kind: 'migration', fromVersion: 1 });
  const restarted = new StrategyRepository(directory, trace);
  assert.equal((await restarted.migrate({ opponentId: record.id, baseVersion: 1, update })).version, 2);
  const stored = await restarted.read(record.id);
  assert.equal(stored.strategies.length, 2);
  assert.equal(stored.strategies[0]!.content, '历史原文仍保留');
  assert.deepEqual((await restarted.latest(record.id)).policy, policy());
});

test('存储拒绝同修订号漂移、删除条目与退回全文', async () => {
  const repo = new StrategyRepository(await mkdtemp(join(tmpdir(), 'ptcg-policy-check-')), trace), record = await repo.create({});
  await repo.migrate({ opponentId: record.id, baseVersion: 1, update: { strategy: '', policy: policy(), changeSummary: '初始化候选', evidenceRefs: [] } });
  const input = { opponentId: record.id, matchId: 'synthetic', playerId: 'A', baseVersion: 2 };
  const drift = policy(); drift.entries[0]!.when = '未经修订的漂移';
  await assert.rejects(repo.publish({ ...input, update: { strategy: '', policy: drift, changeSummary: '漂移', evidenceRefs: [] } }), /UNTOUCHED_ENTRY_CHANGED/);
  await assert.rejects(repo.publish({ ...input, update: { strategy: '', policy: { ...policy(), entries: [] }, changeSummary: '删除', evidenceRefs: [] } }), /REVISION_CONFLICT/);
  await assert.rejects(repo.publish({ ...input, update: { strategy: '退回全文', changeSummary: '全文', evidenceRefs: [] } }), /STRUCTURED_POLICY_REQUIRED/);
  const kept = await repo.publish({ ...input, update: { strategy: '虚假正文', policy: policy(), changeSummary: '无变更', evidenceRefs: [] } });
  assert.equal(kept.content, renderPolicy(policy(), { includeInactive: true }));
  assert.deepEqual(kept.policy, policy());
});
