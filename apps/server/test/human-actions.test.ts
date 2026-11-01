import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import type { ModelGateway, ModelReply, ModelRequest } from '../../../packages/agent/src/index.ts';
import type { CardData, CreateMatchResponse, GameCommand, HumanActionChoice, HumanActionIntent, HumanActionView, MatchView, PlayerId } from '../../../packages/protocol/src/index.ts';
import { seedHumanScenario } from '../../../scripts/human-action-fixtures.ts';
import { decodeHumanInput, decodeHumanReview } from './human-context-fixture.ts';

const effect = '查看自己的牌库，从中选择1张卡牌加入手牌，然后重洗牌库。';
const pokemon: CardData = { kind: 'pokemon', name: '合成执行测试宝可梦', hp: 80, types: ['草'], stage: '基础', abilities: [{ name: '合成检索', text: effect }], attacks: [{ name: '合成撞击', energyCost: [], damageText: '10', text: '' }], weaknesses: [], resistances: [], retreatCost: 0 };
const choiceEffect = '最多抽3张牌。';
function call(name: string, args: unknown): ModelReply {
  const callId = randomUUID(), argumentsJson = JSON.stringify(args);
  return { id: randomUUID(), model: 'test', output: [{ type: 'function_call', call_id: callId, name, arguments: argumentsJson }], calls: [{ callId, name, arguments: argumentsJson }], usage: null };
}
const atomic = (command: GameCommand, choiceIds: string[] = [], effectText?: string, effectStep?: string) => call('execute_atomic', { command, choiceIds, ...(effectText ? { effectText } : {}), ...(effectStep ? { effectStep } : {}) });
const sequence = (steps: { command: GameCommand; choiceIds: string[]; effectText?: string }[], finish = true) => call('execute_sequence', { steps, finish });
const cardIds = (fixture: Awaited<ReturnType<typeof setup>>, zoneId: string) => fixture.service.match(fixture.id).state.zones[zoneId]!.contents.items.map(ref => ref ? `${ref.kind}:${ref.id}` : '');
async function confirm(fixture: Awaited<ReturnType<typeof setup>>, actionId: string, selected: string[] = [], number?: number) {
  const waiting = await fixture.settle('awaiting_choice'), choiceId = waiting.choice!.id;
  const response = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${actionId}/choice`, payload: { playerId: 'A', requestId: randomUUID(), revision: waiting.revision, choiceId, selected, ...(number === undefined ? {} : { number }) } });
  assert.equal(response.statusCode, 202, response.body); return choiceId;
}
async function setup(t: TestContext, generate: (request: ModelRequest) => Promise<ModelReply> | ModelReply, card = pokemon) {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-human-actions-'));
  const model: ModelGateway = { generate: async request => {
    const context = JSON.parse(decodeHumanInput(request.input).filter(item => item.role === 'user').at(-1)!.content as string);
    // 本文件原有用例聚焦单次人类行动；开局强制抽牌由独立场景覆盖，不消费行动模型脚本。
    if (context.intent?.kind === 'turn_start') return call('execute_sequence', { steps: [{ command: { kind: 'move', source: { container: { kind: 'zone', zoneId: `${context.snapshot.flow.operator}:deck` }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: `${context.snapshot.flow.operator}:hand` }, index: 'end' } }, choiceIds: [] }], finish: true });
    return generate(request);
  } };
  const app = await buildApp({ dataDir: join(directory, 'data'), systemDir: join(directory, 'system'), modelFactory: () => model });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await app.inject({ method: 'POST', url: '/api/matches', payload: { mode: 'local', players: [{ name: '甲', kind: 'human', deck: { cards: [{ card, count: 60 }] } }, { name: '乙', kind: 'human', deck: { cards: [{ card, count: 60 }] } }] } });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json<CreateMatchResponse>().match.id;
  const view = async (playerId: PlayerId = 'A') => (await app.inject(`/api/matches/${id}?viewer=${playerId}`)).json<MatchView>();
  const command = async (playerId: PlayerId, command: GameCommand) => {
    const response = await app.inject({ method: 'POST', url: `/api/matches/${id}/commands`, payload: { playerId, command, requestId: randomUUID(), revision: (await view(playerId)).revision } });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().status, 'committed', response.body); return response;
  };
  const ready = async () => {
    for (let index = 0; index < 6; index++) {
      const current = await view(), choice = current.flow.choice;
      if (!choice) {
        await app.gameService.prepareHumanTurn(app.gameService.match(id));
        for (let wait = 0; wait < 1000 && app.gameService.humanController(app.gameService.match(id), 'A').view('A')?.status === 'running'; wait++) await new Promise(resolve => setTimeout(resolve, 5));
        return;
      }
      if (choice.kind === 'choose_first') await command(choice.playerId, { kind: 'choose_first', firstPlayer: 'A' });
      else if (choice.kind === 'initial_placement') await command(choice.playerId, { kind: 'initial_placement', active: { zoneId: `${choice.playerId}:hand`, index: 0 }, bench: [] });
      else throw new Error(`unexpected setup ${choice.kind}`);
    }
    throw new Error('setup did not finish');
  };
  const start = async (intent: HumanActionIntent, requestId = randomUUID()) => {
    const payload = { playerId: 'A', intent, requestId, revision: (await view()).revision };
    const response = await app.inject({ method: 'POST', url: `/api/matches/${id}/actions`, payload });
    assert.equal(response.statusCode, 202, response.body); return { action: response.json<HumanActionView>(), payload };
  };
  const current = async () => (await app.inject(`/api/matches/${id}/actions/current?playerId=A`)).json<HumanActionView>();
  const settle = async (status?: HumanActionView['status']) => {
    for (let index = 0; index < 1000; index++) {
      const value = await current();
      if (status ? value.status === status : value.status !== 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`action never settled: ${JSON.stringify(await current())}`);
  };
  return { app, id, directory, view, command, ready, start, current, settle, service: app.gameService };
}

test('已确定的出场步骤一次模型返回，仍逐条记录；跨行动缓存前缀固定且上下文独立', async t => {
  const requests: ModelRequest[] = [];
  const fixture = await setup(t, request => {
    requests.push(request);
    const context = JSON.parse(decodeHumanInput(request.input).filter(item => item.role === 'user').at(-1)!.content as string);
    const index = context.intent.target.index;
    return sequence([
      { command: { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index } }, choiceIds: [] },
      { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index }, relation: 'stack' }, index: 0 } }, choiceIds: [] },
    ]);
  });
  await fixture.ready();
  for (const index of [2, 4]) { await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index } }); assert.equal((await fixture.settle('completed')).eventIds.length, 2); }
  assert.equal(requests.length, 2); assert.equal(requests[0]!.sessionId, requests[1]!.sessionId);
  assert.deepEqual(requests[0]!.input[0], requests[1]!.input[0]);
  assert.equal(requests[1]!.input.filter(item => item.type === 'function_call').length, 0, '缓存标识不携带上一行动工具上下文');
});

test('批处理提交反馈丢失后按原ID恢复，从下一步继续，不重复已成功create_group', async t => {
  let calls = 0;
  const fixture = await setup(t, () => { calls++; return sequence([
    { command: { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 4 } }, choiceIds: [] },
    { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 4 }, relation: 'stack' }, index: 0 } }, choiceIds: [] },
  ]); });
  await fixture.ready(); const match = fixture.service.match(fixture.id), original = match.command.bind(match); let lost = false;
  match.command = async (...args) => { const receipt = await original(...args); if (args[2] && !lost) { lost = true; throw new Error('合成批处理回执丢失'); } return receipt; };
  const { action } = await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 4 } });
  assert.equal((await fixture.settle('failed')).eventIds.length, 1); await fixture.service.humanController(match).close();
  const { HumanActionController } = await import('../src/human-actions.ts');
  const recovered = new HumanActionController({ match, playerId: 'A', modelFactory: () => ({ generate: async () => { throw new Error('不应重新请求模型'); } }), prompts: () => fixture.service.prompts(), wake: () => {} });
  t.after(() => recovered.close()); await recovered.recover(); await recovered.control(action.id, { playerId: 'A', action: 'retry' });
  for (let index = 0; index < 200 && recovered.view('A')!.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(recovered.view('A')!.status, 'completed'); assert.equal(calls, 1); assert.equal(recovered.view('A')!.eventIds.length, 2);
  assert.equal(match.view('A').zones.find(zone => zone.id === 'A:bench')!.items[4]?.kind, 'group');
});

test('批处理遇越权立即停止余下步骤，随机结果后也必须先返回观察', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return sequence([
      { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'B:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, choiceIds: [] },
      { command: { kind: 'random', mode: 'coins', count: 1 }, choiceIds: [], effectText: '投掷1次硬币。' },
    ], false);
    if (calls === 2) return sequence([
      { command: { kind: 'random', mode: 'coins', count: 1 }, choiceIds: [], effectText: '投掷1次硬币。' },
      { command: { kind: 'declare', text: '随机反馈前不应运行此步骤' }, choiceIds: [] },
    ], false);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '硬币', text: '投掷1次硬币。' }] });
  await fixture.ready(); const before = await fixture.view(); await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const done = await fixture.settle('completed'); assert.equal(calls, 3); assert.equal(done.eventIds.length, 1);
  assert.equal((await fixture.view()).events.length, before.events.length + 1); assert.equal((await fixture.view()).events.at(-1)!.commandKind, 'random');
});

test('只有成功的末尾洗牌可直接完成，洗牌后仍有步骤时先返回观察', async t => {
  for (const terminal of [true, false]) await t.test(terminal ? '末尾洗牌' : '洗牌后有步骤', async sub => {
    const effect = '从自己的牌库抽1张牌，然后重洗牌库。'; let calls = 0;
    const fixture = await setup(sub, () => {
      calls++;
      if (calls > 1) return call('finish_action', {});
      return sequence([
        { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, choiceIds: [], effectText: effect },
        { command: { kind: 'shuffle', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, choiceIds: [], effectText: effect },
        ...(!terminal ? [{ command: { kind: 'declare' as const, text: '洗牌反馈前不应执行' }, choiceIds: [] }] : []),
      ]);
    }, { ...pokemon, abilities: [{ name: '补给并洗牌', text: effect }] });
    await fixture.ready(); await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
    const completed = await fixture.settle('completed'); assert.equal(completed.eventIds.length, 2); assert.equal(calls, terminal ? 1 : 2);
  });
});

test('逻辑状态顺序按玩家次序生效，允许同目标双字段，拒绝错序、漏choice和返回旧目标', async t => {
  const text = '按照你决定的顺序，在自己的战斗和备战宝可梦上各放置1个伤害指示物，并将最先处理的宝可梦设为中毒。';
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'order', title: '选择效果处理顺序', options: [{ id: 'active', position: { zoneId: 'A:active', index: 0 } }, { id: 'bench', position: { zoneId: 'A:bench', index: 4 } }], minimum: 2, maximum: 2, resolution: { kind: 'state' } });
    if (calls === 8) return call('finish_action', {});
    const bench = [3, 4, 5, 7].includes(calls);
    return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: bench ? 'A:bench' : 'A:active', index: bench ? 4 : 0 } }, field: calls === 5 ? { key: 'specialConditions', value: ['poisoned'] } : { key: 'damageCounters', value: calls === 7 ? 2 : 1 } }, calls === 3 ? [] : [choiceId], text);
  }, { ...pokemon, abilities: [{ name: '合成顺序效果', text }] });
  await fixture.ready();
  await fixture.command('A', { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 4 } });
  await fixture.command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 4 }, relation: 'stack' }, index: 0 } });
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const waiting = await fixture.settle('awaiting_choice'); choiceId = waiting.choice!.id;
  await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/choice`, payload: { playerId: 'A', requestId: randomUUID(), revision: waiting.revision, choiceId, selected: ['bench', 'active'] } });
  const done = await fixture.settle('completed'); assert.equal(calls, 8); assert.equal(done.eventIds.length, 3);
  const targets = fixture.service.match(fixture.id).records.filter(record => record.event?.A.action?.id === action.id).map(record => (record.request!.command as Extract<GameCommand, { kind: 'set_state' }>).target);
  assert.deepEqual(targets, [{ kind: 'group', position: { zoneId: 'A:bench', index: 4 } }, { kind: 'group', position: { zoneId: 'A:bench', index: 4 } }, { kind: 'group', position: { zoneId: 'A:active', index: 0 } }]);
});

