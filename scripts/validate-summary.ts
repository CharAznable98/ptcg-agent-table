import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentRuntime, FileSessionStore, JsonlTrace, SecretRedactor, UsageAccumulator, atomicJson, createModel } from '../packages/agent/src/index.ts';
import { MatchRuntime } from '../apps/server/src/match.ts';

// 冻结副本中的已完成对局：只复核本局策略增量，原对局和原总结不覆盖。
const root = resolve(import.meta.dirname, '..'), matchId = process.argv[2];
assert.match(matchId ?? '', /^[a-zA-Z0-9_-]{1,128}$/);
const match = new MatchRuntime({ directory: join(root, 'data/matches', matchId!) }); await match.recover();
assert.equal(match.state.flow.phase, 'finished');
assert.equal(match.meta.mode, 'ai_ai');
assert.deepEqual(match.state.players.filter(player => player.kind === 'ai').map(player => player.id).sort(), ['A', 'B']);
const outputDirectory = join(root, 'summary-replay'); await mkdir(outputDirectory);
assert.equal(match.meta.model.model, 'gpt-6.1-terra'); assert.equal(match.meta.model.reasoningEffort, 'medium'); assert.equal(match.meta.model.fast, false);
const trace = new JsonlTrace(join(outputDirectory, 'trace.jsonl'), new SecretRedactor());
const model = createModel(match.meta.model, trace, trace.redactor);
const store = new FileSessionStore(join(match.directory, 'contexts'));
const runtime = new AgentRuntime({ model, match, store, trace, prompts: match.meta.prompts });
const provenance = { promptSource: 'match.meta.prompts', promptVersion: match.meta.prompts.version, promptHash: createHash('sha256').update(JSON.stringify(match.meta.prompts)).digest('hex'), rulesHash: createHash('sha256').update(match.meta.rules).digest('hex') };
const started = Date.now(), updates = [];
try {
  for (const player of match.state.players.filter(player => player.kind === 'ai')) {
    const session = await store.load(match.state.id, player.id); assert.ok(session);
    await trace.append({ kind: 'context_loaded', sessionId: session.sessionId, playerId: player.id, matchId: match.state.id, source: 'copied_finished_match' });
    const latest = match.meta.strategies[player.id]!;
    const update = await runtime.summarize(match.state.id, player.id, latest);
    updates.push({ playerId: player.id, baseVersion: latest.version, update });
  }
  assert.deepEqual(updates.map(update => update.playerId).sort(), ['A', 'B']);
  const usage = new UsageAccumulator(); for (const line of (await readFile(trace.path, 'utf8')).trim().split('\n')) usage.add(JSON.parse(line));
  await atomicJson(join(outputDirectory, 'manifest.json'), { status: 'passed', matchId, ...provenance, elapsedMs: Date.now() - started, updates, usage: usage.report(),
    scope: '基于原局冻结开局策略及全量本人观察，用新版校验器重跑赛后策略流程。没有再次打牌，也未覆盖原始策略版本或旧总结。' });
  console.log(JSON.stringify({ status: 'passed', matchId, ...provenance, elapsedMs: Date.now() - started, players: updates.length }));
} catch (error) {
  await atomicJson(join(outputDirectory, 'manifest.json'), { status: 'failed', matchId, ...provenance, elapsedMs: Date.now() - started, updates, error: trace.redactor.clean(String(error)) });
  throw error;
}
