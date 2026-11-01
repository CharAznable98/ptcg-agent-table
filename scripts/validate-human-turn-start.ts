import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { runtimeFingerprint } from '../apps/server/src/runtime-fingerprint.ts';
import { practiceOther } from './human-action-fixtures.ts';
import type { CardData, HumanActionView } from '../packages/protocol/src/index.ts';

const directory = resolve(process.argv[2]!); await mkdir(directory);
const app = await buildApp({ dataDir: join(directory, 'data'), systemDir: resolve('system') });
const sourceHash = await runtimeFingerprint(), promptHash = createHash('sha256').update(await readFile('system/prompts.json')).digest('hex');
const report: { sourceHash: string; finalSourceHash?: string; promptHash: string; finalPromptHash?: string; model: string; effort: string; fast: boolean; status: string; cases: Record<string, unknown>[]; error?: string } = { sourceHash, promptHash, model: 'gpt-6.1-terra', effort: 'medium', fast: false, status: 'running', cases: [] };
try {
  for (const mode of ['pre_hand', 'start_order'] as const) {
    const effect = mode === 'pre_hand' ? '当你从牌库抽到这张卡时，在加入手牌前，你可以将这张卡丢弃。' : '自己的回合开始时，在这只宝可梦上放置1个“开始”标记。多个相同时点的效果由你决定处理顺序。';
    const card: CardData = { ...practiceOther, name: mode === 'pre_hand' ? '合成抽牌前窗口' : '合成开始时标记', rulesText: effect };
    const response = await app.inject({ method: 'POST', url: '/api/matches', payload: { mode: 'local', players: ['甲', '乙'].map(name => ({ name, kind: 'human', deck: { cards: [{ count: 60, card }] } })) } });
    assert.equal(response.statusCode, 200, response.body); const match = app.gameService.match(response.json().match.id);
    assert.equal(match.meta.model.model, report.model); assert.equal(match.meta.model.reasoningEffort, report.effort); assert.equal(match.meta.model.fast, false);
    const started = Date.now();
    while (match.state.flow.choice) {
      const choice = match.state.flow.choice;
      const command = choice.kind === 'choose_first' ? { kind: 'choose_first', firstPlayer: 'A' } : { kind: 'initial_placement', active: { zoneId: `${choice.playerId}:hand`, index: 0 }, bench: mode === 'start_order' && choice.playerId === 'A' ? [{ zoneId: 'A:hand', index: 1 }] : [], ...(mode === 'start_order' && choice.playerId === 'A' ? { benchSlots: [4] } : {}) };
      const receipt = await app.inject({ method: 'POST', url: `/api/matches/${match.state.id}/commands`, payload: { playerId: choice.playerId, requestId: randomUUID(), revision: match.state.revision, command } }); assert.equal(receipt.statusCode, 200, receipt.body);
    }
    await app.gameService.prepareHumanTurn(match);
    const controller = app.gameService.humanController(match, 'A');
    const choices: unknown[] = []; let current: HumanActionView | null = controller.view('A');
    const entry: Record<string, unknown> = { name: mode, matchId: match.state.id, actionId: current?.id, choices, status: 'running' }; report.cases.push(entry);
    while (Date.now() - started < 300_000) {
      current = controller.view('A'); assert.ok(current);
      if (current.status === 'awaiting_choice') {
        const choice = current.choice!;
        let selected: string[];
        if (mode === 'pre_hand') {
          assert.equal(match.state.zones['A:hand']!.contents.items.length, 6, '加入手牌前的选择不能在入手之后补做');
          assert.equal(match.state.zones['A:staging']!.contents.items.length, 1, '待抽卡须保留在私有暂存窗口');
          const skip = choice.options.find(option => /不|跳过|保留|加入手牌/u.test(option.label));
          if (skip) selected = [skip.id]; else { assert.equal(choice.minimum, 0); selected = []; }
        } else {
          if (!choices.length) {
            assert.ok(Object.values(match.state.groups).every(group => !group.state.markers['开始']), '人定顺序之前不执行任何开始效果');
            assert.ok(choice.options.some(option => option.position?.zoneId === 'A:active')); assert.ok(choice.options.some(option => option.position?.zoneId === 'A:bench' && option.position.index === 4));
          }
          selected = choice.kind === 'order' ? [...choice.options].sort((a, b) => Number(b.position?.zoneId === 'A:bench') - Number(a.position?.zoneId === 'A:bench')).map(option => option.id)
            : [(choice.options.find(option => option.position?.zoneId === 'A:bench' && option.position.index === 4) ?? choice.options[0])!.id];
        }
        choices.push({ choice, selected });
        await controller.answer(current.id, { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, choiceId: choice.id, selected });
      } else if (current.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(current?.status, 'completed', JSON.stringify(current)); assert.ok(choices.length);
    assert.equal(match.state.zones['A:staging']!.contents.items.length, 0); assert.equal(match.state.zones['A:hand']!.contents.items.length, mode === 'pre_hand' ? 7 : 6);
    if (mode === 'start_order') {
      const events = match.records.filter(record => record.event?.A.action?.id === current!.id && record.request?.command.kind === 'set_state');
      const targets = events.map(record => (record.request!.command as { target: { position: { zoneId: string } } }).target.position.zoneId);
      assert.deepEqual(targets.slice(0, 2), ['A:bench', 'A:active']);
    }
    const state = JSON.parse(await readFile(join(match.directory, 'human-actions', `${current!.id}.json`), 'utf8'));
    Object.assign(entry, { status: 'passed', elapsedMs: Date.now() - started, modelCalls: state.modelCalls, eventIds: current!.eventIds });
    console.log(JSON.stringify({ name: mode, status: entry.status, elapsedMs: entry.elapsedMs, modelCalls: state.modelCalls }));
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await app.close(); report.finalSourceHash = await runtimeFingerprint(); report.finalPromptHash = createHash('sha256').update(await readFile('system/prompts.json')).digest('hex');
  if (report.finalSourceHash !== sourceHash || report.finalPromptHash !== promptHash) { report.status = 'source_changed'; process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ status: report.status, error: report.error, report: join(directory, 'report.json') }));
}
