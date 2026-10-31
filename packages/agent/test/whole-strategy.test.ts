import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStrategyPatch, playerStrategyProjection, renderPolicy } from '../src/policy.ts';
import { reviewStrategy } from '../src/strategy-review.ts';
import { DEFAULT_LIMITS, type PlayerSession, type Observation, type Json } from '../src/types.ts';
import { parseStructured, validationError, type ReviewFact } from '../src/schema.ts';

const scope = { deckHash: 'test-deck', rulesHash: 'test-rules' };
const trace = { async append() {} };
const oldPlan = '通过稳定展开维持连续攻击，在交换效率和后续资源之间取舍；根据公开局面选择目标。';
function session(observations: Observation[]): PlayerSession {
  return { schemaVersion: 1, sessionId: 'test', matchId: 'm', playerId: 'A', instructions: '', deck: {}, strategy: { version: 1, content: oldPlan }, policyScope: scope,
    messages: [], observations, pendingObservations: [], toolHistory: [], cursor: null, summary: null, pending: null, modelCalls: 0, toolCalls: 0, compactions: 0 };
}
const previous = { schemaVersion: 1 as const, scope, plan: oldPlan, entries: [] };

test('整份计划能够初始化、独立于局部条目阅读并在复盘修订，保留旧版', () => {
  const revised = '优先建立可持续进攻的双线阵容，保留续航资源；以奖赏交换和下一回合攻击概率选择投入。';
  const next = applyStrategyPatch(previous, { baseVersion: 1, plan: revised, changes: [], changeSummary: '重整长期计划' }, { baseVersion: 1, matchId: 'm', facts: [] });
  assert.equal(next.plan, revised);
  assert.equal(previous.plan, oldPlan);
  assert.equal(renderPolicy(previous), oldPlan);
  assert.equal(playerStrategyProjection({ version: 1, content: '', policy: previous }, scope).content, oldPlan);
});

test('复盘共享重复牌面；否定同回合重复动作须提供整段回合，不按可见牌名吞入全局', async () => {
  const card = { kind: 'pokemon', name: '合成卡', text: '用于测试'.repeat(100), hp: 60 };
  const event = (id: string, revision: number, turn: number, command: Json): Observation => ({ id, revision, data: {
    id, revision, sequence: revision, at: 'test', actor: 'A', label: 'move', commandKind: 'move', data: { command, flow: { turnNumber: turn }, observedCards: [{ card }], observedGroups: [] },
  } });
  const observations = [event('old-turn', 1, 1, { kind: 'move', explanation: '附能' }), event('start', 2, 2, { kind: 'start_turn' }), event('draw', 3, 2, { kind: 'move' }), event('claim', 4, 2, { kind: 'object', reason: '重复抽牌', targetEventId: 'draw' })];
  let checked = false;
  await reviewStrategy({ session: session(observations), latest: { version: 1, content: oldPlan, policy: previous }, frame: { matchId: 'm', playerId: 'A', revision: 4, cursor: '4', status: 'finished', tools: [], observations: [], snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: async <T>(stage: string, input: any, schema: any, validate?: (value: T) => void | Promise<void>) => {
      let output: unknown;
      if (stage === 'facts_extract') {
        assert.ok(input.knownCards && Object.keys(input.knownCards).length === 1, '牌面必须共享');
        output = { facts: [{ id: 'duplicate', kind: 'claim', status: 'unresolved', statement: '本回合第二次抽牌', subjectRefs: ['合成卡'], conflictKey: 'turn-2-draw', evidenceRefs: ['claim'], publicRefs: [], relatedEntryIds: [] }] };
      } else if (stage === 'facts_review') {
        checked = true;
        assert.deepEqual(new Set(input.relatedObservations.map((o: Observation) => o.id)), new Set(['start', 'draw', 'claim']));
        output = { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'refuted', evidenceRefs: ['start', 'draw', 'claim'], publicRefs: [], explanation: '完整回合记录只有一次抽牌' })) };
      } else output = { baseVersion: 1, plan: oldPlan, changes: [], changeSummary: '保留总体计划' };
      const value = parseStructured<T>(schema, output); await validate?.(value); return value;
    } });
  assert.ok(checked);
});

test('初始化实际通过模型请求全卡组与冻结规则，生成可直接使用的完整计划', async () => {
  const { AgentRuntime, MemorySessionStore, loadPrompts } = await import('../src/index.ts');
  const { DeckSchema } = await import('../../protocol/src/cards.ts');
  const { readFile } = await import('node:fs/promises');
  const rules = (await Promise.all(['规则基准', '卡牌说明文语义', '赛场规则摘要'].map(name => readFile(new URL('../../../rules/' + name + '.md', import.meta.url), 'utf8')))).join('\n\n');
  assert.ok(Buffer.byteLength(rules) > 20_000);
  let calls = 0;
  const runtime = new AgentRuntime({ store: new MemorySessionStore(), trace, prompts: await loadPrompts(), match: {
    async observe() { throw new Error('初始化不读取别人的对局'); }, async execute() { throw new Error('初始化不操作牌桌'); },
  }, model: { async generate(request) {
    calls++;
    assert.equal(request.role, 'summary');
    const input = JSON.parse(request.input[0]!.content as string);
    assert.equal(input.stage, 'strategy_initialize');
    assert.equal(input.ownDeck.cards.length, 2);
    assert.equal(input.ruleContext, rules);
    assert.match(request.instructions, /strategy_initialize/);
    return { id: 'init', model: 'synthetic', output: [], calls: [{ callId: 'result', name: 'submit_result', arguments: JSON.stringify({ plan: oldPlan, changeSummary: '从卡组建立整体计划' }) }], usage: null };
  } } });
  const deck = { cards: [{ count: 4, card: { kind: 'pokemon', name: '基础合成卡', hp: 60, types: ['草'], stage: '基础', abilities: [], attacks: [{ name: '合成攻击', energyCost: [{ type: '草', count: 1 }], damageText: '10', text: '' }], weaknesses: [], resistances: [], retreatCost: 1 } }, { count: 56, card: { kind: 'energy', name: '合成能量', subtype: 'basic', energyType: '草' } }] };
  assert.equal(validationError(DeckSchema, deck), null);
  const initialized = await runtime.initializeStrategy({ deck, rules, sessionId: 'init:test' });
  assert.equal(calls, 1);
  assert.equal(initialized.policy!.plan, oldPlan);
  assert.deepEqual(initialized.policy!.entries, []);
  assert.deepEqual(initialized.evidenceRefs, []);
});

