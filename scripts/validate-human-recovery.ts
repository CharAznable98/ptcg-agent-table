import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { runtimeFingerprint } from '../apps/server/src/runtime-fingerprint.ts';
import { createModel, type ModelReply, type ModelRequest } from '../packages/agent/src/index.ts';
import type { CardData, GameCommand, HumanActionView, MatchView } from '../packages/protocol/src/index.ts';

if (!process.argv[2]) throw new Error('用法：node scripts/validate-human-recovery.ts artifacts/<新的验证目录>');
const directory = resolve(process.argv[2]); await mkdir(directory, { recursive: false });
const sourceHash = await runtimeFingerprint();
const promptHash = createHash('sha256').update(await readFile('system/prompts.json')).digest('hex');
const effect = '合成练习效果：选择1至3个伤害指示物，给已指定的对手宝可梦放置所选数量的伤害指示物。';
const card: CardData = { kind: 'pokemon', name: '合成恢复练习宝可梦', hp: 100, types: ['草'], stage: '基础', abilities: [{ name: '合成数量效果', text: effect }], attacks: [], weaknesses: [], resistances: [], retreatCost: 0 };
function call(name: string, args: unknown): ModelReply {
  const callId = randomUUID(), argumentsJson = JSON.stringify(args);
  return { id: randomUUID(), model: 'legacy-fixture', output: [{ type: 'function_call', call_id: callId, name, arguments: argumentsJson }], calls: [{ callId, name, arguments: argumentsJson }], usage: null };
}
let preparing = true, calls = 0, choiceId = '';
const legacy = (request: ModelRequest) => {
  const context = JSON.parse(request.input.filter(item => item.role === 'user').at(-1)!.content as string);
  if (context.intent?.kind === 'turn_start') return call('execute_sequence', { steps: [{ command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, choiceIds: [] }], finish: true });
  calls++;
  if (calls === 1) return call('request_choice', { kind: 'number', title: '合成验收数量', options: [], minimum: 1, maximum: 3, effectText: effect });
  if (calls === 2) return call('execute_atomic', { command: { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 3 } }, choiceIds: [choiceId], effectText: effect });
  return call('fail_action', { reason: '合成旧版本中断，等待修正' });
};
const app = await buildApp({ dataDir: join(directory, 'data'), systemDir: resolve('system'), modelFactory: (config, trace) => ({ generate: request => preparing ? Promise.resolve(legacy(request)) : createModel(config, trace, trace.redactor).generate(request) }) });
const report: Record<string, unknown> = { sourceHash, promptHash, model: 'gpt-6.1-terra', effort: 'medium', fast: false, fixture: '非官方合成牌；数量3为验收夹具预先确认，不由模型选择', status: 'running' };
try {
  const created = await app.inject({ method: 'POST', url: '/api/matches', payload: { mode: 'local', players: ['甲', '乙'].map(name => ({ name, kind: 'human', deck: { cards: [{ card, count: 60 }] } })) } });
  assert.equal(created.statusCode, 200, created.body); const id: string = created.json().match.id, match = app.gameService.match(id);
  assert.equal(match.meta.model.model, report.model); assert.equal(match.meta.model.reasoningEffort, report.effort); assert.equal(match.meta.model.fast, false);
  const view = async () => (await app.inject(`/api/matches/${id}?viewer=A`)).json<MatchView>();
  for (let index = 0; index < 10; index++) {
    const current = await view(), choice = current.flow.choice;
    if (!choice) break;
    const command = choice.kind === 'choose_first' ? { kind: 'choose_first', firstPlayer: 'A' }
      : { kind: 'initial_placement', active: { zoneId: `${choice.playerId}:hand`, index: 0 }, bench: [] };
    const receipt = await app.inject({ method: 'POST', url: `/api/matches/${id}/commands`, payload: { playerId: choice.playerId, requestId: randomUUID(), revision: current.revision, command } }); assert.equal(receipt.statusCode, 200, receipt.body);
  }
  const controller = app.gameService.humanController(match, 'A');
  await app.gameService.prepareHumanTurn(match);
  for (let i = 0; i < 1000 && controller.view('A')?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const started = await app.inject({ method: 'POST', url: `/api/matches/${id}/actions`, payload: { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, intent: { kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0, target: { zoneId: 'B:active', index: 0 } } } }); assert.equal(started.statusCode, 202, started.body);
  const action = started.json<HumanActionView>();
  for (let i = 0; i < 1000 && controller.view('A')?.status !== 'awaiting_choice'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  choiceId = controller.view('A')!.choice!.id;
  await controller.answer(action.id, { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, choiceId, selected: [], number: 3 });
  for (let i = 0; i < 1000 && controller.view('A')?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.view('A')?.status, 'failed');
  const command: GameCommand = { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 6 } };
  match.lockHumanAction(action); const receipt = await match.command('A', { requestId: randomUUID(), revision: match.state.revision, command }, action); match.unlockHumanAction('A', action.id);
  assert.equal(receipt.status, 'committed'); if (receipt.status !== 'committed') throw new Error('legacy fixture failed');
  const path = join(match.directory, 'human-actions', `${action.id}.json`), state = JSON.parse(await readFile(path, 'utf8')), callId = randomUUID();
  state.messages.push({ type: 'function_call', call_id: callId, name: 'execute_atomic', arguments: JSON.stringify({ command, choiceIds: [choiceId], effectText: effect }) }, { type: 'function_call_output', call_id: callId, output: JSON.stringify(receipt) });
  state.view.eventIds.push(receipt.eventId); await writeFile(path, JSON.stringify(state)); await controller.recover();
  const original = await readFile(join(match.directory, 'journal.jsonl'), 'utf8');
  preparing = false; const start = Date.now(); await controller.control(action.id, { playerId: 'A', action: 'retry' });
  for (let i = 0; i < 600 && controller.view('A')?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 150));
  const ref = match.state.zones['B:active']!.contents.items[0]!, final = JSON.parse(await readFile(path, 'utf8'));
  report.actionStatus = controller.view('A')?.status; report.error = controller.view('A')?.error; report.damageCounters = ref.kind === 'group' ? match.state.groups[ref.id]!.state.damageCounters : null;
  report.restores = match.records.filter(record => record.request?.command.kind === 'system_restore').length; report.keptChoice = final.answers.length === 1 && final.answers[0].choice.id === choiceId;
  report.originalJournalPrefixPreserved = (await readFile(join(match.directory, 'journal.jsonl'), 'utf8')).startsWith(original); report.modelCalls = final.recovery?.modelCalls; report.elapsedMs = Date.now() - start;
  assert.equal(report.actionStatus, 'completed'); assert.equal(report.damageCounters, 3); assert.ok(Number(report.restores) >= 1); assert.equal(report.keptChoice, true); assert.equal(report.originalJournalPrefixPreserved, true);
  report.status = 'passed'; console.log(JSON.stringify(report));
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); console.log(JSON.stringify(report)); process.exitCode = 1; }
finally { await app.close(); report.finalSourceHash = await runtimeFingerprint(); if (report.finalSourceHash !== sourceHash) { report.status = 'source_changed'; process.exitCode = 1; } await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); }
