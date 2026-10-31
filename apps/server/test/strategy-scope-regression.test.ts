import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameService } from '../src/service.ts';

const card = { kind: 'pokemon' as const, name: '合成基础', hp: 60, types: [], stage: '基础', abilities: [], attacks: [], weaknesses: [], resistances: [], retreatCost: 0 };
const deck = { cards: [{ count: 60, card }] };
async function scenario(t: TestContext, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-scope-regression-'));
  const service = new GameService({ dataDir: directory, systemDir: join(directory, 'system'), modelFactory: () => ({ async generate(request) {
    const input = JSON.parse(request.input[0]!.content as string);
    const value = input.stage === 'strategy_initialize'
      ? { plan: `完整计划：稳定推进并维持资源接续；规则版本 ${input.scope.rulesHash}`, changeSummary: '初始化' }
      : input.stage === 'facts_extract' ? { facts: [] }
        : { baseVersion: input.baseVersion, plan: input.latestPolicy.plan, changes: [], changeSummary: '保持完整计划' };
    return { id: 'scope-test', model: 'synthetic', output: [], calls: [{ callId: crypto.randomUUID(), name: 'submit_result', arguments: JSON.stringify(value) }], usage: null };
  } }) });
  await service.init();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const opponent = await service.createOpponent({ deck });
  const input = { mode: 'human_ai' as const, players: [{ kind: 'human' as const, name: 'A', deck }, { kind: 'ai' as const, name: 'B', opponentId: opponent.id }] };
  const oldMatch = service.match((await service.createMatch(input)).match.id);
  if (legacy) {
    oldMatch.meta.strategies.B = { version: 1, content: '旧版尚无完整计划' };
    await oldMatch.saveRuntime();
  } else await service.agent(oldMatch);
  service.rules[0]!.text += '\n合成规则版本更新，用于范围隔离回归。';
  const currentMatch = service.match((await service.createMatch(input)).match.id);
  await service.agent(currentMatch);
  const current = await service.opponents.get(opponent.id);
  return { service, opponentId: opponent.id, oldMatch, current };
}

test('旧规则对局结算不得重新迁移资料库最新策略至旧规则', async t => {
  const { service, opponentId, oldMatch, current } = await scenario(t);
  assert.equal((await oldMatch.command('A', { requestId: 'finish-old', revision: oldMatch.state.revision, command: { kind: 'concede' } })).status, 'committed');
  service.wake(oldMatch);
  await service.drivers.get(oldMatch.state.id)?.promise;
  assert.deepEqual(await service.opponents.get(opponentId), current, '旧局复盘不得改变当前新规则策略或追加旧规则版本');
  assert.equal(oldMatch.meta.summaries.B?.status, 'failed');
  assert.match(oldMatch.meta.summaries.B?.error ?? '', /STRATEGY_SCOPE_CONFLICT/);
});

test('旧规则遗留对局首次恢复缺少计划时不得迁移资料库最新策略至旧规则', async t => {
  const { service, opponentId, oldMatch, current } = await scenario(t, true);
  try { await service.agent(oldMatch); }
  catch (error) { assert.match(String(error), /STRATEGY_SCOPE_CONFLICT/); }
  assert.deepEqual(await service.opponents.get(opponentId), current, '恢复旧上下文不得改写资料库最新范围');
});