test('人类一步意图完成后停止，事件携带行动边界，原始命令不变且重试不重复执行', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 4 } });
    if (calls === 2) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 4 }, relation: 'stack' }, index: 0 } });
    return call('finish_action', {});
  });
  await fixture.ready();
  const before = await fixture.view();
  const { action, payload } = await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 4 } });
  const done = await fixture.settle('completed'); assert.equal(calls, 3); assert.equal(done.eventIds.length, 2);
  const after = await fixture.view();
  assert.equal(after.zones.find(zone => zone.id === 'A:bench')!.items[4]!.kind, 'group');
  assert.equal(after.zones.find(zone => zone.id === 'A:hand')!.items.length, before.zones.find(zone => zone.id === 'A:hand')!.items.length - 1);
  assert.deepEqual(after.events.slice(-2).map(event => event.action?.id), [action.id, action.id]);
  assert.deepEqual(after.events.slice(-2).map(event => event.commandKind), ['create_group', 'move']);
  const again = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions`, payload });
  assert.equal(again.statusCode, 202); assert.equal(again.json().id, action.id); assert.equal(calls, 3);
  assert.equal((await fixture.view()).revision, after.revision);
  assert.equal((await fixture.app.inject(`/api/matches/${fixture.id}?viewer=B`)).json<MatchView>().humanAction, null);
  assert.equal('humanAction' in (await fixture.app.inject(`/api/matches/${fixture.id}/replay?viewer=A&index=0`)).json(), false);
});

test('已查看牌面不因无关宣告变化而丢失；检索必须等待人选，拒绝换牌和越权并发', async t => {
  let calls = 0; let selectedId = ''; let selectedPosition = 0; let selectionId = '';
  const fixture = await setup(t, request => {
    calls++;
    if (calls === 1) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], effect);
    if (calls === 2) return atomic({ kind: 'declare', text: '合成检索已查看牌库' });
    if (calls === 3) {
      const latest = JSON.parse(decodeHumanInput(request.input).filter(item => item.role === 'user').at(-1)!.content as string);
      const size = latest.snapshot.zones.find((zone: { id: string }) => zone.id === 'A:deck').items.length;
      return call('request_choice', { kind: 'select', title: '选择加入手牌的卡牌', options: Array.from({ length: size }, (_, index) => ({ id: `card-${index}`, position: { zoneId: 'A:deck', index } })), minimum: 1, maximum: 1 });
    }
    if (calls === 4) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [selectedPosition + 1] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [selectionId]);
    if (calls === 5) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [selectedPosition] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [selectionId]);
    if (calls === 6) return atomic({ kind: 'shuffle', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], effect);
    return call('finish_action', {});
  });
  await fixture.ready();
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const waiting = await fixture.settle('awaiting_choice'), choice = waiting.choice!;
  assert.equal(choice.options.length, 46); assert.ok(choice.options.every(option => option.card?.name === pokemon.name));
  assert.equal(calls, 3);
  const forbidden = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/commands`, payload: { playerId: 'A', revision: waiting.revision, requestId: randomUUID(), command: { kind: 'declare', text: '不应并发提交' } } });
  assert.equal(forbidden.statusCode, 409);
  selectionId = choice.id; selectedId = choice.options[2]!.id; selectedPosition = 2;
  const payload = { playerId: 'A', requestId: randomUUID(), revision: waiting.revision, choiceId: choice.id, selected: [selectedId] };
  const answered = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/choice`, payload }); assert.equal(answered.statusCode, 202, answered.body);
  const done = await fixture.settle('completed'); assert.equal(calls, 7);
  const commands = (await fixture.view()).events.filter(event => event.action?.id === action.id).map(event => (event.data as { command: GameCommand }).command);
  const moves = commands.filter(command => command.kind === 'move'); assert.equal(moves.length, 1); assert.equal(moves[0]!.kind === 'move' && moves[0]!.source.range.mode === 'indices' && moves[0]!.source.range.indices[0], 2);
  const repeated = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/choice`, payload }); assert.equal(repeated.statusCode, 202); assert.equal(calls, 7); assert.equal(done.status, 'completed');
});

test('基本行动不能借盲抽或整区移动绕过人类意图，三次失败后暂停且没有改牌桌', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    return atomic(calls % 2 ? { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 10 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }
      : { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } });
  });
  await fixture.ready(); const before = await fixture.view();
  await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 0 } });
  const failed = await fixture.settle('failed'); assert.equal(calls, 3); assert.match(failed.error!, /三次/);
  assert.equal((await fixture.view()).revision, before.revision);
});

test('数量选择不能被忽略或换成其他数量，错误反馈可由代理修正', async t => {
  let calls = 0; let choiceId = '';
  const card: CardData = { ...pokemon, abilities: [{ name: '合成数量', text: choiceEffect }] };
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '抽取数量', options: [], minimum: 0, maximum: 3 });
    if (calls < 4) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: calls === 2 ? 3 : 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId], choiceEffect);
    return call('finish_action', {});
  }, card);
  await fixture.ready(); const before = await fixture.view();
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const waiting = await fixture.settle('awaiting_choice'); choiceId = waiting.choice!.id;
  const answer = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/choice`, payload: { playerId: 'A', requestId: randomUUID(), revision: waiting.revision, choiceId, selected: [], number: 2 } }); assert.equal(answer.statusCode, 202);
  await fixture.settle('completed');
  assert.equal((await fixture.view()).zones.find(zone => zone.id === 'A:hand')!.items.length, before.zones.find(zone => zone.id === 'A:hand')!.items.length + 2);
  assert.equal((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'move').length, 1);
});

test('合法查看对手手牌通过实际 look 授权，未查看前不能给隐藏选项牌面', async t => {
  const text = '查看对手的手牌，然后从中选择1张牌。';
  const card: CardData = { ...pokemon, abilities: [{ name: '合成查看', text }] };
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'select', title: '选择对手手牌', options: [{ id: 'unknown', position: { zoneId: 'B:hand', index: 0 } }], minimum: 1, maximum: 1 });
    if (calls === 2) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'B:hand' }, range: { mode: 'all' } } }, [], text);
    return call('request_choice', { kind: 'select', title: '选择已查看的手牌', options: [{ id: 'known', position: { zoneId: 'B:hand', index: 0 } }], minimum: 1, maximum: 1 });
  }, card);
  await fixture.ready();
  await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const waiting = await fixture.settle('awaiting_choice'); assert.equal(calls, 3); assert.equal(waiting.choice!.options[0]!.card!.name, pokemon.name);
  const opponent = await fixture.view('B'); assert.equal(opponent.humanAction, null);
  const own = await fixture.view(); assert.equal(own.zones.find(zone => zone.id === 'B:hand')!.items[0]!.kind, 'hidden', 'look 不修改持续可见范围');
});

test('取消待选补齐工具反馈，重启保留选择，原行动可显式恢复', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1 || calls === 2) return call('request_choice', { kind: 'select', title: '是否执行可选部分', options: [{ id: 'yes', label: '执行' }, { id: 'no', label: '跳过' }], minimum: 1, maximum: 1 });
    return call('finish_action', {});
  });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  await fixture.settle('awaiting_choice');
  const cancel = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/control`, payload: { playerId: 'A', action: 'cancel' } }); assert.equal(cancel.statusCode, 202); assert.equal(cancel.json().status, 'cancelled');
  const stored = JSON.parse(await readFile(join(fixture.service.match(fixture.id).directory, 'human-actions', `${action.id}.json`), 'utf8'));
  assert.ok(stored.messages.some((message: { type?: string; output?: string }) => message.type === 'function_call_output' && message.output?.includes('cancelled')));
  const retry = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/control`, payload: { playerId: 'A', action: 'retry' } }); assert.equal(retry.statusCode, 202);
  const waiting = await fixture.settle('awaiting_choice'); assert.equal(calls, 2);
  await fixture.service.humanController(fixture.service.match(fixture.id)).close();
  const { HumanActionController } = await import('../src/human-actions.ts');
  const recovered = new HumanActionController({ match: fixture.service.match(fixture.id), modelFactory: () => ({ generate: async () => call('finish_action', {}) }), prompts: () => fixture.service.prompts(), wake: () => {} });
  await recovered.recover(); t.after(() => recovered.close());
  assert.equal(recovered.view('A')!.status, 'awaiting_choice'); assert.deepEqual(recovered.view('A')!.choice, waiting.choice);
  const choice: HumanActionChoice = waiting.choice!;
  await recovered.answer(action.id, { playerId: 'A', requestId: randomUUID(), revision: waiting.revision, choiceId: choice.id, selected: ['no'] });
  for (let index = 0; index < 100 && recovered.view('A')!.status !== 'completed'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(recovered.view('A')!.status, 'completed');
});

test('准备阶段备战槽位严格遵守人类拖放位置，拒绝不对应或占用的槽位', async t => {
  const fixture = await setup(t, () => { throw new Error('准备阶段不得调用模型'); });
  let current = await fixture.view();
  await fixture.command(current.flow.choice!.playerId, { kind: 'choose_first', firstPlayer: 'A' });
  current = await fixture.view();
  const actor = current.flow.choice!.playerId;
  await fixture.command(actor, { kind: 'initial_placement', active: { zoneId: `${actor}:hand`, index: 0 }, bench: [{ zoneId: `${actor}:hand`, index: 1 }], benchSlots: [4] });
  const next = await fixture.view(actor);
  assert.equal(next.zones.find(zone => zone.id === `${actor}:bench`)!.items[0], null);
  assert.equal(next.zones.find(zone => zone.id === `${actor}:bench`)!.items[4]!.kind, 'group');
});

test('顺序选择核对最终稳定牌序，错误顺序不能完成且可沿用原选择机械修正', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'order', title: '选择放回牌库底部的顺序', options: [{ id: 'first', position: { zoneId: 'A:hand', index: 0 } }, { id: 'second', position: { zoneId: 'A:hand', index: 1 } }], minimum: 2, maximum: 2, orderDestination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 'end' } });
    if ([2, 3, 5].includes(calls)) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: calls === 5 ? 'A:deck' : 'A:hand' }, range: { mode: 'indices', indices: [calls === 5 ? 46 : 0] } }, destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 'end' } }, [choiceId]);
    return call('finish_action', {});
  });
  await fixture.ready();
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const waiting = await fixture.settle('awaiting_choice'); choiceId = waiting.choice!.id;
  const reply = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/choice`, payload: { playerId: 'A', requestId: randomUUID(), revision: waiting.revision, choiceId, selected: ['second', 'first'] } }); assert.equal(reply.statusCode, 202);
  await fixture.settle('completed');
  assert.equal(calls, 6);
  const commands = (await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'move').map(event => (event.data as { command: Extract<GameCommand, { kind: 'move' }> }).command);
  assert.deepEqual(commands.map(command => command.source.range.mode === 'indices' ? command.source.range.indices : []), [[0], [0], [46]]);
  const stored = JSON.parse(await readFile(join(fixture.service.match(fixture.id).directory, 'human-actions', `${action.id}.json`), 'utf8'));
  assert.ok(stored.messages.some((message: { output?: string }) => message.output?.includes('实际牌序尚未符合')));
});

