import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStrategyPatch, renderPolicy, validatePolicy } from '../src/policy.ts';
import type { StrategyEntry, StrategyPolicy } from '../../protocol/src/strategy.ts';

const scope = { deckHash: 'deck', rulesHash: 'rules' };
const entry = (id: string): StrategyEntry => ({ id, revision: 1, status: 'active', when: '多个目标会影响资源交换时', prefer: '比较各路线的成本与下一步风险', because: '局面和资源决定选择', unless: ['存在尚未核实的隐藏信息'], benefit: 'untested', evidence: [{ matchId: 'synthetic', eventIds: ['event'], factIds: ['fact'], direction: 'support' }] });
const policy = (): StrategyPolicy => ({ schemaVersion: 1, scope, entries: [entry('compare'), entry('retain')] });
const fact = { id: 'fact', status: 'supported' as const, evidenceRefs: ['event'] };

test('空增量不漂移；修订只触及目标且历史对象不被修改', () => {
  const previous = policy(), original = structuredClone(previous);
  const noOp = applyStrategyPatch(previous, { baseVersion: 3, changes: [], changeSummary: '无新增证据' }, { baseVersion: 3, matchId: 'synthetic', facts: [fact] });
  assert.deepEqual(noOp, previous);
  const changed = { ...entry('compare'), revision: 2, prefer: '先比较当前资源再选择' };
  const next = applyStrategyPatch(previous, { baseVersion: 3, changes: [{ kind: 'revise', id: 'compare', expectedRevision: 1, entry: changed }], changeSummary: '补充条件' }, { baseVersion: 3, matchId: 'synthetic', facts: [fact] });
  assert.deepEqual(next.entries[1], original.entries[1]);
  assert.deepEqual(previous, original);
  assert.equal(next.entries[0]!.revision, 2);
});

test('反证可暂停旧条目；事实可靠性和收益等级分别校验', () => {
  const next = applyStrategyPatch(policy(), { baseVersion: 1, changes: [{ kind: 'suspend', id: 'compare', expectedRevision: 1, reason: '原事实已被否定', factIds: ['counter'] }], changeSummary: '暂停待核验' }, { baseVersion: 1, matchId: 'synthetic', facts: [{ id: 'counter', status: 'refuted', evidenceRefs: ['correction'] }] });
  assert.equal(next.entries[0]!.status, 'suspended');
  assert.equal(next.entries[0]!.benefit, 'untested');
  assert.equal(next.entries[0]!.revision, 2);
  assert.equal(next.entries[0]!.evidence.at(-1)!.direction, 'counter');
  assert.throws(() => applyStrategyPatch(policy(), { baseVersion: 1, changes: [{ kind: 'add', entry: { ...entry('new'), benefit: 'evaluated' } }], changeSummary: '一次赢局' }, { baseVersion: 1, matchId: 'synthetic', facts: [fact] }), /BENEFIT_ESCALATION/);
});

test('条目ID、预期修订号和引用支持必须有效；引用存在不能代替事实支持', () => {
  const candidate = { ...entry('new'), evidence: [{ matchId: 'synthetic', eventIds: ['event'], factIds: ['unresolved'], direction: 'support' as const }] };
  assert.throws(() => applyStrategyPatch(policy(), { baseVersion: 1, changes: [{ kind: 'add', entry: candidate }], changeSummary: '新增' }, { baseVersion: 1, matchId: 'synthetic', facts: [{ id: 'unresolved', status: 'unresolved', evidenceRefs: ['event'] }] }), /ACTIVE_REQUIRES_VERIFIED_FACTS/);
  assert.throws(() => applyStrategyPatch(policy(), { baseVersion: 1, changes: [{ kind: 'suspend', id: 'compare', expectedRevision: 4, reason: '测试', factIds: ['fact'] }], changeSummary: '暂停' }, { baseVersion: 1, matchId: 'synthetic', facts: [fact] }), /REVISION_CONFLICT/);
  assert.throws(() => validatePolicy({ ...policy(), entries: [entry('same'), entry('same')] }), /DUPLICATE/);
});

