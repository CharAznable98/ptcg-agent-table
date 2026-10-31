import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, MemorySessionStore, loadPrompts } from '../src/index.ts';
import type { MatchPort, ModelGateway, ModelReply, PlayerSession } from '../src/types.ts';
import { contextBytes } from '../src/context.ts';
import { reviewPages } from '../src/review.ts';

function call(name: string, args: unknown, id: string): ModelReply {
  const arguments_ = JSON.stringify(args);
  return { id, model: 'test', output: [{ type: 'function_call', call_id: id, name, arguments: arguments_ }], calls: [{ callId: id, name, arguments: arguments_ }], usage: null };
}
const read = { name: 'read_history', description: '历史', effect: 'read' as const, inputSchema: Type.Object({}) };
const finish = { name: 'finish', description: '完成', effect: 'command' as const, inputSchema: Type.Object({}) };

test('超预算工具反馈必须先交给玩家，模型失败重建后仍保留完整调用反馈对', async () => {
  const store = new MemorySessionStore();
  let done = false, players = 0;
  const output = { entries: [{ id: 'old', text: '历史'.repeat(20_000) }], cursor: '235', hasMore: false, marker: 'RECENT_EVENT_246' };
  const port: MatchPort = {
    async observe(matchId, playerId) { return { matchId, playerId, revision: 0, cursor: '0', status: done ? 'finished' : 'active', observations: [], snapshot: {}, tools: [read, finish] }; },
    async execute(request) { if (request.tool === 'finish') done = true; return { status: request.tool === 'finish' ? 'committed' : 'read', revision: 0, data: request.tool === 'finish' ? {} : output }; },
  };
  const model: ModelGateway = { async generate(request) {
    if (request.role === 'compactor') return call('submit_result', { text: '旧历史', evidenceRefs: [] }, 'compact');
    if (++players === 1) return call('read_history', {}, 'read');
    const feedback = request.input.find(item => item.type === 'function_call_output' && item.call_id === 'read');
    assert.ok(feedback, 'UNCONSUMED_TOOL_OUTPUT_LOST');
    assert.match(feedback.output as string, /RECENT_EVENT_246/);
    assert.ok(request.input.some(item => item.type === 'function_call' && item.call_id === 'read'));
    if (players === 2) throw new Error('SIMULATED_CONNECTION_FAILURE');
    return call('finish', {}, 'finish');
  } };
  const options = { model, match: port, store, trace: { async append() {} }, prompts: await loadPrompts() };
  const runtime = new AgentRuntime(options);
  await runtime.create({ matchId: 'delivery', playerId: 'A', deck: {}, strategy: { version: 2, content: '' }, rules: '' });
  assert.equal((await runtime.activate('delivery', 'A')).reason, 'SIMULATED_CONNECTION_FAILURE');
  assert.equal((await new AgentRuntime(options).activate('delivery', 'A')).status, 'finished');
  assert.equal(players, 3);
});

test('赛后总结去除历史查询副本并分块，全部原始事实可达且每次输入有界', async () => {
  const store = new MemorySessionStore();
  const seen = new Set<string>(); let summaries = 0;
  const observations = Array.from({ length: 80 }, (_, index) => ({ id: `event-${index}`, revision: index, data: { fact: `FACT_${index}:` + '牌桌事实'.repeat(700) } }));
  const port: MatchPort = {
    async observe(matchId, playerId) { return { matchId, playerId, revision: 80, cursor: '80', status: 'finished', observations: [], snapshot: { result: 'A' }, tools: [] }; },
    async execute() { throw new Error('NO_GAMEPLAY'); },
  };
  const model: ModelGateway = { async generate(request) {
    summaries++;
    assert.ok(contextBytes(request.input) <= 160_000, 'POSTGAME_INPUT_EXCEEDS_BUDGET');
    const input = JSON.parse(request.input[0]!.content as string);
    assert.ok(!JSON.stringify(input).includes('READ_COPY_SENTINEL'), 'DUPLICATE_HISTORY_PAGE');
    for (const event of input.observations ?? []) seen.add(event.id);
    return call('submit_result', input.stage === 'facts_extract' ? { facts: [] } : { baseVersion: 2, changes: [], changeSummary: '没有可靠新结论' }, `summary-${summaries}`);
  } };
  const runtime = new AgentRuntime({ model, match: port, store, trace: { async append() {} }, prompts: await loadPrompts() });
  await runtime.create({ matchId: 'postgame', playerId: 'A', deck: {}, strategy: { version: 2, content: '' }, rules: '' });
  const session = (await store.load('postgame', 'A'))!;
  session.observations = structuredClone(observations);
  session.toolHistory = Array.from({ length: 4 }, (_, n) => ({ request: { tool: 'read_history', arguments: { after: String(n) } }, receipt: { status: 'read', revision: 80, data: { entries: observations, cursor: '80', marker: 'READ_COPY_SENTINEL' } } })) as PlayerSession['toolHistory'];
  await store.save(session);
  const update = await runtime.summarize('postgame', 'A', { version: 2, content: '' });
  assert.equal(update.strategy, ''); assert.deepEqual(update.policy!.entries, []);
  assert.deepEqual(seen, new Set(observations.map(event => event.id)));
  assert.ok(summaries > 2, '完整长局需要多个有界输入');
  assert.equal((await store.load('postgame', 'A'))!.toolHistory.length, 4, '原件不得因输入去重被改写');
});