test('已提交但反馈丢失的请求取消前按同一ID收敛，不重复执行且解锁后仍保留原件', async t => {
  let calls = 0;
  const fixture = await setup(t, () => { calls++; return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }); });
  await fixture.ready();
  const match = fixture.service.match(fixture.id), original = match.command.bind(match);
  let lost = false;
  match.command = async (...args) => { const receipt = await original(...args); if (args[2] && !lost) { lost = true; throw new Error('合成反馈丢失'); } return receipt; };
  const before = await fixture.view(); const { action } = await fixture.start({ kind: 'draw' });
  const failed = await fixture.settle('failed'); assert.match(failed.error!, /反馈丢失/); assert.ok(match.humanActionLock);
  const cancel = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/control`, payload: { playerId: 'A', action: 'cancel' } });
  assert.equal(cancel.statusCode, 202, cancel.body); assert.equal(cancel.json().status, 'cancelled'); assert.equal(match.humanActionLock, null); assert.equal(calls, 1);
  const after = await fixture.view(); assert.equal(after.revision, before.revision + 1); assert.equal(after.zones.find(zone => zone.id === 'A:hand')!.items.length, before.zones.find(zone => zone.id === 'A:hand')!.items.length + 1);
  assert.equal(after.events.filter(event => event.action?.id === action.id).length, 1);
  const stored = JSON.parse(await readFile(join(match.directory, 'human-actions', `${action.id}.json`), 'utf8'));
  assert.equal(stored.pending, null); assert.ok(stored.messages.some((message: { type?: string; output?: string }) => message.type === 'function_call_output' && message.output?.includes('committed')));
});

test('空finish和无关marker都不能把未实际出牌的意图标成完成', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'set_state', target: { kind: 'player', playerId: 'A' }, field: { key: 'marker', name: '任意标记', value: true } });
    return call('finish_action', {});
  });
  await fixture.ready();
  await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 0 } });
  const failed = await fixture.settle('failed'); assert.equal(calls, 4); assert.match(failed.error!, /三次/);
  assert.equal((await fixture.view()).zones.find(zone => zone.id === 'A:bench')!.items[0], null);
  const current = fixture.service.match(fixture.id);
  const stored = JSON.parse(await readFile(join(current.directory, 'human-actions', `${failed.id}.json`), 'utf8'));
  assert.equal(stored.messages.filter((message: { type?: string; output?: string }) => message.type === 'function_call_output' && message.output?.includes('尚无对应的实际执行结果')).length, 3);
});

test('附着已真实提交后发生卡文替代移动，完成验证依提交证据而非僵硬最终位置', async t => {
  let calls = 0;
  const text = '将此卡附着给宝可梦后，将此卡丢弃。';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [1] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation: 'attached' }, index: 'end' } });
    if (calls === 2) return atomic({ kind: 'move', source: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation: 'attached' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } }, [], text);
    return call('finish_action', {});
  });
  const match = await seedHumanScenario(fixture.service, 'replacement-fixture');
  const source = match.state.zones['A:hand']!.contents.items[1]!;
  assert.equal(source.kind, 'card');
  match.state.definitions[match.state.cards[source.id]!.definitionId] = { kind: 'energy', subtype: 'special', name: '合成替代能量', text };
  await match.saveRuntime();
  const controller = fixture.service.humanController(match, 'A');
  await controller.start({ playerId: 'A', requestId: randomUUID(), revision: match.state.revision, intent: { kind: 'attach', source: { zoneId: 'A:hand', index: 1 }, target: { zoneId: 'A:active', index: 0 } } });
  for (let index = 0; index < 200 && controller.view('A')!.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.view('A')!.status, 'completed'); assert.equal(controller.view('A')!.eventIds.length, 2);
  assert.equal(match.state.groups['practice:A:active:0']!.attached.length, 0);
  assert.equal(match.state.zones['A:discard']!.contents.items.length, 1);
});

test('结束回合必要检查只授予双方战斗宝可梦，不能借机修改备战或任意标记', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'set_turn', phase: 'check', playerId: null });
    if (calls === 2) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:bench', index: 0 } }, field: { key: 'damageCounters', value: 10 } });
    if (calls === 3) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'marker', name: '越权标记', value: true } });
    if (calls === 4) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 1 } });
    return atomic({ kind: 'set_turn', phase: 'turn', playerId: 'B' });
  });
  await fixture.ready();
  await fixture.command('A', { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
  await fixture.command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 0 }, relation: 'stack' }, index: 0 } });
  await fixture.command('A', { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'specialConditions', value: ['poisoned'] } });
  await fixture.start({ kind: 'end_turn' }); const done = await fixture.settle('completed'); assert.equal(calls, 5);
  const view = await fixture.view();
  const active = view.zones.find(zone => zone.id === 'A:active')!.items[0]!, bench = view.zones.find(zone => zone.id === 'A:bench')!.items[0]!;
  assert.equal(active.kind === 'group' && active.state.damageCounters, 1); assert.equal(bench.kind === 'group' && bench.state.damageCounters, 0);
  assert.equal(active.kind === 'group' && active.state.markers['越权标记'], undefined); assert.equal(done.eventIds.length, 3);
});

test('终端工具回执完整，旧failed/completed仅补已知终端回执，修正可再次实际调用模型', async t => {
  let calls = 0;
  const fixture = await setup(t, request => {
    calls++;
    const outputs = new Set(request.input.filter(message => message.type === 'function_call_output').map(message => message.call_id));
    assert.ok(request.input.filter(message => message.type === 'function_call').every(message => outputs.has(message.call_id)), '模型输入不得包含悬空的历史工具调用');
    if (calls === 1) return call('fail_action', { reason: '合成首次拒绝' });
    if (calls === 2) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } });
    return call('finish_action', {});
  });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'draw' }); await fixture.settle('failed');
  const match = fixture.service.match(fixture.id), path = join(match.directory, 'human-actions', `${action.id}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(stored.messages.some((message: { type?: string; output?: string }) => message.type === 'function_call_output' && message.output?.includes('合成首次拒绝')));
  // 合成旧版本遗留的 terminal 缺回执；原子请求回执不删除也不伪造。
  stored.messages = stored.messages.filter((message: { type?: string; output?: string }) => !(message.type === 'function_call_output' && message.output?.includes('合成首次拒绝')));
  await writeFile(path, JSON.stringify(stored));
  await fixture.service.humanController(match).close();
  const { HumanActionController } = await import('../src/human-actions.ts');
  const recovered = new HumanActionController({ match, playerId: 'A', modelFactory: () => ({ generate: async request => {
    calls++;
    const outputs = new Set(request.input.filter(message => message.type === 'function_call_output').map(message => message.call_id));
    assert.ok(request.input.filter(message => message.type === 'function_call').every(message => outputs.has(message.call_id)));
    if (calls === 2) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } });
    return call('finish_action', {});
  } }), prompts: () => fixture.service.prompts(), wake: () => {} });
  t.after(() => recovered.close()); await recovered.recover();
  await recovered.control(action.id, { playerId: 'A', action: 'repair' });
  for (let index = 0; index < 200 && recovered.view('A')!.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(recovered.view('A')!.status, 'completed'); assert.equal(calls, 3);
  const complete = JSON.parse(await readFile(path, 'utf8'));
  const finishId = complete.messages.find((message: { type?: string; name?: string }) => message.type === 'function_call' && message.name === 'finish_action').call_id;
  assert.ok(complete.messages.some((message: { type?: string; call_id?: string }) => message.type === 'function_call_output' && message.call_id === finishId));
  complete.messages = complete.messages.filter((message: { type?: string; call_id?: string }) => !(message.type === 'function_call_output' && message.call_id === finishId));
  await recovered.close(); await writeFile(path, JSON.stringify(complete));
  const second = new HumanActionController({ match, playerId: 'A', modelFactory: () => ({ generate: async request => {
    const outputs = new Set(request.input.filter(message => message.type === 'function_call_output').map(message => message.call_id));
    assert.ok(request.input.filter(message => message.type === 'function_call').every(message => outputs.has(message.call_id))); return call('finish_action', {});
  } }), prompts: () => fixture.service.prompts(), wake: () => {} });
  t.after(() => second.close()); await second.recover(); const revision = match.state.revision;
  await second.control(action.id, { playerId: 'A', action: 'repair' });
  for (let index = 0; index < 200 && second.view('A')!.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(second.view('A')!.status, 'completed'); assert.equal(match.state.revision, revision, '复核已完成动作不能再次抽牌');
});

test('新的人类行动使用当前角色配置，已有动作和旧文件以及AI配置保持原版本', async t => {
  const instructions: string[] = [];
  const fixture = await setup(t, request => { instructions.push(request.instructions); return call('fail_action', { reason: '合成停止' }); });
  await fixture.ready(); const match = fixture.service.match(fixture.id);
  delete match.meta.prompts.humanExecutor;
  const originalAi = { player: match.meta.prompts.player, version: match.meta.prompts.version };
  await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 } }); await fixture.settle('failed');
  const path = join(match.directory, (await readdir(match.directory)).find(name => /^human-action-config-[a-f0-9]+\.json$/u.test(name))!), frozen = await readFile(path, 'utf8');
  const legacy = join(match.directory, 'human-action-config.json'); await writeFile(legacy, '旧冻结文件');
  const prompts = await fixture.service.prompts();
  await fixture.service.savePrompts({ ...prompts, humanExecutor: '修改后的执行代理提示词', feedback: { ...prompts.feedback, humanRetryInstruction: '修改后的重试提示' } });
  await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 } }); await fixture.settle('failed');
  assert.equal(instructions.length, 2); assert.notEqual(instructions[0], instructions[1]); assert.equal(instructions[1], '修改后的执行代理提示词'); assert.equal(await readFile(path, 'utf8'), frozen); assert.equal(await readFile(legacy, 'utf8'), '旧冻结文件');
  assert.deepEqual({ player: match.meta.prompts.player, version: match.meta.prompts.version }, originalAi);
});

async function prepareHandoff(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.ready();
  for (const slot of [0, 4]) {
    await fixture.command('A', { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: slot } });
    await fixture.command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: slot }, relation: 'stack' }, index: 0 } });
  }
  await fixture.command('A', { kind: 'move', source: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation: 'stack' }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } });
  await fixture.command('A', { kind: 'remove_group', position: { zoneId: 'A:active', index: 0 } });
  await fixture.command('A', { kind: 'set_turn', phase: 'turn', playerId: 'B' });
  await fixture.command('B', { kind: 'handoff', to: 'A', reason: '请从备战区选择1只宝可梦放到空战斗场，然后归还操作权。' });
}

