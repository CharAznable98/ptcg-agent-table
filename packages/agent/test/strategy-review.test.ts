import test from 'node:test';
import assert from 'node:assert/strict';
import { type TSchema } from '@sinclair/typebox';
import { normalizeReviewResult, reviewStrategy, migrateLegacyStrategy, type ReviewStructured, type ReviewStage } from '../src/strategy-review.ts';
import { parseStructured, type ReviewFact } from '../src/schema.ts';
import { DEFAULT_LIMITS, type PlayerSession, type PlayerFrame, type Observation } from '../src/types.ts';
import type { StrategyEntry } from '../../protocol/src/strategy.ts';
import { playerStrategyProjection } from '../src/policy.ts';
import { contextBytes, userMessage } from '../src/context.ts';

const scope = { deckHash: 'synthetic-deck', rulesHash: 'synthetic-rules' };
const trace = { async append() {} };
function session(observations: Observation[] = []): PlayerSession {
  return { schemaVersion: 1, sessionId: 'synthetic-session', matchId: 'synthetic-match', playerId: 'A', instructions: '', deck: {}, strategy: { version: 1, content: '' }, policyScope: scope,
    messages: [], observations, pendingObservations: [], toolHistory: [], cursor: null, summary: null, pending: null, modelCalls: 0, toolCalls: 0, compactions: 0 };
}
function frame(): PlayerFrame { return { matchId: 'synthetic-match', playerId: 'A', revision: 18, cursor: '18', status: 'finished', tools: [], observations: [], snapshot: {
  flow: { result: { kind: 'win', winner: 'A', reason: '已确认结果' } }, dispute: { id: 'synthetic-dispute', targetEventId: 'evolution', reason: '目标刚刚入场', status: 'closed' },
  inPlayFacts: [{ position: { zoneId: 'A:bench', index: 2 }, lineageRef: 'lineage-main', firstInPlay: { turn: 2, revision: 2, eventId: 'entry' }, lastEvolution: { turn: 8, revision: 8, eventId: 'evolution' } }],
} }; }
const entry = (id: string, factIds: string[], eventIds: string[], status: StrategyEntry['status'] = 'active'): StrategyEntry => ({ id, revision: 1, status, when: '需要判断实例的时点关联时', prefer: '先核对实际身份与事件，再比较处置选择', because: '同名、重做与换位可能影响关联判断', unless: ['身份来源尚未确定'], benefit: 'untested', evidence: factIds.length ? [{ matchId: 'synthetic-match', factIds, eventIds, direction: 'support' }] : [] });
function structured(handler: (stage: ReviewStage, input: any) => unknown, max = 160_000): ReviewStructured {
  return async <T>(stage: ReviewStage, input: unknown, schema: TSchema, validate?: (value: T) => void | Promise<void>) => {
    assert.ok(contextBytes([userMessage(input)]) <= max, 'REVIEW_INPUT_EXCEEDS_BUDGET');
    const value = parseStructured<T>(schema, handler(stage, input)); await validate?.(value); return value;
  };
}
function note(id: string, evidenceRefs: string[], statement: string, kind: ReviewFact['kind'] = 'event'): ReviewFact {
  return { id, kind, status: 'supported', statement, subjectRefs: ['lineage-main'], conflictKey: 'main-entry-timing', evidenceRefs, publicRefs: [], relatedEntryIds: [] };
}

test('终局result仅投影胜负与已执行处置，closed异议理由不随每页重复成为结果', () => {
  const result = normalizeReviewResult(frame().snapshot, [{ id: 'restore', revision: 10, data: { commandKind: 'system_restore', data: { result: { restoredBefore: 'evolution', revokedEvents: ['evolution'] } } } }]);
  assert.deepEqual(result, { outcome: { kind: 'win', winner: 'A' }, dispositions: [{ eventId: 'restore', kind: 'system_restore', restoredBefore: 'evolution', revokedEvents: ['evolution'] }] });
  assert.ok(!JSON.stringify(result).includes('目标刚刚入场'));
});

