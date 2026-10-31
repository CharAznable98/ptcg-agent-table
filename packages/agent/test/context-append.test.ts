import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, FileSessionStore, MemorySessionStore, loadPrompts } from '../src/index.ts';
import { compressionBudget, currentSnapshot, migrateContext, playerInput } from '../src/context.ts';
import type { Json, ModelItem, ModelReply, PlayerFrame, PlayerSession } from '../src/types.ts';

const user = (content: unknown): ModelItem => ({ role: 'user', content: JSON.stringify(content) });
const card = (name: string) => ({ name, kind: 'pokemon', hp: 60, text: '合成资料' });
const tool = { name: 'advance', description: '下一步', effect: 'command' as const, inputSchema: Type.Object({}) };
const frame = (revision: number, snapshot: Json): PlayerFrame => ({ matchId: 'append', playerId: 'A', revision, cursor: String(revision), status: 'active', snapshot, observations: [], tools: [tool] });
const session = (): PlayerSession => ({ schemaVersion: 1, sessionId: 's', matchId: 'append', playerId: 'A', instructions: '', deck: {}, strategy: { version: 1, content: '' }, messages: [], observations: [], pendingObservations: [], toolHistory: [], cursor: null, summary: null, pending: null, modelCalls: 0, toolCalls: 0, compactions: 0, context: { version: 2, observationOffset: 0, toolOffset: 0 } });
function call(name: string, args: unknown, id: string): ModelReply { const arguments_ = JSON.stringify(args); return { id, model: 'test', output: [{ type: 'function_call', call_id: id, name, arguments: arguments_ }], calls: [{ callId: id, name, arguments: arguments_ }], usage: null }; }
function state(input: ModelItem[]) {
  const cards: Record<string, unknown> = {};
  let snapshot: any, revision: number | undefined;
  const expand = (value: any): any => Array.isArray(value) ? value.map(expand) : !value || typeof value !== 'object' ? value : Object.keys(value).length === 1 && value.cardRef ? structuredClone(cards[value.cardRef]) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  for (const item of input) {
    if (item.role !== 'user') continue;
    const row = JSON.parse(item.content as string);
    Object.assign(cards, row.knownCards);
    if (Object.hasOwn(row, 'snapshot')) { snapshot = expand(row.snapshot); revision = row.revision; }
    if (row.snapshotUpdates) {
      for (const update of row.snapshotUpdates) {
        if (!update.path.length) { snapshot = expand(update.value); continue; }
        const parent = update.path.slice(0, -1).reduce((value: any, key: string | number) => value[key], snapshot);
        if (update.remove) delete parent[update.path.at(-1)];
        else parent[update.path.at(-1)] = expand(update.value);
      }
      revision = row.revision;
    }
  }
  return { snapshot, revision };
}

test('同一压缩段连续完整请求保持精确前缀，基准加位置区域替换可还原最新状态', () => {
  const s = session();
  const firstSnapshot = { ownDeck: { fixed: true }, flow: { turn: 1 }, zones: [{ id: 'A:hand', items: [{ position: { zoneId: 'A:hand', index: 0 }, card: card('甲') }] }, { id: 'B:deck', items: [{ hidden: true }] }], obsolete: '须删除' };
  s.messages.push(user({ observations: [{ id: 'first', revision: 1, data: {} }] }));
  const first = playerInput(s, frame(1, firstSnapshot), 8);
  const next = { flow: { turn: 2 }, zones: [{ id: 'A:hand', items: [] }, { id: 'B:deck', items: [{ hidden: true }, { hidden: true }] }] };
  s.messages.push({ type: 'function_call', call_id: 'x', name: 'advance', arguments: '{}' }, { type: 'function_call_output', call_id: 'x', output: '{}' }, user({ observations: [] }));
  const second = playerInput(s, frame(2, next), 8);
  assert.deepEqual(second.slice(0, first.length), first, 'FULL_REQUEST_PREFIX_CHANGED');
  assert.deepEqual(state(second), { snapshot: currentSnapshot(next), revision: 2 });
  const rows = second.map(item => item.role === 'user' ? JSON.parse(item.content as string) : null);
  assert.equal(rows.filter(row => row && Object.hasOwn(row, 'snapshot')).length, 1, 'BASELINE_RESENT');
  assert.ok(rows.some(row => row?.snapshotUpdates?.some((patch: any) => JSON.stringify(patch.path) === '["zones",0]')), 'ZONE_REPLACEMENT_MISSING');
  assert.deepEqual(rows.at(-1).execution.availableTools, ['advance']);
});