test('受托替补遵守拖放source/target，归还后立即完成且不结束对手回合', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:bench' }, range: { mode: 'indices', indices: [4] } }, destination: { container: { kind: 'zone', zoneId: 'A:active' }, index: 0 } });
    return atomic({ kind: 'handoff', to: 'B', returning: true, reason: '已完成替补选择' });
  });
  await prepareHandoff(fixture);
  const before = await fixture.view();
  await fixture.start({ kind: 'resolve_handoff', source: { zoneId: 'A:bench', index: 4 }, target: { zoneId: 'A:active', index: 0 } });
  const done = await fixture.settle('completed'); assert.equal(calls, 2);
  const current = await fixture.view(); assert.equal(current.flow.operator, 'B'); assert.equal(current.flow.turnOwner, 'B'); assert.equal(current.flow.turnNumber, before.flow.turnNumber); assert.equal(current.flow.choice, null); assert.equal(current.flow.handoffReturnTo, null);
  assert.equal(current.zones.find(zone => zone.id === 'A:bench')!.items[4], null); assert.equal(done.eventIds.length, 2);
});

test('受托处理没有source时必须请求人选替补，不能自行选另一只或set_turn', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'select', title: '选择新的战斗宝可梦', options: [{ id: 'zero', position: { zoneId: 'A:bench', index: 0 } }, { id: 'four', position: { zoneId: 'A:bench', index: 4 } }], minimum: 1, maximum: 1 });
    if (calls === 2) return atomic({ kind: 'set_turn', phase: 'turn', playerId: 'A' });
    if (calls === 3 || calls === 4) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:bench' }, range: { mode: 'indices', indices: [calls === 3 ? 0 : 4] } }, destination: { container: { kind: 'zone', zoneId: 'A:active' }, index: 0 } }, [choiceId]);
    return atomic({ kind: 'handoff', to: 'B', returning: true, reason: '已完成替补选择' });
  });
  await prepareHandoff(fixture);
  const { action } = await fixture.start({ kind: 'resolve_handoff' });
  const waiting = await fixture.settle('awaiting_choice'); choiceId = waiting.choice!.id;
  const answer = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/choice`, payload: { playerId: 'A', requestId: randomUUID(), revision: waiting.revision, choiceId, selected: ['four'] } }); assert.equal(answer.statusCode, 202);
  await fixture.settle('completed'); assert.equal(calls, 5);
  const current = await fixture.view(); assert.equal(current.flow.turnOwner, 'B'); assert.ok(current.zones.find(zone => zone.id === 'A:bench')!.items[0]); assert.equal(current.zones.find(zone => zone.id === 'A:bench')!.items[4], null);
});

test('local双人各自保留行动状态：A交权等待B，B执行受托并归还后A继续，不覆盖上下文', async t => {
  const delegated = '对手从自己的牌库抽1张牌。';
  const card: CardData = { ...pokemon, abilities: [{ name: '合成委托', text: delegated }] };
  let aCalls = 0, bCalls = 0;
  const fixture = await setup(t, request => {
    const setupInput = JSON.parse(decodeHumanInput(request.input).find(message => message.role === 'user' && JSON.parse(message.content as string).intent)!.content as string);
    if (setupInput.intent.kind === 'ability') {
      aCalls++;
      return aCalls === 1 ? atomic({ kind: 'handoff', to: 'B', reason: 'B从自己的牌库抽1张牌，然后归还给A' }, [], delegated) : call('finish_action', {});
    }
    bCalls++;
    return bCalls === 1 ? atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'B:deck' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'B:hand' }, index: 'end' } }, [], delegated) : atomic({ kind: 'handoff', to: 'A', returning: true, reason: 'B已完成受托抽牌' });
  }, card);
  await fixture.ready();
  const before = await fixture.view('B'); const { action: actionA } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  for (let index = 0; index < 200 && fixture.service.match(fixture.id).state.flow.operator !== 'B'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  const currentB = await fixture.view('B'); assert.equal(currentB.flow.operator, 'B');
  const startB = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions`, payload: { playerId: 'B', requestId: randomUUID(), revision: currentB.revision, intent: { kind: 'resolve_handoff' } } }); assert.equal(startB.statusCode, 202, startB.body);
  const actionB = startB.json<HumanActionView>(); assert.notEqual(actionA.id, actionB.id);
  await fixture.settle('completed');
  for (let index = 0; index < 200 && (await fixture.view('B')).humanAction?.status !== 'completed'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await fixture.view()).humanAction!.id, actionA.id); assert.equal((await fixture.view()).humanAction!.status, 'completed');
  assert.equal((await fixture.view('B')).humanAction!.id, actionB.id); assert.equal((await fixture.view('B')).humanAction!.status, 'completed');
  assert.equal((await fixture.view('B')).zones.find(zone => zone.id === 'B:hand')!.items.length, before.zones.find(zone => zone.id === 'B:hand')!.items.length + 1);
  assert.equal(fixture.service.match(fixture.id).humanActionLocks.size, 0); assert.equal(aCalls, 2); assert.equal(bCalls, 2);
});

test('特性结算整组弃置后可交权让对手自己选择奖赏，归还后继续原行动且不重复拿取', async t => {
  const selfKnockout = '合成效果：令这只宝可梦昏厥。';
  const card: CardData = { ...pokemon, abilities: [{ name: '合成自我昏厥', text: selfKnockout }] };
  let aCalls = 0, bCalls = 0, prizeChoice = '';
  const fixture = await setup(t, request => {
    const context = JSON.parse(decodeHumanInput(request.input).find(message => message.role === 'user' && JSON.parse(message.content as string).intent)!.content as string);
    if (context.intent.kind === 'ability') {
      aCalls++;
      if (aCalls === 1) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:bench', index: 0 } }, field: { key: 'damageCounters', value: 8 } }, [], selfKnockout);
      if (aCalls === 2) return sequence([
        { command: { kind: 'move', source: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 0 }, relation: 'stack' }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } }, choiceIds: [] },
        { command: { kind: 'remove_group', position: { zoneId: 'A:bench', index: 0 } }, choiceIds: [] },
      ], false);
      if (aCalls === 3) return call('fail_action', { reason: '此前宿主拒绝了奖赏交权，等待修正' });
      if (aCalls === 4) {
        assert.deepEqual(decodeHumanReview(request.input)!.availableSettlementHandoffs, ['B']);
        return atomic({ kind: 'handoff', to: 'B', reason: '请自行选择1张奖赏卡，然后归还操作权' });
      }
      // 归还后再次凭旧弃置记录交权应被拒绝，不能重复发起奖赏处理。
      if (aCalls === 5) return atomic({ kind: 'handoff', to: 'B', reason: '重复拿取奖赏' });
      return call('finish_action', {});
    }
    bCalls++;
    if (bCalls === 1) return call('request_choice', { kind: 'select', title: '选择自己的奖赏卡', options: [0, 5].map(index => ({ id: `prize-${index}`, position: { zoneId: 'B:prizes', index } })), minimum: 1, maximum: 1 });
    if (bCalls === 2) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'B:prizes' }, range: { mode: 'indices', indices: [5] } }, destination: { container: { kind: 'zone', zoneId: 'B:hand' }, index: 'end' } }, [prizeChoice]);
    return atomic({ kind: 'handoff', to: 'A', returning: true, reason: '已拿取奖赏' });
  }, card);
  await fixture.ready();
  await fixture.command('A', { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
  await fixture.command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 0 }, relation: 'stack' }, index: 0 } });
  const beforeB = await fixture.view('B'), originalPrizes = cardIds(fixture, 'B:prizes');
  const { action: actionA } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:bench', index: 0 }, abilityIndex: 0 });
  await fixture.settle('failed');
  const retried = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${actionA.id}/control`, payload: { playerId: 'A', action: 'retry' } });
  assert.equal(retried.statusCode, 202, retried.body);
  for (let i = 0; i < 200 && fixture.service.match(fixture.id).state.flow.operator !== 'B' && (await fixture.current()).status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const currentB = await fixture.view('B');
  assert.equal(currentB.flow.operator, 'B', '整组昏厥弃置后应允许对手拿自己的奖赏，不要求卡文额外写出奖赏流程');
  assert.equal(currentB.flow.turnOwner, 'A');
  assert.deepEqual(cardIds(fixture, 'B:prizes'), originalPrizes, '交权不能替对手选择奖赏');
  const startedB = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions`, payload: { playerId: 'B', requestId: randomUUID(), revision: currentB.revision, intent: { kind: 'resolve_handoff' } } });
  assert.equal(startedB.statusCode, 202, startedB.body);
  for (let i = 0; i < 200 && (await fixture.view('B')).humanAction?.status !== 'awaiting_choice'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const waitingB = (await fixture.view('B')).humanAction!;
  prizeChoice = waitingB.choice!.id;
  const answer = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${startedB.json<HumanActionView>().id}/choice`, payload: { playerId: 'B', requestId: randomUUID(), revision: waitingB.revision, choiceId: prizeChoice, selected: ['prize-5'] } });
  assert.equal(answer.statusCode, 202, answer.body);
  await fixture.settle('completed');
  const afterA = await fixture.view(), afterB = await fixture.view('B');
  assert.equal(afterA.humanAction!.id, actionA.id);
  assert.equal(afterA.flow.operator, 'A'); assert.equal(afterA.flow.turnOwner, 'A'); assert.equal(afterA.flow.turnNumber, beforeB.flow.turnNumber);
  assert.equal(cardIds(fixture, 'B:prizes')[5], ''); assert.equal(cardIds(fixture, 'B:prizes')[0], originalPrizes[0]);
  assert.equal(afterB.zones.find(zone => zone.id === 'B:hand')!.items.length, beforeB.zones.find(zone => zone.id === 'B:hand')!.items.length + 1);
  assert.equal(aCalls, 6); assert.equal(bCalls, 3);
});

test('交权理由声称拿奖赏但没有本行动的整组弃置事实，仍拒绝交权', async t => {
  let calls = 0;
  const fixture = await setup(t, () => ++calls === 1
    ? atomic({ kind: 'handoff', to: 'B', reason: '对手需要拿取1张奖赏卡' })
    : call('fail_action', { reason: '没有交权依据' }));
  await fixture.ready();
  await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const done = await fixture.settle('failed');
  assert.equal(done.eventIds.length, 0); assert.equal((await fixture.view()).flow.operator, 'A'); assert.equal(calls, 2);
});

test('修正从原子与序列状态记录重建数量进度，按增量核验且不重复放置伤害指示物', async t => {
  const text = '合成效果：按玩家选择的数量给已指定宝可梦放置伤害指示物。';
  const card: CardData = { ...pokemon, abilities: [{ name: '合成数量状态', text }] };
  let calls = 0, first = '', second = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1 || calls === 3) return call('request_choice', { kind: 'number', title: '放置几个伤害指示物', options: [], minimum: 1, maximum: 3, effectText: text });
    if (calls === 2) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 3 } }, [first], text);
    if (calls === 4) return sequence([{ command: { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 5 } }, choiceIds: [second], effectText: text }], false);
    if (calls === 5) return call('fail_action', { reason: '模拟结算中断，需要核对全部已执行数量' });
    if (calls === 6) return call('finish_action', {});
    return call('fail_action', { reason: '旧记账仍阻止完成' });
  }, card);
  await fixture.ready();
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0, target: { zoneId: 'B:active', index: 0 } });
  first = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 3);
  second = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2);
  await fixture.settle('failed');
  const revision = (await fixture.view()).revision;
  const retried = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/control`, payload: { playerId: 'A', action: 'retry' } });
  assert.equal(retried.statusCode, 202, retried.body);
  const done = await fixture.settle();
  assert.equal(done.status, 'completed', '成功的状态操作必须记入相应数量选择，修正不能要求重复放置');
  assert.equal((await fixture.view()).revision, revision, '修正记账不应重放牌桌操作');
  const active = (await fixture.view()).zones.find(zone => zone.id === 'B:active')!.items[0]!;
  assert.equal(active.kind === 'group' && active.state.damageCounters, 5); assert.equal(calls, 6);
});