test('遗留候选不能越权启用；玩家阅读仅含启用项', () => {
  const candidate = { ...entry('legacy'), status: 'candidate' as const, evidence: [] };
  const previous = { ...policy(), entries: [candidate] };
  assert.equal(renderPolicy(previous), '');
  assert.match(renderPolicy(previous, { includeInactive: true }), /候选/);
  assert.throws(() => applyStrategyPatch(previous, { baseVersion: 1, changes: [{ kind: 'revise', id: 'legacy', expectedRevision: 1, entry: { ...candidate, revision: 2, status: 'active' } }], changeSummary: '未经核验的继承' }, { baseVersion: 1, matchId: 'synthetic', facts: [] }), /ACTIVE_REQUIRES_VERIFIED_FACTS/);
});

test('玩家投影隔离候选、暂停、退役和旧全文；范围变化要求复核', async () => {
  const { playerStrategyProjection } = await import('../src/policy.ts');
  const all = policy();
  all.entries.push({ ...entry('unreviewed'), status: 'candidate' }, { ...entry('countered'), status: 'suspended' }, { ...entry('obsolete'), status: 'retired' });
  const snapshot = { version: 7, content: '用户管理正文', policy: all };
  const projected = playerStrategyProjection(snapshot, scope);
  assert.deepEqual(projected.policy!.entries.map(entry => entry.id), ['compare', 'retain']);
  assert.ok(!projected.content.includes('unreviewed'));
  assert.equal(playerStrategyProjection({ version: 6, content: '旧机器错误结论' }).content, '');
  const mismatch = playerStrategyProjection(snapshot, { ...scope, rulesHash: 'changed' });
  assert.equal(mismatch.reviewRequired, true);
  assert.deepEqual(mismatch.policy!.entries, []);
  assert.match(mismatch.content, /需复核/);
  assert.equal(snapshot.policy.entries.length, 5);
});

test('同局另一席位继承的旧证据保持不变，新修订只核验本次新证据', () => {
  const previous = policy();
  previous.entries[0]!.evidence = [{ matchId: 'synthetic', eventIds: ['other-seat-event'], factIds: ['other-seat-fact'], direction: 'support' }];
  const changed = { ...previous.entries[0]!, revision: 2, prefer: '重新比较当前可见资源', evidence: [...previous.entries[0]!.evidence, { matchId: 'synthetic', eventIds: ['event'], factIds: ['fact'], direction: 'support' as const }] };
  const next = applyStrategyPatch(previous, { baseVersion: 5, changes: [{ kind: 'revise', id: 'compare', expectedRevision: 1, entry: changed }], changeSummary: '按新证据修订' }, { baseVersion: 5, matchId: 'synthetic', facts: [fact] });
  assert.deepEqual(next.entries[0]!.evidence[0], previous.entries[0]!.evidence[0]);
  assert.equal(next.entries[0]!.evidence.length, 2);
});

test('多事实证据允许各自来源的并集，外来来源和被反证的支持仍拒绝', () => {
  const previous = policy();
  const combined = { ...entry('combined'), evidence: [{ matchId: 'synthetic', eventIds: ['source-a', 'source-b'], factIds: ['a', 'b'], direction: 'support' as const }] };
  const options = { baseVersion: 1, matchId: 'synthetic', facts: [{ id: 'a', status: 'supported' as const, evidenceRefs: ['source-a'] }, { id: 'b', status: 'supported' as const, evidenceRefs: ['source-b'] }] };
  const patch = { baseVersion: 1, changes: [{ kind: 'add' as const, entry: combined }], changeSummary: '联合独立事实' };
  assert.equal(applyStrategyPatch(previous, patch, options).entries.at(-1)!.id, 'combined');
  assert.throws(() => applyStrategyPatch(previous, { ...patch, changes: [{ kind: 'add', entry: { ...combined, evidence: [{ ...combined.evidence[0]!, eventIds: ['source-a', 'foreign'] }] } }] }, options), /FACT_NOT_REVIEWED/);
  assert.throws(() => applyStrategyPatch(previous, patch, { ...options, facts: [options.facts[0]!, { ...options.facts[1]!, status: 'refuted' }] }), /ACTIVE_REQUIRES_VERIFIED_FACTS/);
});