for (const reversed of [false, true]) for (const allegedTrue of [false, true]) test(`异议内容须独立核验（页序交换=${reversed}，主张成立=${allegedTrue}），无关对象不替代实例关联`, async () => {
  const observations: Observation[] = [
    { id: 'claim', revision: 10, data: { commandKind: 'object', data: { command: { kind: 'object', reason: '目标刚刚入场' }, lineageRef: 'lineage-main', padding: '填'.repeat(1100) } } },
    { id: 'entry', revision: 2, data: { kind: 'entered', lineageRef: 'lineage-main', turn: allegedTrue ? 8 : 2, padding: '填'.repeat(1100) } },
    { id: 'evolution', revision: 8, data: { kind: 'evolved', lineageRef: 'lineage-main', turn: 8, padding: '填'.repeat(1100) } },
    { id: 'other', revision: 15, data: { kind: 'evolved', lineageRef: 'lineage-other', turn: 15, padding: '填'.repeat(3000) } },
  ];
  if (reversed) observations.reverse();
  const current = frame();
  (current.snapshot as any).inPlayFacts[0].firstInPlay.turn = allegedTrue ? 8 : 2;
  let pages = 0, claimCopies = 0, checked = false;
  const update = await reviewStrategy({ session: session(observations), latest: { version: 1, content: '' }, frame: current,
    limits: { ...DEFAULT_LIMITS, maxReviewInputBytes: 24_000 }, trace,
    structured: structured((stage, input) => {
      if (stage === 'facts_extract') {
        pages++; claimCopies += input.claims?.length ?? 0;
        assert.equal(input.result.outcome.winner, 'A');
        assert.ok(!JSON.stringify(input.result).includes('目标刚刚入场'));
        const facts = input.observations.filter((event: Observation) => event.id !== 'other').map((event: Observation) => note(event.id, [event.id], event.id === 'claim' ? '目标刚刚入场' : '同一实例的时点记录', event.id === 'claim' ? 'claim' : 'event'));
        return { facts };
      }
      if (stage === 'facts_review') {
        checked = true;
        assert.deepEqual(new Set(input.relatedObservations.map((event: Observation) => event.id)), new Set(['claim', 'entry', 'evolution']));
        assert.equal(input.currentPublicInPlayFacts[0].lineageRef, 'lineage-main');
        const assessments = input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: fact.kind === 'claim' && !allegedTrue ? 'refuted' : 'supported',
          evidenceRefs: ['entry', 'evolution'], publicRefs: ['lineage-main'], explanation: '核对同一实例原始入场与进化时点；处置状态不决定真伪' }));
        return { assessments };
      }
      assert.equal(stage, 'policy_patch');
      const alleged = input.reviewedFacts.find((fact: ReviewFact) => fact.kind === 'claim');
      assert.equal(alleged.status, allegedTrue ? 'supported' : 'refuted');
      const supported = input.reviewedFacts.find((fact: ReviewFact) => fact.kind === 'event');
      return { baseVersion: 1, changes: [{ kind: 'add', entry: entry('verify-timing', [supported.id], ['entry', 'evolution']) }], changeSummary: '增加有条件的实例核对偏好' };
    }, 24_000) });
  assert.ok(pages > 1);
  assert.equal(claimCopies, 1);
  assert.ok(checked);
  assert.equal(update.policy!.entries[0]!.benefit, 'untested');
  assert.ok(!update.strategy.includes('目标刚刚入场'));
});

test('只有合法异议引用仍不能把主张写成启用条目的事实基础', async () => {
  const observations: Observation[] = [{ id: 'claim', revision: 3, data: { commandKind: 'object', reason: '未经核实主张' } }];
  await assert.rejects(reviewStrategy({ session: session(observations), latest: { version: 1, content: '' }, frame: { ...frame(), snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: structured((stage, input) => stage === 'facts_extract' ? { facts: [note('claim', ['claim'], '未经核实主张', 'claim')] }
      : stage === 'facts_review' ? { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'supported', evidenceRefs: ['claim'], publicRefs: [], explanation: '对手接受且已关闭' })) }
      : { baseVersion: 1, changes: [{ kind: 'add', entry: entry('bad', [input.reviewedFacts[0].id], ['claim']) }], changeSummary: '错误升级' }) }), /ACTIVE_REQUIRES_VERIFIED_FACTS/);
});