async function legacyQuantityFault(t: TestContext, recover: (index: number, request: ModelRequest) => ModelReply) {
  const text = '合成效果：按玩家选择的数量给指定宝可梦放置伤害指示物。';
  if (pokemon.kind !== 'pokemon') throw new Error('pokemon fixture');
  const recoveryCard: CardData = { ...pokemon, abilities: [{ name: '合成恢复', text }] };
  let calls = 0, choiceId = '';
  const fixture = await setup(t, request => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '放置数量', options: [], minimum: 1, maximum: 3, effectText: text });
    if (calls === 2) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 3 } }, [choiceId], text);
    if (calls === 3) return call('fail_action', { reason: '模拟旧运行中断' });
    return recover(calls - 3, request);
  }, recoveryCard);
  await fixture.ready();
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0, target: { zoneId: 'B:active', index: 0 } });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 3); await fixture.settle('failed');
  // 注入旧版本曾允许的重复提交事实，走真实MatchRuntime，不改造牌桌或伪造成功回执。
  const match = fixture.service.match(fixture.id), command: GameCommand = { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 6 } };
  match.lockHumanAction(action);
  const receipt = await match.command('A', { requestId: randomUUID(), revision: match.state.revision, command }, action);
  assert.equal(receipt.status, 'committed'); if (receipt.status !== 'committed') throw new Error('legacy fixture');
  match.unlockHumanAction('A', action.id);
  const path = join(match.directory, 'human-actions', `${action.id}.json`), saved = JSON.parse(await readFile(path, 'utf8')), callId = randomUUID();
  saved.messages.push({ type: 'function_call', call_id: callId, name: 'execute_atomic', arguments: JSON.stringify({ command, choiceIds: [choiceId], effectText: text }) }, { type: 'function_call_output', call_id: callId, output: JSON.stringify(receipt) });
  saved.view.eventIds.push(receipt.eventId); await writeFile(path, JSON.stringify(saved));
  await fixture.service.humanController(match, 'A').recover();
  return { ...fixture, action, choiceId, wrongEvent: receipt.eventId, match, path, text };
}

for (const mode of ['explicit', 'automatic'] as const) test(`代理修正${mode === 'explicit' ? '选择最近恢复点' : '一次点击自动审查并整段恢复'}，保留数量抉择和原始历史`, async t => {
  let fixture: Awaited<ReturnType<typeof legacyQuantityFault>>;
  fixture = await legacyQuantityFault(t, index => {
    if (mode === 'explicit') return index === 1 ? call('restore_action', { beforeEventId: fixture.wrongEvent, reason: '旧操作重复消费同一次数量选择，需要撤销第二次放置' }) : call('finish_action', {});
    if (index <= 2) return call('fail_action', { reason: '需要修正旧记录' });
    if (index === 3) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 3 } }, [fixture.choiceId], fixture.text);
    return call('finish_action', {});
  });
  const original = await readFile(join(fixture.match.directory, 'journal.jsonl'), 'utf8');
  const retried = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${fixture.action.id}/control`, payload: { playerId: 'A', action: 'retry' } });
  assert.equal(retried.statusCode, 202, retried.body);
  const done = await fixture.settle(); assert.equal(done.status, 'completed', done.error);
  const active = (await fixture.view()).zones.find(zone => zone.id === 'B:active')!.items[0]!;
  assert.equal(active.kind === 'group' && active.state.damageCounters, 3);
  assert.ok(fixture.match.meta.revoked[fixture.wrongEvent]);
  assert.equal(fixture.match.records.filter(record => record.request?.command.kind === 'system_restore').length, 1);
  assert.ok((await readFile(join(fixture.match.directory, 'journal.jsonl'), 'utf8')).startsWith(original));
  const saved = JSON.parse(await readFile(fixture.path, 'utf8'));
  assert.equal(saved.answers.length, 1); assert.equal(saved.answers[0].choice.id, fixture.choiceId); assert.equal(saved.answers[0].number, 3);
  assert.equal(saved.answers[0].quantityUses[0].count, 3);
});

test('回滚提交后反馈丢失并重启，沿原pendingRecovery收敛，不重复恢复或再次选数量', async t => {
  let fixture: Awaited<ReturnType<typeof legacyQuantityFault>>;
  fixture = await legacyQuantityFault(t, () => call('restore_action', { beforeEventId: fixture.wrongEvent, reason: '撤销重复的状态放置' }));
  const restore = fixture.match.restoreHumanAction.bind(fixture.match);
  fixture.match.restoreHumanAction = async (...args) => { await restore(...args); throw new Error('模拟恢复成功后反馈丢失'); };
  const started = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${fixture.action.id}/control`, payload: { playerId: 'A', action: 'retry' } }); assert.equal(started.statusCode, 202);
  await fixture.settle('failed');
  const pending = JSON.parse(await readFile(fixture.path, 'utf8')).pendingRecovery; assert.ok(pending);
  const replacement = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions`, payload: { playerId: 'A', requestId: randomUUID(), revision: fixture.match.state.revision, intent: { kind: 'end_turn' } } });
  assert.equal(replacement.statusCode, 409, '恢复结果未知时不得用新行动覆盖pendingRecovery');
  assert.equal((await fixture.current()).id, fixture.action.id);
  await fixture.app.close();
  const app = await buildApp({ dataDir: join(fixture.directory, 'data'), systemDir: join(fixture.directory, 'system'), modelFactory: () => ({ generate: async () => call('finish_action', {}) }) });
  t.after(() => app.close());
  const retry = await app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${fixture.action.id}/control`, payload: { playerId: 'A', action: 'retry' } }); assert.equal(retry.statusCode, 202, retry.body);
  const controller = app.gameService.humanController(app.gameService.match(fixture.id), 'A');
  for (let i = 0; i < 200 && controller.view('A')?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.view('A')?.status, 'completed');
  const match = app.gameService.match(fixture.id);
  assert.equal(match.records.filter(record => record.request?.command.kind === 'system_restore').length, 1);
  assert.equal(match.records.filter(record => record.request?.requestId === pending.requestId).length, 1);
  assert.equal(JSON.parse(await readFile(fixture.path, 'utf8')).pendingRecovery, undefined);
});

