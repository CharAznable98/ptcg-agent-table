import { mkdir, copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { seedHumanScenario, practiceDeck } from './human-action-fixtures.ts';
import type { PracticeScenarioOptions } from './human-action-fixtures.ts';
import { seedLayoutPressure } from './layout-pressure-fixture.ts';

const directory = resolve(process.argv[2] ?? `artifacts/battle-qa-${Date.now()}`);
const staticDir = resolve(process.argv[3] ?? 'apps/web/dist');
const dataDir = join(directory, 'data');
const suffix = process.env.PTCG_QA_SCENARIO_SUFFIX ?? '';
await mkdir(join(dataDir, 'matches'), { recursive: true });
// 只复制历史原件至测试服务；任何恢复和浏览器操作均不写入用户原对局。
for (const id of ['277d1186-f975-4e10-9f71-6716c03b0907', '6f568d1e-ed2e-4d72-965f-73fc62795859']) {
  const source = resolve('data', 'matches', id, 'journal.jsonl');
  try {
    await access(source); await mkdir(join(dataDir, 'matches', id), { recursive: true });
    await copyFile(source, join(dataDir, 'matches', id, 'journal.jsonl'), constants.COPYFILE_EXCL);
  } catch (error) { if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
const app = await buildApp({ dataDir, systemDir: resolve('system'), staticDir });
const scenarios: [string, PracticeScenarioOptions][] = [
  ['human-drag', {}], ['human-choices', {}], ['human-error', {}], ['human-attack', { attachedEnergy: true }], ['human-activation', {}],
  ['human-handoff', { handoff: true }], ['human-handoff-choice', { handoff: true }],
  ['human-number', { extraHand: ['number'] }], ['human-order', { extraHand: ['order'] }], ['human-poison', { poisoned: true }],
  ['human-coins', { extraHand: ['coins'] }], ['human-selected', {}],
];
for (const [base, options] of scenarios) { const id = `${base}${suffix}`; if (!app.gameService.matches.has(id)) await seedHumanScenario(app.gameService, id, options); }
// 合成的“重启后尚未抽牌”起点，只由显式实时激活推进，读取与回放不推进。
const activation = app.gameService.matches.get(`human-activation${suffix}`)!;
if (activation.state.flow.turnNumber === 3) for (const command of [
  { kind: 'set_turn', phase: 'check', playerId: null }, { kind: 'set_turn', phase: 'turn', playerId: 'B' },
  { kind: 'set_turn', phase: 'check', playerId: null }, { kind: 'set_turn', phase: 'turn', playerId: 'A' },
] as const) {
  const receipt = await activation.command(activation.state.flow.operator, { requestId: crypto.randomUUID(), revision: activation.state.revision, command });
  if (receipt.status !== 'committed') throw new Error('自动开局激活场景准备失败');
}
if (!app.gameService.matches.has(`layout-pressure${suffix}`)) await seedLayoutPressure(app.gameService, `layout-pressure${suffix}`, app.gameService.matches.get(`human-attack${suffix}`)!);
const spectator = app.gameService.matches.get('spectator-live') ?? await seedHumanScenario(app.gameService, 'spectator-live', { aiSpectator: true });
if (!(await app.gameService.decks.list()).length) await app.gameService.saveDeck(practiceDeck);
// 仅独立验收服务拥有的场景推进端点；生产应用不注册。
app.post('/api/qa/advance-spectator', async () => spectator.command('A', { requestId: crypto.randomUUID(), revision: spectator.state.revision, command: { kind: 'declare', text: '合成观战状态更新' } }));
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4117) });
console.log(JSON.stringify({ url: `http://127.0.0.1:${process.env.PORT ?? 4117}`, directory, staticDir, humanModel: 'gpt-6.1-terra / medium / fast=false', scenarios: scenarios.map(([id]) => `${id}${suffix}`).concat('spectator-live'), history: ['277d1186-f975-4e10-9f71-6716c03b0907', '6f568d1e-ed2e-4d72-965f-73fc62795859'] }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