test('旧条目事实被反证后必须暂停，空更新不能隐藏反证', async () => {
  const existing = entry('old', [], []);
  const original = { schemaVersion: 1 as const, scope, entries: [existing] };
  const observations: Observation[] = [{ id: 'correction', revision: 11, data: { actual: '已核对原记录，旧说法不成立' } }];
  let omit = true;
  const run = () => reviewStrategy({ session: session(observations), latest: { version: 6, content: '旧正文', policy: original }, frame: { ...frame(), snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: structured((stage, input) => stage === 'facts_extract' ? { facts: [{ ...note('counter', ['correction'], '旧主张不成立'), relatedEntryIds: ['old'] }] }
      : stage === 'facts_review' ? { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'refuted', evidenceRefs: ['correction'], publicRefs: [], explanation: '原记录否定旧主张' })) }
      : { baseVersion: 6, changes: omit ? [] : [{ kind: 'suspend', id: 'old', expectedRevision: 1, reason: '旧事实失效', factIds: [input.reviewedFacts[0].id] }], changeSummary: '暂停待核验' }) });
  await assert.rejects(run(), /COUNTEREVIDENCE_REQUIRES_SUSPEND/);
  omit = false;
  const result = await run();
  assert.equal(result.policy!.entries[0]!.status, 'suspended');
  assert.equal(playerStrategyProjection({ version: 7, content: result.strategy, policy: result.policy! }, scope).content, '');
  assert.equal(original.entries[0]!.status, 'active');
});

test('旧全文迁移另生成候选，不能自证事实或收益，也不改变旧正文', async () => {
  const latest = { version: 6, content: '历史中的未经核实主张' };
  const original = structuredClone(latest);
  let active = true;
  const run = () => migrateLegacyStrategy({ latest, scope, trace, structured: structured((stage, input) => {
    assert.equal(stage, 'legacy_candidates');
    assert.equal(input.legacy.factStatus, 'unresolved');
    return { baseVersion: 6, changes: [{ kind: 'add', entry: entry('legacy', [], [], active ? 'active' : 'candidate') }], changeSummary: '拆分旧正文，待原件核验' };
  }) });
  await assert.rejects(run(), /LEGACY_MIGRATION_REQUIRES_CANDIDATE/);
  active = false;
  const migrated = await run();
  assert.match(migrated.strategy, /候选/);
  assert.equal(playerStrategyProjection({ version: 7, content: migrated.strategy, policy: migrated.policy! }, scope).content, '');
  assert.equal(migrated.policy!.entries[0]!.status, 'candidate');
  assert.deepEqual(latest, original);
  await assert.rejects(reviewStrategy({ session: session(), latest, frame: frame(), trace, limits: DEFAULT_LIMITS, structured: structured(() => { throw new Error('MUST_NOT_CALL'); }) }), /LEGACY_STRATEGY_REQUIRES_MIGRATION/);
});

