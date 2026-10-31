import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MatchRuntime, type MatchRecord } from '../apps/server/src/match.ts';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GameService } from '../apps/server/src/service.ts';
import { atomicJson, FileSessionStore, UsageAccumulator } from '../packages/agent/src/index.ts';
import type { ModelItem } from '../packages/agent/src/types.ts';

// 由 freeze-validation 从冻结副本启动；数据与历史运行隔离。
export async function validateOneMatch(root: string, opponents: string[], initial?: Pick<MatchRecord,'state'|'meta'>): Promise<void> {
assert.equal(opponents.length, 2, '传入两名已配置对手ID');
const service = new GameService({ dataDir: join(root, 'data'), systemDir: join(root, 'system'), rulesDir: join(root, 'rules') });
await service.init();
const model = await service.modelConfig();
assert.equal(model.model, 'gpt-6.1-terra'); assert.equal(model.reasoningEffort, 'medium'); assert.equal(model.fast, false);
let matchId: string | undefined;
const started = Date.now();
try {
  const before = await Promise.all(opponents.map(id => service.opponents.get(id)));
  await atomicJson(join(root, 'run-input.json'), { startedAt: new Date(started).toISOString(), opponents: before.map(value => ({ id: value.id, version: value.strategies.at(-1)!.version, deckHash: createHash('sha256').update(JSON.stringify(value.deck)).digest('hex') })) });
  let created;
  if (initial) {
    assert.equal(initial.meta.rules,service.rulesText(),'复用场景时规则必须相同');
    assert.deepEqual(initial.meta.model,model,'复用场景时模型配置必须相同');
    const id=randomUUID(), replay=new MatchRuntime({directory:join(root,'data/matches',id)}), prompts=await service.prompts();
    const scenario=structuredClone(initial); scenario.meta.prompts={...prompts,version:prompts.version!};
    delete scenario.meta.evaluation;
    await replay.createFromScenario(id,scenario); replay.rulesText=scenario.meta.rules;service.matches.set(id,replay);
    created={match:replay.summary()};
  } else created = await service.createMatch({ mode: 'ai_ai', autoRun: false, players: before.map((opponent, index) => ({ kind: 'ai', name: opponent.name ?? String(index), opponentId: opponent.id })) });
  matchId = created.match.id;
  const match = service.match(matchId);
  console.log(JSON.stringify({ kind: 'match_created', matchId, startedAt: new Date(started).toISOString() }));
  service.start(match, false);
  const timeout = setTimeout(() => service.cancel(), 25 * 60_000);
  try { await service.drivers.get(matchId)!.promise; } finally { clearTimeout(timeout); }
  const events = (await readFile(join(match.directory, 'agent-trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ModelItem);
  const usage = new UsageAccumulator(); for (const event of events) usage.add(event);
  const sessions = await Promise.all(['A', 'B'].map(playerId => new FileSessionStore(join(match.directory, 'contexts')).load(matchId!, playerId)));
  const playerStarts = events.filter(event => event.kind === 'model_started' && event.role === 'player');
  const playerCalls = new Set(playerStarts.map(event => String(event.callId)));
  const seenCalls = new Set<string>();
  const previous = new Map<string, unknown[]>(); let transitions = 0, fullPrefix = 0, segmentResets = 0;
  for (const event of events) {
    if (event.kind === 'context_compacted') { previous.delete(String(event.sessionId)); segmentResets++; continue; }
    if (event.kind !== 'model_started' || event.role !== 'player' || seenCalls.has(String(event.callId))) continue;
    seenCalls.add(String(event.callId));
    const input = (event.request as { input: unknown[] }).input, key = String(event.sessionId), old = previous.get(key);
    if (old) { transitions++; if (JSON.stringify(input.slice(0, old.length)) === JSON.stringify(old)) fullPrefix++; }
    previous.set(key, input);
  }

  const terminal = match.records.find(record => record.state.flow.phase === 'finished');
  const formalEnd = terminal?.event?.A.at ?? new Date().toISOString();
  const formalElapsedMs = Date.parse(formalEnd) - started;
  const rejectedTools = events.filter(event => event.kind === 'tool_finished' && (event.receipt as {status?:string})?.status === 'rejected');
  const objections = match.records.filter(record => record.request?.command.kind === 'object').map(record => {
    const command = record.request!.command as {targetEventId:string;reason:string};
    const target = match.records.find(item => item.event?.A.id === command.targetEventId);
    const disputeId = record.meta.dispute?.id;
    const ruling = [...match.records].reverse().find(item => item.meta.dispute?.id === disputeId && item.meta.dispute?.ruling)?.meta.dispute?.ruling;
    const actor = record.actor?.kind === 'player' ? record.actor.playerId : 'system';
    return { eventId:record.event?.A.id, actor, reason:command.reason, targetActor:target?.event?.A.actor, self:target?.event?.A.actor === actor, verdict:ruling?.verdict ?? null };
  });
  const mechanismsPassed = transitions > 0 && transitions === fullPrefix;
  const manifest = { status: mechanismsPassed && match.meta.runtime.status === 'completed' && Object.values(match.meta.summaries).every(summary => summary.status === 'completed') ? 'passed' : 'failed', matchId,
    elapsedMs: Date.now() - started, formalElapsedMs, postgameElapsedMs: Date.now() - Date.parse(formalEnd), performanceTargetMs: 300_000, performanceTargetMet: formalElapsedMs <= 300_000, rejectedTools: rejectedTools.length, objections, result: match.state.flow.result, turnNumber: match.state.flow.turnNumber, runtime: match.meta.runtime, summaries: match.meta.summaries,
    playerDecisions: playerCalls.size, playerHttpAttempts: playerStarts.length,
    compactions: sessions.reduce((n, session) => n + (session?.compactions ?? 0), 0),
    sequences: events.filter(event => event.kind === 'sequence_finished').map(event => ({ stoppedReason: event.stoppedReason, skipped: Array.isArray(event.skipped) ? event.skipped.length : 0 })),
    prefix: { transitions, fullPrefix, segmentResets }, mechanismsPassed, usage: usage.report(),
    scope: '冻结源码中当前两套真实卡组的一局真实模型对战，不表示全规则或胜率已验证。' };
  await atomicJson(join(root, 'match-manifest.json'), manifest);
  console.log(JSON.stringify({ kind: 'match_finished', ...manifest, usage: manifest.usage.totals, sequences: manifest.sequences.length }));
  assert.equal(manifest.status, 'passed', '对战与双方策略更新必须完成');
} catch (error) {
  await atomicJson(join(root, 'run-error.json'), { matchId, elapsedMs: Date.now() - started, error: String(error) });
  throw error;
} finally { await service.close(); }

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await validateOneMatch(resolve(import.meta.dirname,'..'),process.argv.slice(2));