test('旧行动耗尽额度后，代理修正有独立有限额度且保留累计调用记录', async t => {
  let fixture: Awaited<ReturnType<typeof legacyQuantityFault>>;
  fixture = await legacyQuantityFault(t, index => index === 1 ? call('restore_action', { beforeEventId: fixture.wrongEvent, reason: '恢复旧状态错误' }) : call('finish_action', {}));
  const saved = JSON.parse(await readFile(fixture.path, 'utf8')); saved.modelCalls = 128; await writeFile(fixture.path, JSON.stringify(saved));
  await fixture.service.humanController(fixture.match, 'A').recover();
  const response = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${fixture.action.id}/control`, payload: { playerId: 'A', action: 'retry' } }); assert.equal(response.statusCode, 202);
  const done = await fixture.settle(); assert.equal(done.status, 'completed', done.error);
  const final = JSON.parse(await readFile(fixture.path, 'utf8'));
  assert.equal(final.modelCalls, 130); assert.equal(final.recovery.modelCalls, 2);
});

test('原容器逆序只移动必要卡牌，原位已满足的第三张无需重复移动或重新确认', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'order', title: '从牌库顶开始排序', options: [0, 1, 2].map(index => ({ id: `top${index}`, position: { zoneId: 'A:deck', index } })), minimum: 3, maximum: 3 });
    if (calls === 2 || calls === 3) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [2] } }, destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: calls - 2 } }, [choiceId]);
    return call('finish_action', {});
  });
  await fixture.ready(); const initial = cardIds(fixture, 'A:deck').slice(0, 3);
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id;
  await confirm(fixture, action.id, ['top2', 'top1', 'top0']);
  await fixture.settle('completed');
  assert.equal(calls, 4); assert.deepEqual(cardIds(fixture, 'A:deck').slice(0, 3), initial.reverse());
  assert.equal((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'move').length, 2);
});

test('同一排序选择可将全部卡牌移入暂存后逐张回插，选牌权限不会被首次移动消耗', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'order', title: '从牌库顶开始排序', options: [0, 1, 2].map(index => ({ id: `top${index}`, position: { zoneId: 'A:deck', index } })), minimum: 3, maximum: 3, orderDestination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 0 } });
    if (calls === 2) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 3 } }, destination: { container: { kind: 'zone', zoneId: 'A:staging' }, index: 'end' } }, [choiceId]);
    if (calls >= 3 && calls <= 5) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:staging' }, range: { mode: 'indices', indices: [5 - calls] } }, destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: calls - 3 } }, [choiceId]);
    return call('finish_action', {});
  });
  await fixture.ready(); const initial = cardIds(fixture, 'A:deck').slice(0, 3);
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id;
  await confirm(fixture, action.id, ['top2', 'top1', 'top0']);
  await fixture.settle('completed');
  assert.equal(calls, 6); assert.deepEqual(cardIds(fixture, 'A:deck').slice(0, 3), initial.reverse());
  assert.deepEqual(cardIds(fixture, 'A:staging'), []);
});

test('数量选择的同一抽牌路径只提交一次，重复引用或省略引用都不能多抽', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '抽取数量', options: [], minimum: 0, maximum: 3 });
    if (calls <= 4) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, calls === 4 ? [] : [choiceId], choiceEffect);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成数量', text: choiceEffect }] });
  await fixture.ready(); const initial = cardIds(fixture, 'A:hand').length;
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id;
  await confirm(fixture, action.id, [], 2); await fixture.settle('completed');
  assert.equal(calls, 5); assert.equal(cardIds(fixture, 'A:hand').length, initial + 2);
  assert.equal((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'move').length, 1);
});

test('数量许可按来源去向分开记账，同一人选数量可用于弃N再抽N', async t => {
  let calls = 0, numberId = '', cardsId = '';
  const text = '选择最多3张自己的手牌丢弃，然后抽出相同张数的卡牌。';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '弃牌与抽牌数量', options: [], minimum: 0, maximum: 3 });
    if (calls === 2) return call('request_choice', { kind: 'select', title: '选择丢弃的卡牌', options: [0, 1, 2, 3, 4, 5].map(index => ({ id: `hand${index}`, position: { zoneId: 'A:hand', index } })), minimum: 2, maximum: 2 });
    if (calls === 3) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0, 1] } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } }, [numberId, cardsId], text);
    if (calls === 4) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [numberId], text);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成换牌', text }] });
  await fixture.ready(); const initial = cardIds(fixture, 'A:hand').length;
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  numberId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2);
  cardsId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['hand0', 'hand1']);
  await fixture.settle('completed'); assert.equal(calls, 5);
  assert.equal(cardIds(fixture, 'A:hand').length, initial); assert.equal(cardIds(fixture, 'A:discard').length, 2);
});

test('选择1张加入手牌不能借range.all、完整卡文或省略choiceId搬空牌库', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], effect);
    if (calls === 2) return call('request_choice', { kind: 'select', title: '选择一张', options: [0, 1].map(index => ({ id: `card${index}`, position: { zoneId: 'A:deck', index } })), minimum: 1, maximum: 1 });
    if (calls === 3 || calls === 4) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, calls === 3 ? [choiceId] : [], effect);
    if (calls === 5) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId], effect);
    return call('finish_action', {});
  });
  await fixture.ready(); const initial = cardIds(fixture, 'A:hand').length;
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['card0']);
  await fixture.settle('completed'); assert.equal(calls, 6); assert.equal(cardIds(fixture, 'A:hand').length, initial + 1);
});

test('人选随机次数不能省略引用、换数量或重复消费，实际只投掷确认的两次', async t => {
  let calls = 0, choiceId = ''; const text = '最多投掷3次硬币。';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '投掷次数', options: [], minimum: 0, maximum: 3 });
    if (calls <= 6) return atomic({ kind: 'random', mode: 'coins', count: calls <= 3 ? 3 : 2 }, [2, 6].includes(calls) ? [] : [choiceId], text);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成硬币', text }] });
  await fixture.ready();
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2);
  await fixture.settle('completed'); assert.equal(calls, 7);
  const events = (await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random');
  assert.equal(events.length, 1); assert.equal(((events[0]!.data as { result: { coins: unknown[] } }).result.coins).length, 2);
});

test('攻击后的双方战斗宝可梦检查可处理灼伤睡眠硬币，不增加模型或人的目标选择', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'declare', text: '使用合成撞击。' });
    if (calls === 2) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 1 } });
    if (calls === 3) return atomic({ kind: 'set_turn', phase: 'check', playerId: null });
    if (calls === 4) return atomic({ kind: 'random', mode: 'coins', count: 1 });
    if (calls === 5) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'specialConditions', value: [] } });
    return atomic({ kind: 'set_turn', phase: 'turn', playerId: 'B' });
  });
  await fixture.ready();
  await fixture.command('A', { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'specialConditions', value: ['burned', 'asleep'] } });
  const { action } = await fixture.start({ kind: 'attack', source: { zoneId: 'A:active', index: 0 }, attackIndex: 0, target: { zoneId: 'B:active', index: 0 } });
  await fixture.settle('completed'); assert.equal(calls, 6);
  assert.equal((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random').length, 1);
});

test('结束回合不能以回合号增长自证完成，必须检查后交给固定对手', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1 || calls === 3) return atomic({ kind: 'set_turn', phase: 'turn', playerId: 'A' });
    if (calls === 2) return atomic({ kind: 'set_turn', phase: 'check', playerId: null });
    return atomic({ kind: 'set_turn', phase: 'turn', playerId: 'B' });
  });
  await fixture.ready(); const initial = (await fixture.view()).flow.turnNumber;
  const { action } = await fixture.start({ kind: 'end_turn' });
  await fixture.settle('completed'); const result = await fixture.view();
  assert.equal(calls, 4); assert.equal(result.flow.turnNumber, initial + 1); assert.equal(result.flow.turnOwner, 'B');
  assert.equal(result.events.filter(event => event.action?.id === action.id).length, 2);
});

test('对手确认终局后原行动无需取回操作权或再调用模型即可完成并释放锁', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'declare', text: '使用合成终局撞击。' });
    if (calls === 2) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 8 } });
    if (calls === 3) return atomic({ kind: 'move', source: { container: { kind: 'group', position: { zoneId: 'B:active', index: 0 }, relation: 'stack' }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'B:discard' }, index: 'end' } });
    if (calls === 4) return atomic({ kind: 'remove_group', position: { zoneId: 'B:active', index: 0 } });
    if (calls === 5) return atomic({ kind: 'report_result', result: { kind: 'win', winner: 'A', reason: '合成终局，对方场上已无宝可梦' } });
    throw new Error('确认终局后不应再调用模型');
  }, { ...pokemon, attacks: [{ name: '合成终局撞击', energyCost: [], damageText: '80', text: '' }] });
  await fixture.ready(); await fixture.start({ kind: 'attack', source: { zoneId: 'A:active', index: 0 }, attackIndex: 0, target: { zoneId: 'B:active', index: 0 } });
  for (let index = 0; index < 1000 && (await fixture.view()).flow.phase !== 'result_pending'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await fixture.view()).flow.phase, 'result_pending');
  await fixture.command('B', { kind: 'confirm_result', agree: true });
  await fixture.settle('completed'); assert.equal(calls, 5); assert.equal(fixture.service.match(fixture.id).humanActionLocks.size, 0);
});

test('数量作用范围只绑定人选步骤，弃N后固定抽2不需要复用N', async t => {
  let calls = 0, numberId = '', cardsId = '';
  const text = '选择最多3张自己的手牌丢弃，然后抽2张牌。';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '弃牌数量', options: [], minimum: 0, maximum: 3, quantityScopes: [{ kind: 'move', source: { kind: 'zone', zoneId: 'A:hand' }, destination: { kind: 'zone', zoneId: 'A:discard' } }] });
    if (calls === 2) return call('request_choice', { kind: 'select', title: '选择丢弃的卡牌', options: [0, 1].map(index => ({ id: `hand${index}`, position: { zoneId: 'A:hand', index } })), minimum: 1, maximum: 1 });
    if (calls === 3) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } }, [numberId, cardsId], text);
    if (calls === 4) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [], text);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成弃牌补给', text }] });
  await fixture.ready(); const initial = cardIds(fixture, 'A:hand').length;
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  numberId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 1);
  cardsId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['hand0']);
  await fixture.settle('completed'); assert.equal(calls, 5);
  assert.equal(cardIds(fixture, 'A:hand').length, initial + 1); assert.equal(cardIds(fixture, 'A:discard').length, 1);
});

test('招式人选投N次后宝可梦检查固定投1次，不全局套用此前数量许可', async t => {
  let calls = 0, choiceId = ''; const text = '最多投掷3次硬币。';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '招式硬币次数', options: [], minimum: 0, maximum: 3, quantityScopes: [{ kind: 'random', mode: 'coins' }] });
    if (calls === 2) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [choiceId], text);
    if (calls === 3) return atomic({ kind: 'set_turn', phase: 'check', playerId: null });
    if (calls === 4) return atomic({ kind: 'random', mode: 'coins', count: 1 });
    if (calls === 5) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'specialConditions', value: [] } });
    return atomic({ kind: 'set_turn', phase: 'turn', playerId: 'B' });
  }, { ...pokemon, attacks: [{ name: '合成硬币招式', energyCost: [], damageText: '', text }] });
  await fixture.ready();
  await fixture.command('A', { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'specialConditions', value: ['burned'] } });
  const { action } = await fixture.start({ kind: 'attack', source: { zoneId: 'A:active', index: 0 }, attackIndex: 0, target: { zoneId: 'B:active', index: 0 } });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2);
  await fixture.settle('completed'); assert.equal(calls, 6);
  const commands = (await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random').map(event => (event.data as { command: Extract<GameCommand, { kind: 'random' }> }).command);
  assert.deepEqual(commands.map(command => command.count), [2, 1]);
});

test('旧数量许可从已有成功回执恢复路径账本，重启重试不重复抽牌且不改原始记录', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '抽取数量', options: [], minimum: 0, maximum: 3 });
    if (calls === 2) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId], choiceEffect);
    return call('fail_action', { reason: '合成中断，成功步骤已保留' });
  }, { ...pokemon, abilities: [{ name: '合成数量', text: choiceEffect }] });
  await fixture.ready(); const initial = cardIds(fixture, 'A:hand').length;
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2); await fixture.settle('failed');
  const match = fixture.service.match(fixture.id), originalRecords = JSON.stringify(match.records);
  await fixture.service.humanController(match).close();
  const path = join(match.directory, 'human-actions', `${action.id}.json`), state = JSON.parse(await readFile(path, 'utf8'));
  delete state.answers[0].quantityUses; await writeFile(path, JSON.stringify(state));
  const { HumanActionController } = await import('../src/human-actions.ts');
  let resumedCalls = 0;
  const recovered = new HumanActionController({ match, modelFactory: () => ({ generate: async () => ++resumedCalls === 1 ? atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId], choiceEffect) : call('finish_action', {}) }), prompts: () => fixture.service.prompts(), wake: () => {} });
  await recovered.recover(); t.after(() => recovered.close());
  await recovered.control(action.id, { playerId: 'A', action: 'retry' });
  for (let index = 0; index < 1000 && recovered.view('A')!.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(recovered.view('A')!.status, 'completed'); assert.equal(resumedCalls, 2);
  assert.equal(cardIds(fixture, 'A:hand').length, initial + 2); assert.equal(JSON.stringify(match.records), originalRecords);
});

const segmentedEffect = '你可以选择投掷1至3次硬币。然后投掷1次硬币。';
const optionalCoinStep = '你可以选择投掷1至3次硬币';
const fixedCoinStep = '然后投掷1次硬币';
const coinNumberChoice = (effectStep = optionalCoinStep) => ({ kind: 'number', title: '第一次硬币次数', options: [], minimum: 1, maximum: 3, effectText: segmentedEffect, quantityScopes: [{ kind: 'random', mode: 'coins', effectStep }] });

test('同阶段同模式的可变与固定硬币步骤按原文分句区分，实际执行2次后固定1次', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', coinNumberChoice());
    if (calls === 2) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [choiceId], segmentedEffect, optionalCoinStep);
    if (calls === 3) return atomic({ kind: 'random', mode: 'coins', count: 1 }, [], segmentedEffect, fixedCoinStep);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成分段硬币', text: segmentedEffect }] });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2); await fixture.settle('completed');
  assert.equal(calls, 4);
  assert.deepEqual((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random').map(event => (event.data as { result: { coins: unknown[] } }).result.coins.length), [2, 1]);
});

test('效果分句不能自造或截短，已确认步骤不能借新step引用或漏choiceId重放', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', coinNumberChoice('random-step-1'));
    if (calls === 2) return call('request_choice', coinNumberChoice());
    if (calls === 3 || calls === 7) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [choiceId], segmentedEffect, optionalCoinStep);
    if (calls === 4 || calls === 5) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [], segmentedEffect, calls === 4 ? 'random-step-2' : '投掷1至3次硬币');
    if (calls === 6) return atomic({ kind: 'random', mode: 'coins', count: 1 }, [], segmentedEffect, fixedCoinStep);
    if (calls === 8) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [], segmentedEffect, optionalCoinStep);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成分段硬币', text: segmentedEffect }] });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2); await fixture.settle('completed');
  assert.equal(calls, 9);
  const stored = JSON.parse(await readFile(join(fixture.service.match(fixture.id).directory, 'human-actions', `${action.id}.json`), 'utf8'));
  assert.equal(stored.messages.filter((message: { output?: string }) => message.output?.includes('完整卡文中唯一的原文分句')).length, 3);
  assert.deepEqual((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random').map(event => (event.data as { result: { coins: unknown[] } }).result.coins.length), [2, 1]);
});

test('数量不能套到其他真实分句，独立固定步骤也不能重复执行', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', coinNumberChoice());
    if (calls === 2) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [choiceId], segmentedEffect, optionalCoinStep);
    if (calls >= 3 && calls <= 5) return atomic({ kind: 'random', mode: 'coins', count: 1 }, calls === 3 ? [choiceId] : [], segmentedEffect, fixedCoinStep);
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成分段硬币', text: segmentedEffect }] });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2); await fixture.settle('completed');
  assert.equal(calls, 6); assert.equal((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random').length, 2);
});

test('旧数量scope不因事后添加新效果分句而重新授权已消费的同一路径', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'number', title: '投掷次数', options: [], minimum: 1, maximum: 3, quantityScopes: [{ kind: 'random', mode: 'coins' }] });
    if (calls === 2) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [choiceId], segmentedEffect);
    if (calls === 3 || calls === 4) return atomic({ kind: 'random', mode: 'coins', count: 2 }, calls === 3 ? [] : [choiceId], segmentedEffect, fixedCoinStep);
    return call('fail_action', { reason: '旧数量范围无法区分分句，保留现场而不重复执行' });
  }, { ...pokemon, abilities: [{ name: '合成旧scope', text: segmentedEffect }] });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2); await fixture.settle('failed');
  assert.equal(calls, 5); assert.equal((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random').length, 1);
});

test('选牌后的完成必须有该choiceId的实际有效执行，前置查看或再次查看不能替代加入手牌', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], effect);
    if (calls === 2) return call('request_choice', { kind: 'select', title: '选择加入手牌的卡牌', options: [0, 1].map(index => ({ id: `card${index}`, position: { zoneId: 'A:deck', index } })), minimum: 1, maximum: 1 });
    if (calls === 3) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId], effect);
    if (calls === 5) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [1] } } }, [choiceId], effect);
    if (calls === 7) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [1] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId]);
    return call('finish_action', {});
  });
  await fixture.ready(); const initial = cardIds(fixture, 'A:hand').length;
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['card1']); await fixture.settle('completed');
  assert.equal(calls, 8); assert.equal(cardIds(fixture, 'A:hand').length, initial + 1);
  const stored = JSON.parse(await readFile(join(fixture.service.match(fixture.id).directory, 'human-actions', `${action.id}.json`), 'utf8'));
  assert.equal(stored.messages.filter((message: { output?: string }) => message.output?.includes('此前的look')).length, 2);
});

test('选中的已授权目标也必须实际引用choiceId，不能借其他原始授权或任意marker算已执行', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', { kind: 'select', title: '选择目标', options: [{ id: 'active', position: { zoneId: 'A:active', index: 0 } }], minimum: 1, maximum: 1 });
    if (calls === 2) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 1 } });
    if (calls === 4) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'marker', name: '合成检索', value: true } }, [choiceId]);
    if (calls === 6) return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 2 } }, [choiceId]);
    return call('finish_action', {});
  });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['active']); await fixture.settle('completed');
  assert.equal(calls, 7);
  const stored = JSON.parse(await readFile(join(fixture.service.match(fixture.id).directory, 'human-actions', `${action.id}.json`), 'utf8'));
  assert.equal(stored.messages.filter((message: { output?: string }) => message.output?.includes('此前的look')).length, 2);
});

test('展示、状态目标、原位留牌、空选和零数量均有明确的完成方式', async t => {
  for (const mode of ['show', 'state', 'keep', 'empty', 'zero'] as const) await t.test(mode, async t => {
    let calls = 0, choiceId = '';
    const text = mode === 'keep' ? '选择1张自己的手牌留在手牌中。' : mode === 'zero' ? '最多投掷3次硬币。' : mode === 'empty' ? '可以选择最多1张自己的手牌。' : mode === 'state' ? '选择1只对手的宝可梦放置1个伤害指示物。' : '选择1张自己的手牌展示给对手。';
    const fixture = await setup(t, () => {
      calls++;
      if (calls === 1) return call('request_choice', mode === 'zero' ? { kind: 'number', title: '选择数量', options: [], minimum: 0, maximum: 3, quantityScopes: [{ kind: 'random', mode: 'coins' }] }
        : { kind: 'select', title: '选择卡牌', options: [{ id: 'card', position: { zoneId: mode === 'state' ? 'B:active' : 'A:hand', index: 0 } }], minimum: mode === 'empty' ? 0 : 1, maximum: 1,
          ...(mode === 'show' ? { resolution: { kind: 'show' } } : mode === 'keep' ? { resolution: { kind: 'keep', container: { kind: 'zone', zoneId: 'A:hand' } }, effectText: text } : {}) });
      if (calls === 2 && mode === 'show') return atomic({ kind: 'show', selection: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } } }, [choiceId]);
      if (calls === 2 && mode === 'state') return atomic({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'B:active', index: 0 } }, field: { key: 'damageCounters', value: 1 } }, [choiceId]);
      return call('finish_action', {});
    }, { ...pokemon, abilities: [{ name: '合成明确选择', text }] });
    await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
    choiceId = (await fixture.settle('awaiting_choice')).choice!.id;
    await confirm(fixture, action.id, mode === 'empty' || mode === 'zero' ? [] : ['card'], mode === 'zero' ? 0 : undefined);
    const done = await fixture.settle('completed');
    assert.equal(calls, mode === 'show' || mode === 'state' ? 3 : 2); assert.equal(done.eventIds.length, mode === 'show' || mode === 'state' ? 1 : 0);
  });
});

test('非零数量尚未执行时不能借选择前的查看记录完成', async t => {
  let calls = 0; const text = '查看自己的牌库，然后最多投掷3次硬币。';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], text);
    if (calls === 2) return call('request_choice', { kind: 'number', title: '选择硬币次数', options: [], minimum: 0, maximum: 3 });
    return call('finish_action', {});
  }, { ...pokemon, abilities: [{ name: '合成未执行数量', text }] });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  await confirm(fixture, action.id, [], 2); await fixture.settle('failed'); assert.equal(calls, 5);
  assert.equal((await fixture.view()).events.filter(event => event.action?.id === action.id && event.commandKind === 'random').length, 0);
});

test('原文分句和数量账本可从真实成功回执恢复，不重放可变或固定步骤', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return call('request_choice', coinNumberChoice());
    if (calls === 2) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [choiceId], segmentedEffect, optionalCoinStep);
    if (calls === 3) return atomic({ kind: 'random', mode: 'coins', count: 1 }, [], segmentedEffect, fixedCoinStep);
    return call('fail_action', { reason: '合成执行后中断' });
  }, { ...pokemon, abilities: [{ name: '合成分段恢复', text: segmentedEffect }] });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, [], 2); await fixture.settle('failed');
  const match = fixture.service.match(fixture.id), records = JSON.stringify(match.records);
  await fixture.service.humanController(match).close();
  const path = join(match.directory, 'human-actions', `${action.id}.json`), state = JSON.parse(await readFile(path, 'utf8'));
  delete state.effectStepUses; delete state.answers[0].quantityUses; await writeFile(path, JSON.stringify(state));
  const { HumanActionController } = await import('../src/human-actions.ts'); let resumed = 0;
  const recovered = new HumanActionController({ match, modelFactory: () => ({ generate: async () => {
    resumed++;
    if (resumed === 1) return atomic({ kind: 'random', mode: 'coins', count: 2 }, [choiceId], segmentedEffect, optionalCoinStep);
    if (resumed === 2) return atomic({ kind: 'random', mode: 'coins', count: 1 }, [], segmentedEffect, fixedCoinStep);
    return call('finish_action', {});
  } }), prompts: () => fixture.service.prompts(), wake: () => {} });
  await recovered.recover(); t.after(() => recovered.close()); await recovered.control(action.id, { playerId: 'A', action: 'retry' });
  for (let index = 0; index < 1000 && recovered.view('A')!.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(recovered.view('A')!.status, 'completed'); assert.equal(resumed, 3); assert.equal(JSON.stringify(match.records), records);
});

test('声明加入手牌的选择不能只展示就完成，须有到所声明容器的实际移动', async t => {
  let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], effect);
    if (calls === 2) return call('request_choice', { kind: 'select', title: '选择加入手牌的卡牌', options: [{ id: 'card', position: { zoneId: 'A:deck', index: 0 } }], minimum: 1, maximum: 1, resolution: { kind: 'move', container: { kind: 'zone', zoneId: 'A:hand' } } });
    if (calls === 3) return atomic({ kind: 'show', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [0] } } }, [choiceId]);
    if (calls === 5) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId]);
    return call('finish_action', {});
  });
  await fixture.ready(); const initial = cardIds(fixture, 'A:hand').length;
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['card']); await fixture.settle('completed');
  assert.equal(calls, 6); assert.equal(cardIds(fixture, 'A:hand').length, initial + 1);
});

test('失败或取消的半结算不能被新行动覆盖，无副作用失败仍可重新操作', async t => {
  for (const terminal of ['failed', 'cancelled', 'clean'] as const) await t.test(terminal, async sub => {
    let calls = 0;
    const fixture = await setup(sub, () => {
      calls++;
      if (terminal !== 'clean' && calls === 1) return atomic({ kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
      return terminal === 'cancelled' ? call('request_choice', { kind: 'select', title: '是否继续', options: [{ id: 'no', label: '跳过' }], minimum: 1, maximum: 1 }) : call('fail_action', { reason: '合成结算故障' });
    });
    await fixture.ready(); const { action } = await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 0 } });
    await fixture.settle(terminal === 'cancelled' ? 'awaiting_choice' : 'failed');
    if (terminal === 'cancelled') await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/control`, payload: { playerId: 'A', action: 'cancel' } });
    const state = await fixture.current();
    assert.equal(Boolean(state.requiresResolution), terminal !== 'clean');
    const next = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions`, payload: { playerId: 'A', intent: { kind: 'end_turn' }, requestId: randomUUID(), revision: (await fixture.view()).revision } });
    assert.equal(next.statusCode, terminal === 'clean' ? 202 : 409, next.body);
    if (terminal !== 'clean') assert.equal((await fixture.current()).id, action.id);
  });
});

test('已指定备战目标的机械交换一次完成，不增加固定对象或空槽选择', async t => {
  const effect = '将自己的战斗宝可梦与1只备战宝可梦互换。'; let calls = 0;
  const fixture = await setup(t, () => { calls++; const mechanical = { kind: 'switch', target: { zoneId: 'A:bench', index: 0 } }; return call('execute_sequence', { finish: true, steps: [
    { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:bench' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:staging' }, index: 'end' } }, choiceIds: [], effectText: effect, mechanical },
    { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:active' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } }, choiceIds: [], effectText: effect, mechanical },
    { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:staging' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:active' }, index: 0 } }, choiceIds: [], effectText: effect, mechanical },
  ] }); }, { ...pokemon, abilities: [{ name: '交换', text: effect }] });
  await fixture.ready(); await fixture.command('A', { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
  await fixture.command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 0 }, relation: 'stack' }, index: 0 } });
  const initial = [cardIds(fixture, 'A:active')[0], cardIds(fixture, 'A:bench')[0]];
  await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0, target: { zoneId: 'A:bench', index: 0 } });
  const done = await fixture.settle(); assert.equal(done.status, 'completed', done.error); assert.equal(calls, 1);
  assert.deepEqual([cardIds(fixture, 'A:bench')[0], cardIds(fixture, 'A:active')[0]], initial);
});

test('双方按剩余奖赏数的固定盲抽不要求选择对手隐藏牌', async t => {
  const effect = '双方各自从自己的牌库抽出与自己剩余奖赏卡张数相同数量的卡牌。'; let calls = 0;
  const fixture = await setup(t, () => { calls++; return call('execute_sequence', { finish: true, steps: (['A', 'B'] as const).map(playerId => ({ command: { kind: 'move', source: { container: { kind: 'zone', zoneId: `${playerId}:deck` }, range: { mode: 'range', start: 0, count: 6 } }, destination: { container: { kind: 'zone', zoneId: `${playerId}:hand` }, index: 'end' } }, choiceIds: [], effectText: effect, effectStep: effect, mechanical: { kind: 'draw', basis: 'prizes' } })) }); }, { ...pokemon, abilities: [{ name: '固定补给', text: effect }] });
  await fixture.ready(); const before = cardIds(fixture, 'B:hand').length;
  await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const done = await fixture.settle(); assert.equal(done.status, 'completed', done.error); assert.equal(calls, 1); assert.equal(cardIds(fixture, 'B:hand').length, before + 6);
  assert.ok((await fixture.view()).zones.find(zone => zone.id === 'B:hand')!.items.every(item => item?.kind === 'hidden'));
});

test('选择自己牌库中卡牌的完整卡文可查看，不依赖牌库和选择的词序', async t => {
  const effect = '选择自己牌库中的1张卡牌，加入手牌。'; let calls = 0;
  const fixture = await setup(t, () => { calls++; return calls === 1 ? atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], effect) : call('fail_action', { reason: '查看验证终点' }); }, { ...pokemon, abilities: [{ name: '检索', text: effect }] });
  await fixture.ready(); await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const done = await fixture.settle('failed'); assert.equal(done.eventIds.length, 1);
});

test('已选top2一张后唯一补集归底按候选身份授权，不受原位置移位影响', async t => {
  const effect = '查看自己的牌库最上面的2张卡牌，选择其中1张加入手牌，将剩下的卡牌放回牌库最下方。'; let calls = 0, choiceId = '';
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } } }, [], effect);
    if (calls === 2) return call('request_choice', { kind: 'select', title: '加入手牌', options: [0, 1].map(index => ({ id: `top${index}`, position: { zoneId: 'A:deck', index } })), minimum: 1, maximum: 1 });
    return call('execute_sequence', { finish: true, steps: [
      { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, choiceIds: [choiceId], effectText: effect },
      { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 'end' } }, choiceIds: [choiceId], effectText: effect, mechanical: { kind: 'remainder', choiceId } },
    ] });
  }, { ...pokemon, abilities: [{ name: '挑选', text: effect }] });
  await fixture.ready(); const original = cardIds(fixture, 'A:deck').slice(0, 3);
  const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['top0']);
  const done = await fixture.settle(); assert.equal(done.status, 'completed', done.error); assert.equal(calls, 3);
  assert.equal(cardIds(fixture, 'A:deck').at(-1), original[1]); assert.equal(cardIds(fixture, 'A:deck')[0], original[2]);
});

test('昏厥整组清理先弃叠牌再弃附着卡仍有机械授权', async t => {
  let calls = 0;
  const fixture = await setup(t, () => { calls++; return sequence((['stack', 'attached'] as const).map(relation => ({ command: { kind: 'move', source: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } }, choiceIds: [] }))); });
  await fixture.ready();
  await fixture.command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation: 'attached' }, index: 'end' } });
  await fixture.command('A', { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 8 } });
  await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const done = await fixture.settle(); assert.equal(done.status, 'completed', done.error); assert.equal(calls, 1);
  const ref = fixture.service.match(fixture.id).state.zones['A:active']!.contents.items[0]!;
  assert.deepEqual(fixture.service.match(fixture.id).state.groups[ref.id]!.attached, []);
});

test('显式手动修正仍保留结算义务，调整归属原行动并禁止直接推进回合', async t => {
  let calls = 0;
  const fixture = await setup(t, () => {
    calls++;
    if (calls === 1) return atomic({ kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
    return calls === 2 ? call('fail_action', { reason: '合成待修正故障' }) : call('finish_action', {});
  });
  await fixture.ready(); const { action } = await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 0 } });
  assert.equal((await fixture.settle('failed')).requiresResolution, true);
  const match = fixture.service.match(fixture.id);
  const direct = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/commands`, payload: { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, command: { kind: 'set_turn', phase: 'check', playerId: null } } });
  assert.equal(direct.statusCode, 409);
  const manual = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/control`, payload: { playerId: 'A', action: 'manual' } });
  assert.equal(manual.statusCode, 202, manual.body); assert.equal(manual.json().requiresResolution, true);
  assert.equal(match.humanActionLocks.get('A')?.mode, 'manual');
  await fixture.command('A', { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:hand' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 0 }, relation: 'stack' }, index: 0 } });
  assert.equal(match.records.at(-1)!.event!.A.action!.id, action.id);
  const advance = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/commands`, payload: { playerId: 'A', requestId: randomUUID(), revision: match.state.revision, command: { kind: 'set_turn', phase: 'check', playerId: null } } });
  assert.equal(advance.statusCode, 409); assert.equal(advance.json().error.code, 'HUMAN_SETTLEMENT_REQUIRED');
  const blocked = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions`, payload: { playerId: 'A', intent: { kind: 'end_turn' }, requestId: randomUUID(), revision: match.state.revision } });
  assert.equal(blocked.statusCode, 409);
  const repaired = await fixture.app.inject({ method: 'POST', url: `/api/matches/${fixture.id}/actions/${action.id}/control`, payload: { playerId: 'A', action: 'repair' } });
  assert.equal(repaired.statusCode, 202); assert.equal((await fixture.settle('completed')).requiresResolution, false); assert.equal(match.humanActionLocks.get('A'), undefined);
});

test('失败后的有效副作用跨重启保持锁；整段回滚后可以改意图', async t => {
  let calls = 0;
  const fixture = await setup(t, () => ++calls === 1 ? atomic({ kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } }) : call('fail_action', { reason: '合成故障' }));
  await fixture.ready(); const { action } = await fixture.start({ kind: 'play', source: { zoneId: 'A:hand', index: 0 }, target: { zoneId: 'A:bench', index: 0 } });
  const failed = await fixture.settle('failed'), match = fixture.service.match(fixture.id);
  const original = fixture.service.humanController(match, 'A'); await original.close(); match.unlockHumanAction('A', action.id);
  const { HumanActionController } = await import('../src/human-actions.ts');
  const recovered = new HumanActionController({ match, playerId: 'A', modelFactory: () => ({ generate: async () => call('fail_action', { reason: '合成故障' }) }), prompts: () => fixture.service.prompts(), wake: () => {} });
  t.after(() => recovered.close()); await recovered.recover();
  assert.equal(recovered.view('A')!.requiresResolution, true); assert.ok(match.humanActionLocks.has('A'));
  await assert.rejects(recovered.start({ playerId: 'A', requestId: randomUUID(), revision: match.state.revision, intent: { kind: 'end_turn' } }), /先完成当前结算/);
  const restored = await match.restoreHumanAction('A', { requestId: randomUUID(), revision: match.state.revision, beforeEventId: failed.eventIds[0]!, reason: '撤销整段未完成出场' }, { id: action.id, label: action.label });
  assert.equal(restored.status, 'committed');
  const cancelled = await recovered.control(action.id, { playerId: 'A', action: 'cancel' });
  assert.equal(cancelled.requiresResolution, false); assert.equal(match.humanActionLocks.get('A'), undefined); assert.equal(match.state.zones['A:bench']!.contents.items[0], null);
  const next = await recovered.start({ playerId: 'A', requestId: randomUUID(), revision: match.state.revision, intent: { kind: 'end_turn' } }); assert.notEqual(next.id, action.id);
  await recovered.close();
});

test('mechanical声明不能把可选抽牌或错误固定数量伪装为确定流程', async t => {
  for (const [effect, count] of [['从自己的牌库抽最多3张牌。', 2], ['从自己的牌库抽2张牌。', 3]] as const) await t.test(effect, async sub => {
    let calls = 0;
    const fixture = await setup(sub, () => ++calls === 1 ? call('execute_atomic', { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, choiceIds: [], effectText: effect, effectStep: effect, mechanical: { kind: 'draw', basis: 'fixed' } }) : call('fail_action', { reason: '已验证拒绝' }), { ...pokemon, abilities: [{ name: '合成补给', text: effect }] });
    await fixture.ready(); const before = (await fixture.view()).revision;
    await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
    assert.equal((await fixture.settle('failed')).eventIds.length, 0); assert.equal((await fixture.view()).revision, before);
  });
});

test('固定盲抽分句不能重复消费，同一批次第二次抽牌被拒绝', async t => {
  const effect = '从自己的牌库抽2张牌。'; let calls = 0;
  const fixture = await setup(t, () => {
    if (++calls > 1) return call('fail_action', { reason: '重复已拦截' });
    const step = { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 2 } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, choiceIds: [], effectText: effect, effectStep: effect, mechanical: { kind: 'draw', basis: 'fixed' } };
    return call('execute_sequence', { steps: [step, step], finish: true });
  }, { ...pokemon, abilities: [{ name: '合成补给', text: effect }] });
  await fixture.ready(); const before = cardIds(fixture, 'A:hand').length;
  await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
  const failed = await fixture.settle('failed'); assert.equal(failed.eventIds.length, 1); assert.equal(cardIds(fixture, 'A:hand').length, before + 2); assert.equal(failed.requiresResolution, true);
});

test('补集授权拒绝旧索引指向的新卡、未确认的多张顺序和洗牌后的隐藏候选', async t => {
  for (const mode of ['shifted', 'multiple', 'shuffled'] as const) await t.test(mode, async sub => {
    const effect = '查看自己的牌库最上面的3张卡牌，选择其中1张加入手牌，将剩下的卡牌放回牌库最下方。然后重洗牌库。';
    let calls = 0, choiceId = '', remaining = '';
    let fixture: Awaited<ReturnType<typeof setup>>;
    fixture = await setup(sub, () => {
      calls++;
      if (calls === 1) return atomic({ kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 0, count: 3 } } }, [], effect);
      if (calls === 2) return call('request_choice', { kind: 'select', title: '加入手牌', options: Array.from({ length: mode === 'multiple' ? 3 : 2 }, (_, index) => ({ id: `top${index}`, position: { zoneId: 'A:deck', index } })), minimum: 1, maximum: 1 });
      if (calls === 3) return atomic({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [0] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, [choiceId], effect);
      if (mode === 'shuffled' && calls === 4) return atomic({ kind: 'shuffle', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, [], effect);
      if (calls === (mode === 'shuffled' ? 5 : 4)) {
        const index = mode === 'shifted' ? 1 : mode === 'shuffled' ? cardIds(fixture, 'A:deck').indexOf(remaining) : 0;
        return call('execute_atomic', { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [index] } }, destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 'end' } }, choiceIds: [choiceId], effectText: effect, mechanical: { kind: 'remainder', choiceId } });
      }
      return call('fail_action', { reason: '补集越权已拦截' });
    }, { ...pokemon, abilities: [{ name: '合成挑选', text: effect }] });
    await fixture.ready(); remaining = cardIds(fixture, 'A:deck')[1]!;
    const { action } = await fixture.start({ kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 });
    choiceId = (await fixture.settle('awaiting_choice')).choice!.id; await confirm(fixture, action.id, ['top0']);
    const failed = await fixture.settle('failed');
    assert.equal(failed.eventIds.length, mode === 'shuffled' ? 3 : 2, '只有查看、已选卡入手与显式洗牌可提交，补集越权不得产生移动');
    const saved = JSON.parse(await readFile(join(fixture.service.match(fixture.id).directory, 'human-actions', `${action.id}.json`), 'utf8'));
    assert.ok(saved.messages.some((item: { output?: string }) => item.output?.includes('机械补集仅限')));
  });
});