test('长局复盘逐页覆盖全部原件，查询副本去重，160KB预算和原件不变', async () => {
  const observations: Observation[] = Array.from({ length: 80 }, (_, index) => ({ id: `long-${index}`, revision: index, data: { fact: `FACT_${index}`, padding: '记录'.repeat(1000) } }));
  const current = session(observations), original = structuredClone(current.observations);
  current.toolHistory = [{ request: { tool: 'read_history' }, receipt: { status: 'read', data: { entries: observations.map(observation => ({ ...observation, marker: 'QUERY_COPY_MARKER' })), cursor: '80' } } }];
  const seen = new Set<string>(); let extracts = 0, reviews = 0;
  const update = await reviewStrategy({ session: current, latest: { version: 1, content: '' }, frame: { ...frame(), snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: structured((stage, input) => {
      assert.ok(!JSON.stringify(input).includes('QUERY_COPY_MARKER'));
      if (stage === 'facts_extract') {
        extracts++;
        for (const event of input.observations) seen.add(event.id);
        const source = input.observations[0];
        return { facts: source ? [{ ...note(`note-${extracts}`, [source.id], '已执行的公开记录'), subjectRefs: [source.id], conflictKey: source.id }] : [] };
      }
      if (stage === 'facts_review') {
        reviews++;
        return { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'supported', evidenceRefs: fact.evidenceRefs, publicRefs: [], explanation: '原始记录支持发生事实，收益未测' })) };
      }
      return { baseVersion: 1, changes: [], changeSummary: '没有可确认的策略增量' };
    }) });
  assert.deepEqual(seen, new Set(observations.map(event => event.id)));
  assert.ok(extracts > 2);
  assert.ok(reviews <= extracts);
  assert.deepEqual(current.observations, original);
  assert.equal(current.toolHistory.length, 1);
  assert.equal(update.strategy, '');
});

test('相关原始事实超预算时保留未决，不能靠片段与引用存在激活', async () => {
  const current = session([{ id: 'oversized', revision: 1, data: { message: '大'.repeat(200_000) } }]);
  let reviewed = false;
  const result = await reviewStrategy({ session: current, latest: { version: 1, content: '' }, frame: { ...frame(), snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: structured((stage, input) => {
      if (stage === 'facts_extract') return { facts: [note('partial', ['oversized'], '片段出现某内容')] };
      if (stage === 'facts_review') { reviewed = true; throw new Error('不能核验截断来源'); }
      assert.ok(input.reviewedFacts.every((fact: ReviewFact) => fact.status === 'unresolved'));
      return { baseVersion: 1, changes: [], changeSummary: '完整来源过大，保留未决' };
    }) });
  assert.equal(reviewed, false);
  assert.equal(result.policy!.entries.length, 0);
});

test('替换实体、位置与回合后，公开时点仍按当前lineage连接原始来源', async () => {
  for (const variant of [
    { subject: 'unit-red', entryId: 'record-alpha', evolutionId: 'record-beta', zone: 'B:bench', index: 4, first: 5, evolved: 13 },
    { subject: 'entity-72', entryId: 'new-source-x', evolutionId: 'new-source-y', zone: 'A:active', index: 0, first: 10, evolved: 22 },
  ]) {
    const observations: Observation[] = [{ id: variant.entryId, revision: 5, data: { type: 'entered', lineage: variant.subject } }, { id: variant.evolutionId, revision: 13, data: { type: 'evolved', lineage: variant.subject } }];
    const current = frame();
    current.snapshot = { inPlayFacts: [{ position: { zoneId: variant.zone, index: variant.index }, lineageRef: variant.subject, firstInPlay: { turn: variant.first, revision: 5, eventId: variant.entryId }, lastEvolution: { turn: variant.evolved, revision: 13, eventId: variant.evolutionId } }] };
    let checked = false;
    await reviewStrategy({ session: session(observations), latest: { version: 1, content: '' }, frame: current, limits: DEFAULT_LIMITS, trace,
      structured: structured((stage, input) => {
        if (stage === 'facts_extract') return { facts: [{ ...note('timing', [variant.evolutionId], '核对当前实例时点', 'inference'), subjectRefs: [variant.subject], conflictKey: `${variant.subject}:timing`, publicRefs: [variant.subject] }] };
        if (stage === 'facts_review') {
          checked = true;
          assert.deepEqual(new Set(input.relatedObservations.map((source: Observation) => source.id)), new Set([variant.entryId, variant.evolutionId]));
          assert.equal(input.currentPublicInPlayFacts[0].firstInPlay.turn, variant.first);
          return { assessments: [{ factId: input.facts[0].id, status: 'supported', evidenceRefs: [variant.entryId, variant.evolutionId], publicRefs: [variant.subject], explanation: '原始来源与当前公开实例匹配' }] };
        }
        return { baseVersion: 1, changes: [], changeSummary: '保留已核验事实，不强行新增策略' };
      }) });
    assert.ok(checked);
  }
});

for (const disposition of ['close_dispute', 'system_restore', 'judge_ruling']) test(`${disposition}单独不能证明异议内容成立`, async () => {
  const observations: Observation[] = [{ id: 'disposition', revision: 3, data: { commandKind: disposition, data: { command: { kind: disposition }, status: 'closed' } } }];
  await assert.rejects(reviewStrategy({ session: session(observations), latest: { version: 1, content: '' }, frame: { ...frame(), snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: structured((stage, input) => stage === 'facts_extract' ? { facts: [note('claim', ['disposition'], '所提异议的内容成立', 'claim')] }
      : stage === 'facts_review' ? { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'supported', evidenceRefs: ['disposition'], publicRefs: [], explanation: '已执行处置' })) }
      : { baseVersion: 1, changes: [{ kind: 'add', entry: entry('bad-disposition', [input.reviewedFacts[0].id], ['disposition']) }], changeSummary: '不当升级' }) }), /ACTIVE_REQUIRES_VERIFIED_FACTS/);
});

