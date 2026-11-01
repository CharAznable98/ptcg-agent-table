import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { MatchRuntime } from '../apps/server/src/match.ts';
import { runtimeFingerprint } from '../apps/server/src/runtime-fingerprint.ts';
import { practiceOther } from './human-action-fixtures.ts';

const directory = resolve(process.argv[2]!); await mkdir(directory);
const dataDir = join(directory, 'data'), systemDir = resolve('system'), sourceHash = await runtimeFingerprint();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const report: Record<string, unknown> = { sourceHash, status: 'running' };
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  app = await buildApp({ dataDir, systemDir });
  const response = await app.inject({ method: 'POST', url: '/api/matches', payload: { mode: 'local', players: ['甲', '乙'].map(name => ({ name, kind: 'human', deck: { cards: [{ card: practiceOther, count: 60 }] } })) } });
  assert.equal(response.statusCode, 200); const id = response.json().match.id, match = app.gameService.match(id);
  assert.equal(match.meta.model.model, 'gpt-6.1-terra'); assert.equal(match.meta.model.reasoningEffort, 'medium'); assert.equal(match.meta.model.fast, false);
  while (match.state.flow.choice) {
    const choice = match.state.flow.choice;
    const command = choice.kind === 'choose_first' ? { kind: 'choose_first', firstPlayer: 'A' } : { kind: 'initial_placement', active: { zoneId: `${choice.playerId}:hand`, index: 0 }, bench: [] };
    assert.equal((await app.inject({ method: 'POST', url: `/api/matches/${id}/commands`, payload: { playerId: choice.playerId, requestId: randomUUID(), revision: match.state.revision, command } })).statusCode, 200);
  }
  await app.gameService.prepareHumanTurn(match); const original = app.gameService.humanController(match, 'A').view('A')!;
  await app.close(); app = undefined;
  const offline = new MatchRuntime({ directory: match.directory }); await offline.recover(); await offline.debug({ kind: 'restore', targetEventId: original.eventIds[0]! });
  const path = join(match.directory, 'journal.jsonl'), untouched = await readFile(path, 'utf8');
  app = await buildApp({ dataDir, systemDir }); assert.equal(await readFile(path, 'utf8'), untouched);
  for (const url of ['/api/matches', `/api/matches/${id}?viewer=A`, `/api/matches/${id}/history?viewer=A`, `/api/matches/${id}/replay?viewer=A&index=0`, `/api/matches/${id}/export`]) assert.equal((await app.inject(url)).statusCode, 200);
  assert.equal(await readFile(path, 'utf8'), untouched); await app.close(); app = undefined;
  app = await buildApp({ dataDir, systemDir }); assert.equal(await readFile(path, 'utf8'), untouched);
  const started = Date.now(), activated = await app.inject({ method: 'POST', url: `/api/matches/${id}/actions/activate`, payload: { playerId: 'A' } }), elapsedMs = Date.now() - started;
  assert.equal(activated.statusCode, 202); assert.equal(activated.json().status, 'completed');
  const view = (await app.inject(`/api/matches/${id}?viewer=A`)).json(); assert.equal(view.zones.find((zone: { id: string }) => zone.id === 'A:hand').items.length, 7);
  const state = JSON.parse(await readFile(join(match.directory, 'human-actions', `${view.humanAction.id}.json`), 'utf8')); assert.equal(state.modelCalls, 0); assert.equal(view.humanAction.eventIds.length, 1);
  const after = await readFile(path, 'utf8'); await app.inject(`/api/matches/${id}?viewer=A`); await app.inject({ method: 'POST', url: `/api/matches/${id}/actions/activate`, payload: { playerId: 'A' } }); assert.equal(await readFile(path, 'utf8'), after);
  await app.close(); app = undefined; assert.equal(await readFile(path, 'utf8'), after);
  Object.assign(report, { status: 'passed', matchId: id, model: match.meta.model.model, effort: match.meta.model.reasoningEffort, fast: match.meta.model.fast, idleJournalHash: hash(untouched), finalJournalHash: hash(after), elapsedMs, modelCalls: state.modelCalls, eventIds: view.humanAction.eventIds, actionId: view.humanAction.id });
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await app?.close(); report.finalSourceHash = await runtimeFingerprint(); report.promptHash = hash(await readFile('system/prompts.json'));
  if (report.finalSourceHash !== sourceHash) { report.status = 'source_changed'; process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify(report));
}