test('牌面恢复隐藏与回滚只更新当前位置，历史已知资料不带回隐藏区', () => {
  const s = session();
  const shown = { zones: [{ id: 'B:hand', items: [{ position: { zoneId: 'B:hand', index: 0 }, card: card('已展示') }] }], dispute: { id: 'd' } };
  const first = playerInput(s, frame(7, shown), 8);
  const hidden = { zones: [{ id: 'B:hand', items: [{ kind: 'hidden' }] }], restoredFrom: 3 };
  const second = playerInput(s, frame(8, hidden), 8);
  assert.deepEqual(second.slice(0, first.length), first);
  assert.deepEqual(state(second).snapshot, hidden);
  assert.doesNotMatch(JSON.stringify(state(second)), /已展示|cardRef|position|dispute/);
  const hiddenPatch = JSON.parse(second.at(-1)!.content as string);
  assert.doesNotMatch(JSON.stringify(hiddenPatch), /已展示|cardRef/);
  assert.match(JSON.stringify(second), /已展示/, '过去合法已知牌面必须仍可查');
});

test('持久重启与模型失败重试保持完整前缀和未消费原生调用反馈顺序', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-context-append-'));
  try {
    const store = new FileSessionStore(directory), requests: ModelItem[][] = [];
    let step = 0, players = 0;
    const prompts = await loadPrompts();
    const options = { prompts, store, trace: { async append() {} },
      model: { async generate(request: any) {
        assert.equal(request.role, 'player'); requests.push(structuredClone(request.input));
        if (++players === 1) return call('advance', {}, 'first-call');
        assert.deepEqual(request.input.filter((item: ModelItem) => item.type === 'function_call' || item.type === 'function_call_output').map((item: ModelItem) => [item.type, item.call_id]), [['function_call', 'first-call'], ['function_call_output', 'first-call']]);
        assert.match(JSON.stringify(request.input), /NATIVE_OUTPUT_SENTINEL/);
        if (players === 2) throw Error('CONNECTION_LOST');
        return call('advance', {}, 'last-call');
      } },
      match: { async observe() { return { ...frame(step, { step }), status: step === 2 ? 'finished' as const : 'active' as const }; }, async execute() { step++; return { status: 'committed' as const, revision: step, data: { marker: 'NATIVE_OUTPUT_SENTINEL' } }; } },
    };
    const runtime = new AgentRuntime(options);
    await runtime.create({ matchId: 'append', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
    assert.equal((await runtime.activate('append', 'A')).reason, 'CONNECTION_LOST');
    assert.equal((await new AgentRuntime({ ...options, store: new FileSessionStore(directory) }).activate('append', 'A')).status, 'finished');
    assert.deepEqual(requests[1]!.slice(0, requests[0]!.length), requests[0]);
    assert.deepEqual(requests[2]!.slice(0, requests[1]!.length), requests[1]);
    assert.equal(requests[2]!.filter(item => item.type === 'function_call_output' && item.call_id === 'first-call').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('仅成功压缩换段，失败保留wire与原件，成功也不截断原始messages', async () => {
  const store = new MemorySessionStore(); let reject = true;
  const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), limits: { recentHistoryBytes: 64 }, trace: { async append() {} }, match: { async observe() { throw Error('UNUSED'); }, async execute() { throw Error('UNUSED'); } }, model: { async generate() { if (reject) throw Error('COMPACTOR_OFFLINE'); return call('submit_result', { text: '保留事实', evidenceRefs: ['e1'] }, 'compact'); } } });
  const s = await runtime.create({ matchId: 'append', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  s.observations = [{ id: 'old', revision: 1, data: { fact: '旧事实'.repeat(100) } }]; s.messages = [user({ observations: s.observations })];
  playerInput(s, frame(1, { step: 1 }), 8); s.context!.deliveredMessages = 1;
  const pending = [{ type: 'function_call', call_id: 'unconsumed', name: 'advance', arguments: '{}' }, { type: 'function_call_output', call_id: 'unconsumed', output: '{"protected":true}' }];
  s.messages.push(...pending); const raw = structuredClone(s.messages), wire = structuredClone(s.context!.wire); await store.save(s);
  await assert.rejects(runtime.compact('append', 'A'), /COMPACTOR_OFFLINE/);
  assert.deepEqual((await store.load('append', 'A'))!.context!.wire, wire);
  reject = false; await runtime.compact('append', 'A');
  const after = (await store.load('append', 'A'))!;
  assert.deepEqual(after.messages, raw, 'RAW_MESSAGES_TRUNCATED');
  assert.ok(after.context!.wire!.epoch > wire!.epoch);
  const next = playerInput(after, frame(2, { step: 2 }), 8);
  assert.deepEqual(state(next), { snapshot: { step: 2 }, revision: 2 });
  assert.deepEqual(next.filter(item => item.type === 'function_call' || item.type === 'function_call_output'), pending);
});

test('旧格式迁移只收集旧快照，不改写原始messages', () => {
  const s = session(); delete s.context;
  s.messages = [user({ revision: 1, snapshot: { seen: '旧的已知信息' }, memory: null, observations: [] })];
  const raw = structuredClone(s.messages);
  assert.equal(migrateContext(s), true);
  assert.deepEqual(s.messages, raw, 'LEGACY_RAW_MESSAGES_REWRITTEN');
});

test('压缩工具schema固定，动态证据与预算留在input和宿主校验', () => {
  assert.deepEqual(compressionBudget(1200, ['long-original'], ['e1']).schema, compressionBudget(12000, ['other-original', 'another'], ['e1', 'e2']).schema, 'DYNAMIC_COMPACTOR_SCHEMA_BREAKS_CACHE');
});

for (const restart of [false, true]) test(`洗牌依赖保护跨中间宣告${restart ? '与持久重启' : ''}累积，不能按洗牌后的旧索引选牌`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-shuffle-guard-'));
  try {
    const store = new FileSessionStore(directory), controller = new AbortController(), calls: string[] = [];
    const catalog = ['shuffle', 'declare', 'move'].map(name => ({ name, description: name, effect: 'command' as const, inputSchema: Type.Any() }));
    let decisions = 0, revision = 0;
    const options = { store, prompts: await loadPrompts(), trace: { async append() {} },
      model: { async generate(request: any) {
        if (++decisions === 1) return call('execute_sequence', { actions: [
          { tool: 'shuffle', arguments: { zoneId: 'A:deck' } }, { tool: 'declare', arguments: { text: '进行下一步' } },
          { tool: 'move', arguments: { source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 2, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' } } } },
        ] }, 'guarded-sequence');
        const output = request.input.find((item: ModelItem) => item.type === 'function_call_output' && item.call_id === 'guarded-sequence');
        assert.equal(JSON.parse(output.output).stoppedReason, 'SHUFFLE_DEPENDENCY');
        assert.deepEqual(calls, ['shuffle', 'declare']);
        throw Error('CHECKED_SHUFFLE_GUARD');
      } },
      match: { async observe() { return { ...frame(revision, {}), tools: catalog }; }, async execute(request: any) {
        calls.push(request.tool); revision++;
        if (restart && request.tool === 'declare') controller.abort();
        return { status: 'committed' as const, revision, data: {}, continuation: 'continue' as const, ...(request.tool === 'shuffle' ? { continuationGuard: { kind: 'hidden_shuffle' as const, zoneIds: ['A:deck'] } } : {}) };
      } },
    };
    const runtime = new AgentRuntime(options);
    await runtime.create({ matchId: 'append', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
    const first = await runtime.activate('append', 'A', restart ? controller.signal : undefined);
    if (restart) {
      assert.equal(first.reason, 'CANCELLED');
      assert.equal((await store.load('append', 'A'))!.sequence!.next, 2);
      assert.equal((await new AgentRuntime({ ...options, store: new FileSessionStore(directory) }).activate('append', 'A')).reason, 'CHECKED_SHUFFLE_GUARD');
    } else assert.equal(first.reason, 'CHECKED_SHUFFLE_GUARD');
    assert.deepEqual(calls, ['shuffle', 'declare']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('固定定义中的不可用工具不能执行，拒绝后反馈保留在追加输入', async () => {
  const store = new MemorySessionStore(); let decisions = 0, effects = 0;
  const unavailable = { ...tool, name: 'unavailable' };
  const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), trace: { async append() {} },
    model: { async generate(request) {
      if (++decisions === 1) return call('unavailable', {}, 'denied');
      const feedback = request.input.find(item => item.type === 'function_call_output' && item.call_id === 'denied');
      assert.equal(JSON.parse(feedback!.output as string).status, 'rejected');
      assert.deepEqual(JSON.parse(request.input.at(-1)!.content as string).execution.availableTools, ['advance', 'execute_sequence']);
      throw Error('UNAVAILABLE_TOOL_REJECTED');
    } },
    match: { async observe() { return { ...frame(0, {}), tools: [tool], toolCatalog: [tool, unavailable] }; }, async execute() { effects++; throw Error('UNAUTHORIZED_EFFECT'); } },
  });
  await runtime.create({ matchId: 'append', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
  assert.equal((await runtime.activate('append', 'A')).reason, 'UNAVAILABLE_TOOL_REJECTED');
  assert.equal(effects, 0);
});

test('固定压缩schema不会放松动态预算、短引用允许集合与真实ID字节校验', async () => {
  for (const invalid of ['text', 'refs', 'scope', 'bytes'] as const) {
    const store = new MemorySessionStore(); let calls = 0;
    const runtime = new AgentRuntime({ store, prompts: await loadPrompts(), limits: { maxSummaryBytes: 512, maxConsecutiveFailures: 2 }, trace: { async append() {} }, match: { async observe() { throw Error('UNUSED'); }, async execute() { throw Error('UNUSED'); } }, model: { async generate(request) {
      calls++;
      const input = JSON.parse(request.input[0]!.content as string);
      if (invalid === 'text') return call('submit_result', { text: '汉'.repeat(input.maxTextCharacters + 1), evidenceRefs: [] }, `bad-${calls}`);
      if (invalid === 'refs') return call('submit_result', { text: '短', evidenceRefs: Array(input.maxEvidenceRefs + 1).fill('e1') }, `bad-${calls}`);
      if (invalid === 'scope') return call('submit_result', { text: '短', evidenceRefs: ['e999'] }, `bad-${calls}`);
      // 单个原始ID大于总预算，即使返回短引用也不能放宽真实落盘字节限制。
      return call('submit_result', { text: '短', evidenceRefs: ['e1'] }, `bad-${calls}`);
    } } });
    const s = await runtime.create({ matchId: 'append', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '' });
    s.observations = [{ id: invalid === 'bytes' ? '长'.repeat(300) : 'fact', revision: 1, data: {} }];
    await store.save(s);
    await assert.rejects(runtime.compact('append', 'A'), /STRUCTURED_OUTPUT_RETRIES_EXHAUSTED/);
    assert.equal(calls, 2);
    assert.equal((await store.load('append', 'A'))!.summary, null);
  }
});