test('subjectRefs和异议目标指向另页事件时，复核读取目标原件', async () => {
  const observations: Observation[] = [{ id: 'target-event', revision: 1, data: { action: '实际操作事实' } }, { id: 'claim-event', revision: 2, data: { commandKind: 'object', data: { command: { kind: 'object', targetEventId: 'target-event' } } } }];
  let checked = false;
  await reviewStrategy({ session: session(observations), latest: { version: 1, content: '' }, frame: { ...frame(), snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: structured((stage, input) => {
      if (stage === 'facts_extract') return { facts: [{ ...note('claim', ['claim-event'], '待核实主张', 'claim'), subjectRefs: ['target-event'] }] };
      if (stage === 'facts_review') { checked = true; assert.deepEqual(new Set(input.relatedObservations.map((event: Observation) => event.id)), new Set(['target-event', 'claim-event'])); return { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'refuted', evidenceRefs: ['target-event'], publicRefs: [], explanation: '目标原件否定主张' })) }; }
      return { baseVersion: 1, changes: [], changeSummary: '没有策略增量' };
    }) });
  assert.ok(checked);
});

test('旧会话不能从被检查的最新policy借用适用范围，缺少冻结规则拒绝复盘', async () => {
  const old = session(); delete old.policyScope;
  const latest = { version: 7, content: '', policy: { schemaVersion: 1 as const, scope: { deckHash: 'changed-deck', rulesHash: 'changed-rules' }, entries: [] } };
  await assert.rejects(reviewStrategy({ session: old, latest, frame: frame(), limits: DEFAULT_LIMITS, trace, structured: structured(() => { throw new Error('不应调用模型'); }) }), /SCOPE_UNVERIFIABLE/);
  old.rulesText = '冻结旧规则';
  await assert.rejects(reviewStrategy({ session: old, latest, frame: frame(), limits: DEFAULT_LIMITS, trace, structured: structured(() => { throw new Error('不应调用模型'); }) }), /SCOPE_CONFLICT/);
});

test('旧会话有冻结rulesText时使用与新建相同的指纹口径', async () => {
  const { strategyScope } = await import('../src/policy.ts');
  const old = session(); delete old.policyScope; old.rulesText = '相同冻结规则';
  const latest = { version: 1, content: '', policy: { schemaVersion: 1 as const, scope: strategyScope(old.deck, old.rulesText), entries: [] } };
  const result = await reviewStrategy({ session: old, latest, frame: { ...frame(), snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: structured(stage => stage === 'facts_extract' ? { facts: [] } : { baseVersion: 1, changes: [], changeSummary: '不漂移' }) });
  assert.deepEqual(result.policy, latest.policy);
});
