import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AgentRuntime, MemorySessionStore, JsonlTrace, SecretRedactor, createModel, loadModelConfig, loadPrompts, atomicJson, UsageAccumulator } from '../packages/agent/src/index.ts';
import type { ModelGateway, ModelRequest, PlayerFrame, Observation } from '../packages/agent/src/types.ts';
import type { StrategyEntry } from '../packages/protocol/src/strategy.ts';

// 在冻结源码副本执行。合成对象、时点与页序变化用于验证事实核对，不作为策略强度评估。
const root = resolve(import.meta.dirname, '..');
const directory = resolve(process.argv[2] ?? join(root, 'artifacts/context-policy-native', new Date().toISOString().replaceAll(':', '-')));
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory); // 已存在则拒绝，避免覆盖或混合历史运行原件。
const redactor = new SecretRedactor(), trace = new JsonlTrace(join(directory, 'trace.jsonl'), redactor);
const config = await loadModelConfig(join(root, 'system/agent.json'));
assert.equal(config.model, 'gpt-6.1-terra'); assert.equal(config.reasoningEffort, 'medium'); assert.equal(config.fast, false);
const prompts = await loadPrompts(join(root, 'system/prompts.json'));
const gateway = createModel(config, trace, redactor), requests: ModelRequest[] = [];
const model: ModelGateway = { async generate(request) { requests.push(structuredClone(request)); assert.ok(requests.length <= 24); return gateway.generate(request); } };
const results: unknown[] = [], started = Date.now();
try {
  for (const [caseIndex, allegedTrue] of [false, true].entries()) {
    const matchId = `native-case-${caseIndex}-${randomUUID()}`, playerId = 'A', target = caseIndex ? 'public-omega' : 'public-delta';
    const rules = '仅核对实际对象在场时点：同名不等于同实例，暂存换位不构成离场再入场；各时点以原始有效分支记录为准。双方认可或恢复只证明处置发生，不能证明主张真伪。';
    const deck = { name: '合成条件策略验证资料' }, scope = { deckHash: createHash('sha256').update(JSON.stringify(deck)).digest('hex'), rulesHash: createHash('sha256').update(rules).digest('hex') };
    const existing: StrategyEntry = { id: 'unrelated-resource-comparison', revision: 3, status: 'candidate', when: '公开资源足以比较当前取舍时', prefer: '比较保留资源与立即投入的代价', because: '保留后续选择的收益仍待验证', unless: ['缺少公开资源数据'], benefit: 'untested', evidence: [] };
    const latest = { version: 6, content: '', policy: { schemaVersion: 1 as const, scope, entries: [existing] } };
    const entryTurn = allegedTrue ? 12 : 1;
    const observations: Observation[] = [
      { id: 'entry-main', revision: 1, data: { commandKind: 'move', data: { command: { kind: 'move' }, observed: { lineageRef: target, name: '同名合成对象', action: '进入场上', turn: entryTurn, branch: 'effective' } } } },
      { id: 'entry-other', revision: 2, data: { commandKind: 'move', data: { command: { kind: 'move' }, observed: { lineageRef: 'unrelated-instance', name: '同名合成对象', action: '进入场上', turn: allegedTrue ? 1 : 12, branch: 'effective' } } } },
      { id: 'relocate', revision: 3, data: { commandKind: 'move', data: { command: { kind: 'move' }, observed: { lineageRef: target, action: '通过暂存从战斗区移动到备战区；仍是同一在场对象', turn: 12 } } } },
      { id: 'claim', revision: 4, data: { commandKind: 'object', data: { command: { kind: 'object', targetEventId: 'relocate', reason: '目标是本回合才进入场上的同名对象' }, lineageRef: target, turn: 12 } } },
      { id: 'accept', revision: 5, data: { commandKind: 'respond', data: { command: { kind: 'respond', response: { kind: 'accept' } }, outcome: '接受所提处置，已关闭异议；没有新的入场事实' } } },
    ];
    // 调换实体、页中出现顺序和真假；不依靠固定槽位、卡名或某局胜负。
    if (caseIndex) observations.reverse();
    const frame: PlayerFrame = { matchId, playerId, revision: 5, cursor: '5', status: 'finished', tools: [], observations,
      snapshot: { flow: { turnNumber: 12, result: { kind: 'win', winner: 'A' } }, dispute: { id: 'dispute', targetEventId: 'relocate', reason: '目标是本回合才进入场上的同名对象', status: 'closed' },
        inPlayFacts: [{ position: { zoneId: 'A:bench', index: caseIndex ? 3 : 0 }, lineageRef: target, firstInPlay: { turn: entryTurn, revision: 1, eventId: 'entry-main' }, lastEvolution: null, lastStackChange: null }] } };
    const store = new MemorySessionStore(), runtime = new AgentRuntime({ model, store, prompts, trace, match: { async observe() { return frame; }, async execute() { throw new Error('NO_GAMEPLAY'); } } });
    await runtime.create({ matchId, playerId, deck, strategy: latest, rules });
    const update = await runtime.summarize(matchId, playerId, latest);
    const events = (await readFile(trace.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const facts = events.findLast(event => event.kind === 'strategy_facts_reviewed' && event.matchId === matchId)?.facts ?? [];
    const claims = facts.filter((fact: { kind: string; subjectRefs: string[]; evidenceRefs: string[] }) => fact.kind === 'claim' && (fact.subjectRefs.includes(target) || fact.evidenceRefs.includes('claim')));
    assert.ok(claims.length, '应提取待核实的异议主张');
    assert.ok(claims.every((fact: { assessment: { status: string } }) => fact.assessment.status === (allegedTrue ? 'supported' : 'refuted')), '必须按实际实例和时点判断，不能按认可/关闭或同名对象判断');
    assert.deepEqual(update.policy!.entries.find(entry => entry.id === existing.id), existing, '无关旧条目不能漂移');
    assert.ok(update.policy!.entries.every(entry => entry.benefit === 'untested'));
    await atomicJson(join(directory, `case-${caseIndex}.json`), { allegedTrue, frame, latest, update, reviewedFacts: facts });
    results.push({ caseIndex, allegedTrue, claimStatuses: claims.map((fact: { assessment: { status: string } }) => fact.assessment.status), entries: update.policy!.entries.length });
  }
  const usage = new UsageAccumulator(); for (const line of (await readFile(trace.path, 'utf8')).trim().split('\n')) usage.add(JSON.parse(line));
  await atomicJson(join(directory, 'manifest.json'), { status: 'passed', elapsedMs: Date.now() - started, results, usage: usage.report(), scope: '真实模型核验合成资料中的真假主张、换实例和顺序、旧条目保留；未验证策略胜率或全部卡文。' });
  console.log(JSON.stringify({ status: 'passed', results, elapsedMs: Date.now() - started }));
} catch (error) {
  await atomicJson(join(directory, 'manifest.json'), { status: 'failed', elapsedMs: Date.now() - started, results, error: redactor.clean(String(error)) });
  throw error;
}