test('已初始化计划的赛后更新必须提交完整计划，不得退化成局部条目', async () => {
  await assert.rejects(reviewStrategy({ session: session([]), latest: { version: 1, content: oldPlan, policy: previous }, frame: { matchId: 'm', playerId: 'A', revision: 0, cursor: '0', status: 'finished', tools: [], observations: [], snapshot: {} }, limits: DEFAULT_LIMITS, trace,
    structured: async <T>(stage: string, _input: unknown, schema: any, validate?: (value: T) => void | Promise<void>) => {
      const value = parseStructured<T>(schema, stage === 'facts_extract' ? { facts: [] } : { baseVersion: 1, changes: [], changeSummary: '只有局部补丁' });
      await validate?.(value); return value;
    } }), /COMPLETE_STRATEGY_PLAN_REQUIRED/);
});

test('不同命题共享回合起点不能传递合并为超预算整场核验组', async () => {
  const observations: Observation[] = [{ id: 'common', revision: 0, data: { kind: 'start', subject: 'same' } }, ...Array.from({ length: 8 }, (_, index) => ({ id: `source-${index}`, revision: index + 1, data: { content: '证据'.repeat(140), identity: `individual-${index}` } }))];
  let reviews = 0, unresolved = 0;
  await reviewStrategy({ session: session(observations), latest: { version: 1, content: oldPlan, policy: previous }, frame: { matchId: 'm', playerId: 'A', revision: 8, cursor: '8', status: 'finished', tools: [], observations: [], snapshot: {} }, limits: { ...DEFAULT_LIMITS, maxReviewInputBytes: 14_000 }, rules: '规'.repeat(1000), trace,
    structured: async <T>(stage: string, input: any, schema: any, validate?: (value: T) => void | Promise<void>) => {
      let output: unknown;
      if (stage === 'facts_extract') output = { facts: input.observations.filter((source: Observation) => source.id !== 'common').map((source: Observation) => ({ id: source.id, kind: 'event', status: 'unresolved', statement: '独立命题', subjectRefs: ['same'], conflictKey: source.id, evidenceRefs: ['common', source.id], publicRefs: [], relatedEntryIds: [] })) };
      else if (stage === 'facts_review') { reviews++; output = { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'supported', evidenceRefs: fact.evidenceRefs, publicRefs: [], explanation: '该独立原件支持' })) }; }
      else { unresolved = input.reviewedFacts.filter((fact: ReviewFact) => fact.status === 'unresolved').length; output = { baseVersion: 1, plan: oldPlan, changes: [], changeSummary: '原计划保留' }; }
      const value = parseStructured<T>(schema, output); await validate?.(value); return value;
    } });
  assert.ok(reviews >= 2);
  assert.equal(unresolved, 0);
});

test('只修订完整计划也保留本次已核验来源，且没有新事实不能漂移计划', async () => {
  const observations: Observation[] = [{ id: 'resource-use', revision: 1, data: { known: '已观察到资源使用及后续断档' } }];
  let provideFact = true;
  const nextPlan = '稳定展开后保留下一轮接续资源，依据公开场面比较投入和攻击持续性。';
  const events: Record<string, unknown>[] = [];
  const run = () => reviewStrategy({ session: session(observations), latest: { version: 1, content: oldPlan, policy: previous }, frame: { matchId: 'm', playerId: 'A', revision: 1, cursor: '1', status: 'finished', tools: [], observations: [], snapshot: {} }, limits: DEFAULT_LIMITS, trace: { async append(event) { events.push(event); } },
    structured: async <T>(stage: string, input: any, schema: any, validate?: (value: T) => void | Promise<void>) => {
      const output = stage === 'facts_extract' ? { facts: provideFact ? [{ id: 'cost', kind: 'event', status: 'supported', statement: '资源使用影响后续行动', subjectRefs: ['resource-use'], conflictKey: 'resource-use', evidenceRefs: ['resource-use'], publicRefs: [], relatedEntryIds: [] }] : [] }
        : stage === 'facts_review' ? { assessments: input.facts.map((fact: ReviewFact) => ({ factId: fact.id, status: 'supported', evidenceRefs: ['resource-use'], publicRefs: [], explanation: '观察支持实际发生事实，收益未评估' })) }
        : { baseVersion: 1, plan: nextPlan, changes: [], changeSummary: '调整整体资源投入优先级' };
      const value = parseStructured<T>(schema, output); await validate?.(value); return value;
    } });
  const result = await run();
  assert.equal(result.policy!.plan, nextPlan);
  assert.deepEqual(result.evidenceRefs, ['resource-use']);
  assert.equal((events.find(event => event.kind === 'strategy_candidate')!.planReviewSources as any).scope, 'all_verified_facts_available_for_revision');
  provideFact = false;
  await assert.rejects(run(), /PLAN_CHANGE_REQUIRES_VERIFIED_FACTS/);
});