test('极大单条事实按JSON分片完整覆盖，不截断或破坏Unicode', () => {
  const event = { id: 'large', revision: 1, data: { text: '😀中文\\\"'.repeat(1000) } };
  const pages = reviewPages([event], [], { stage: 'evidence_chunk' }, 2000);
  assert.ok(pages.length > 2);
  for (const page of pages) assert.ok(contextBytes([{ role: 'user', content: JSON.stringify({ stage: 'evidence_chunk', ...page }) }]) <= 2000);
  const fragments = pages.flatMap(page => page.observations).map(item => (item as unknown as { fragment: { jsonText: string } }).fragment.jsonText);
  assert.deepEqual(JSON.parse(fragments.join('')), event);
  assert.ok(fragments.every(text => !text.includes('\ufffd')));
});

test('压缩去重历史查询时重新提供被查询的旧事实，不能只留下页索引', async () => {
  const store = new MemorySessionStore();
  const model: ModelGateway = { async generate(request) {
    assert.match(JSON.stringify(request.input), /entered_turn_2_evolved_turn_6/, 'RETRIEVED_FACT_NOT_AVAILABLE');
    const input = JSON.parse(request.input[0]!.content as string);
    assert.equal(input.observations.length, 0, '原始增量水位不回退');
    assert.equal(input.retrievedObservations[0].id, 'e1');
    const metadata = input.toolHistory[0].receipt.data;
    assert.equal(metadata.previousCursor, '200');
    assert.equal(metadata.hasPrevious, true);
    assert.deepEqual(metadata.revokedEvidence, [{ id: 'old-evolution', revokedBy: 'restore-event' }]);
    return call('submit_result', { text: 'entered_turn_2_evolved_turn_6', evidenceRefs: ['e1'] }, 'recalled');
  } };
  const runtime = new AgentRuntime({ model, store, prompts: await loadPrompts(), trace: { async append() {} }, match: { async observe() { throw new Error('UNUSED'); }, async execute() { throw new Error('UNUSED'); } } });
  const session = await runtime.create({ matchId: 'retrieval', playerId: 'B', deck: {}, strategy: { version: 4, content: '' }, rules: '' });
  session.observations = [{ id: 'old-evolution', revision: 6, data: { fact: 'entered_turn_2_evolved_turn_6' } }];
  session.context!.observationOffset = 1;
  session.summary = { text: '正在查进化时间', evidenceRefs: [] };
  session.toolHistory = [{ request: { tool: 'read_history' }, receipt: { status: 'read', revision: 260, data: { entries: session.observations.map(event => ({ ...event, revokedBy: 'restore-event' })), cursor: '259', previousCursor: '200', hasPrevious: true } } }];
  await store.save(session);
  await runtime.compact('retrieval', 'B');
  assert.match((await store.load('retrieval', 'B'))!.summary!.text, /evolved_turn_6/);
  assert.deepEqual((await store.load('retrieval', 'B'))!.observations, session.observations);
});
