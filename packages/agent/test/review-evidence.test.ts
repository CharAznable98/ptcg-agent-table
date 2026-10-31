import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewStrategy } from '../src/strategy-review.ts';
import { parseStructured, type ReviewFact } from '../src/schema.ts';
import { DEFAULT_LIMITS, type Observation, type PlayerSession, type Json } from '../src/types.ts';

const scope = { deckHash: 'deck', rulesHash: 'rules' };
const trace = { async append() {} };
function event(id: string, revision: number, turn: number, command: Record<string, Json>, extra: Record<string, Json> = {}): Observation {
  return { id, revision, data: { id, revision, sequence: revision, at: 'test', actor: 'B', label: command.kind!, commandKind: command.kind!, data: { command, flow: { turnNumber: turn }, ...extra } } };
}
function fact(evidenceRefs: string[]): ReviewFact { return { id: 'fact', kind: 'event', status: 'supported', statement: '核对实际发生的效果与攻击者', subjectRefs: [], conflictKey: 'test', evidenceRefs, publicRefs: [], relatedEntryIds: [] }; }
function session(observations: Observation[]): PlayerSession { return { schemaVersion: 1, sessionId: 'review', matchId: 'm', playerId: 'B', instructions: '', deck: {}, policyScope: scope, strategy: { version: 1, content: '' }, messages: [], observations, pendingObservations: [], toolHistory: [], cursor: null, summary: null, pending: null, modelCalls: 0, toolCalls: 0, compactions: 0 }; }
async function capture(observations: Observation[], note: ReviewFact, currentPublicInPlayFacts: Json[] = []) {
  let request: any;
  await reviewStrategy({ session: session(observations), latest: { version: 1, content: '' }, frame: { matchId: 'm', playerId: 'B', revision: observations.at(-1)!.revision, cursor: 'end', status: 'finished', tools: [], observations: [], snapshot: { inPlayFacts: currentPublicInPlayFacts } }, limits: DEFAULT_LIMITS, trace,
    structured: async <T>(stage: string, input: any, schema: any, validate?: (value: T) => void | Promise<void>) => {
      const output = stage === 'facts_extract' ? { facts: [note] } : stage === 'facts_review' ? (request = input, { assessments: input.facts.map((item: ReviewFact) => ({ factId: item.id, status: 'unresolved', evidenceRefs: [], publicRefs: [], explanation: '只检查请求覆盖' })) }) : { baseVersion: 1, changes: [], changeSummary: '只检查取证' };
      const value = parseStructured<T>(schema, output); await validate?.(value); return value;
    } });
  assert.ok(request, '必须实际调用取证接缝');
  return request;
}

test('event事实也提供完整相关回合，补入原引用遗漏的双方洗牌', async () => {
  const observations = [event('other-turn', 1, 8, { kind: 'declare', text: '其他回合' }), event('effect-start', 2, 9, { kind: 'declare', text: '重置手牌' }), event('shuffle-a', 3, 9, { kind: 'shuffle', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }), event('shuffle-b', 4, 9, { kind: 'shuffle', selection: { container: { kind: 'zone', zoneId: 'B:deck' }, range: { mode: 'all' } } }), event('draw', 5, 9, { kind: 'move' })];
  const request = await capture(observations, fact(['effect-start', 'draw']));
  assert.deepEqual(new Set(request.relatedObservations.map((source: Observation) => source.id)), new Set(['effect-start', 'shuffle-a', 'shuffle-b', 'draw']));
});

test('攻击事件的历史公开实例从delta还原，追补较早进化来源，不借用终局同槽实例', async () => {
  const old = { position: { zoneId: 'B:active', index: 0 }, lineageRef: 'old-attacker', firstInPlay: { turn: 0, revision: 1, eventId: 'entry' }, lastEvolution: null, lastStackChange: null };
  const evolved = { ...old, lastEvolution: { turn: 4, revision: 2, eventId: 'evolved-turn4' }, lastStackChange: { turn: 4, revision: 2, eventId: 'evolved-turn4' } };
  const replacement = { ...old, lineageRef: 'new-attacker', firstInPlay: { turn: 8, revision: 5, eventId: 'new-turn8' }, lastEvolution: { turn: 8, revision: 5, eventId: 'new-turn8' } };
  const observations = [event('entry', 1, 0, { kind: 'move' }, { inPlayFacts: [old] }), event('evolved-turn4', 2, 4, { kind: 'move' }, { inPlayFacts: [evolved] }), event('attack-turn6', 3, 6, { kind: 'declare', text: '攻击' }), event('attack-damage', 4, 6, { kind: 'set_state' }), event('new-turn8', 5, 8, { kind: 'move' }, { inPlayFacts: [replacement], departedInPlayRefs: ['old-attacker'] })];
  const original = structuredClone(observations);
  const request = await capture(observations, fact(['attack-turn6']), [replacement]);
  const historical = request.historicalPublicInPlayFacts.find((item: any) => item.position.zoneId === 'B:active' && item.observedAtEventIds.includes('attack-turn6'));
  assert.equal(historical.lineageRef, 'old-attacker');
  assert.equal(historical.lastEvolution.turn, 4);
  assert.ok(!request.historicalPublicInPlayFacts.some((item: any) => item.lineageRef === 'new-attacker'));
  const ids = new Set(request.relatedObservations.map((source: Observation) => source.id));
  assert.ok(ids.has('entry'));
  assert.ok(ids.has('evolved-turn4'));
  assert.ok(ids.has('attack-damage'));
  assert.deepEqual(observations, original);
});

test('历史公开状态按值去重，只标注真实观察锚点并遵守departed边界', async () => {
  const one = { position: { zoneId: 'B:active', index: 0 }, lineageRef: 'public-one', firstInPlay: { turn: 1, revision: 1, eventId: 'seen' }, lastEvolution: null, lastStackChange: null };
  const observations = [event('seen', 1, 1, { kind: 'move' }, { inPlayFacts: [one] }), event('same-a', 2, 2, { kind: 'declare', text: '公开行动甲' }), event('same-b', 3, 2, { kind: 'declare', text: '公开行动乙' }), event('hidden', 4, 3, { kind: 'move' }, { departedInPlayRefs: ['public-one'] }), event('after-hidden', 5, 4, { kind: 'declare', text: '已不在公开场上' })];
  const request = await capture(observations, fact(['same-a', 'same-b', 'after-hidden']));
  assert.equal(request.historicalPublicInPlayFacts.length, 1);
  assert.deepEqual(request.historicalPublicInPlayFacts[0].observedAtEventIds, ['same-a', 'same-b']);
  assert.ok(!request.historicalPublicInPlayFacts[0].observedAtEventIds.includes('after-hidden'));
});

test('旧无delta观察不借终局同槽补历史，缺失时点来源明确保留', async () => {
  const terminal = { position: { zoneId: 'B:active', index: 0 }, lineageRef: 'terminal', firstInPlay: { turn: 8, revision: 8, eventId: 'not-provided' }, lastEvolution: null, lastStackChange: null };
  const request = await capture([event('legacy-attack', 1, 6, { kind: 'declare', text: '旧记录中的攻击' })], fact(['legacy-attack']), [terminal]);
  assert.deepEqual(request.historicalPublicInPlayFacts, []);
  assert.deepEqual(request.evidenceCoverage.historicalStateUnavailableAtEventIds, ['legacy-attack']);
  const state = { ...terminal, lineageRef: 'known', firstInPlay: { turn: 0, revision: 0, eventId: 'missing-source' } };
  const known = await capture([event('observed', 1, 6, { kind: 'move' }, { inPlayFacts: [state] })], fact(['observed']));
  assert.deepEqual(known.evidenceCoverage.missingSourceEventIds, ['missing-source']);
  assert.deepEqual(known.relatedObservations.map((source: Observation) => source.id), ['observed']);
});

test('宿主核验范围进入策略输入和trace：事件不升级合法性，推论仍提供完整规则', async () => {
  for (const kind of ['event', 'inference'] as const) {
    const observations = [event('source', 1, 1, { kind: 'move', description: '记录了一个动作' })];
    const note = { ...fact(['source']), kind };
    const events: Record<string, unknown>[] = [];
    let patched = false;
    const expected = kind === 'event' ? 'observed_events' : 'rules_and_events';
    await reviewStrategy({ session: session(observations), latest: { version: 1, content: '' }, frame: { matchId: 'm', playerId: 'B', revision: 1, cursor: 'end', status: 'finished', tools: [], observations: [], snapshot: {} }, limits: DEFAULT_LIMITS, rules: '完整本地规则，不截断', trace: { async append(event) { events.push(event); } },
      structured: async <T>(stage: string, input: any, schema: any, validate?: (value: T) => void | Promise<void>) => {
        let output: unknown;
        if (stage === 'facts_extract') output = { facts: [note] };
        else if (stage === 'facts_review') {
          assert.equal(input.verificationScope, expected);
          if (kind === 'event') assert.equal(Object.hasOwn(input, 'ruleContext'), false);
          else assert.equal(input.ruleContext, '完整本地规则，不截断');
          output = { assessments: input.facts.map((item: ReviewFact) => ({ factId: item.id, status: 'supported', evidenceRefs: ['source'], publicRefs: [], explanation: '只支持命题实际核对的范围' })) };
        } else {
          patched = true;
          assert.equal(input.reviewedFacts[0].verificationScope, expected);
          assert.equal(input.constraints.recordOnlyIsNotLegalityOrBenefit, true);
          output = { baseVersion: 1, changes: [], changeSummary: '不升级事实范围' };
        }
        const value = parseStructured<T>(schema, output); await validate?.(value); return value;
      } });
    assert.ok(patched);
    assert.equal((events.find(event => event.kind === 'strategy_facts_reviewed')!.facts as any[])[0].verificationScope, expected);
  }
});

test('旧观察后仅有备战增量，攻击锚点仍标为部分历史，不能因active未列出推不存在', async () => {
  const bench = { position: { zoneId: 'B:bench', index: 0 }, lineageRef: 'only-observed-bench', firstInPlay: { turn: 4, revision: 2, eventId: 'bench-delta' }, lastEvolution: null, lastStackChange: null };
  const observations = [event('legacy-no-baseline', 1, 2, { kind: 'declare', text: '旧观察没有完整公开基准' }), event('bench-delta', 2, 4, { kind: 'move' }, { inPlayFacts: [bench] }), event('active-attack', 3, 6, { kind: 'declare', text: '战斗宝可梦攻击' })];
  const request = await capture(observations, fact(['active-attack']));
  assert.equal(request.evidenceCoverage.historicalStateMode, 'observed_deltas');
  assert.equal(request.evidenceCoverage.historicalStateComplete, false);
  assert.deepEqual(request.evidenceCoverage.partialHistoricalStateAtEventIds, ['active-attack']);
  assert.equal(request.historicalPublicInPlayFacts[0].lineageRef, 'only-observed-bench');
  assert.deepEqual(request.historicalPublicInPlayFacts[0].observedAtEventIds, ['active-attack']);
});
