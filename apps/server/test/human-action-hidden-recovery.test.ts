import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameService } from '../src/service.ts';
import type { MatchRuntime } from '../src/match.ts';
import { ReplayEntropy } from '../src/entropy.ts';
import { seedHumanScenario } from '../../../scripts/human-action-fixtures.ts';
import type { ModelReply, ModelRequest } from '../../../packages/agent/src/index.ts';
import type { CardData, HumanActionIntent, HumanActionView } from '../../../packages/protocol/src/index.ts';
import { decodeHumanReview } from './human-context-fixture.ts';

const tool = (name: string, args: unknown): ModelReply => {
  const callId = crypto.randomUUID(), argumentsJson = JSON.stringify(args);
  return { id: crypto.randomUUID(), model: 'test', output: [{ type: 'function_call', call_id: callId, name, arguments: argumentsJson }], calls: [{ callId, name, arguments: argumentsJson }], usage: null };
};
type ChoiceReview = { choiceId: string; invalidated: boolean; selected: { id: string; label: string; position?: { zoneId: string; index: number } }[] };
type RecoveryReview = { choices: ChoiceReview[]; availableRestorePoints: { eventId: string }[] };
function review(request: ModelRequest): RecoveryReview {
  const data = decodeHumanReview(request.input);
  assert.ok(data, '修正模型必须收到重新构建的审查资料');
  return data as RecoveryReview;
}
async function scenario(t: TestContext, text: string, generate: (index: number, request: ModelRequest, match: MatchRuntime) => ModelReply) {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-hidden-recovery-'));
  let calls = 0, match: MatchRuntime;
  const service = new GameService({ dataDir: join(directory, 'data'), systemDir: join(directory, 'system'), modelFactory: () => ({ async generate(request) { return generate(++calls, request, match); } }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.init(); match = await seedHumanScenario(service, 'hidden-recovery');
  const top = match.state.groups['practice:A:active:0']!.stack.at(-1)!;
  const definition = match.state.cards[top]!.definitionId, card = match.state.definitions[definition] as Extract<CardData, { kind: 'pokemon' }>;
  match.state.definitions[definition] = { ...card, abilities: [{ name: '合成恢复效果', text }] };
  match.entropy = new ReplayEntropy({ format: 'scoped-hmac-v1', seed: 'a'.repeat(64), counters: {} });
  const prepared = await match.command('A', { requestId: crypto.randomUUID(), revision: match.state.revision, command: { kind: 'declare', text: '合成恢复测试起点' } });
  assert.equal(prepared.status, 'committed');
  const controller = service.humanController(match, 'A');
  const settle = async (status?: HumanActionView['status']) => {
    for (let count = 0; count < 500; count++) {
      const action = controller.view('A');
      if (action && (status ? action.status === status : action.status !== 'running')) return action;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`恢复场景没有到达${status ?? '停止'}：${JSON.stringify(controller.view('A'))}`);
  };
  return { match, controller, settle,
    start: (intent: HumanActionIntent = { kind: 'ability', source: { zoneId: 'A:active', index: 0 }, abilityIndex: 0 }) => controller.start({ playerId: 'A', requestId: crypto.randomUUID(), revision: match.state.revision, intent }),
    select: async (id: string) => {
      const waiting = await settle('awaiting_choice');
      await controller.answer(waiting.id, { playerId: 'A', requestId: crypto.randomUUID(), revision: match.state.revision, choiceId: waiting.choice!.id, selected: [id] });
      return waiting.choice!.id;
    },
  };
}

test('跨洗牌和查看恢复时作废旧隐藏选择，不通过私有身份泄漏恢复前未知的位置', async t => {
  const text = '合成效果：重洗自己的牌库，查看自己的牌库，选择1张卡加入手牌。';
  let choiceId = '', selectedIndex = 0, captured: ChoiceReview | undefined;
  const fixture = await scenario(t, text, (index, request, match) => {
    if (index === 1) return tool('execute_atomic', { command: { kind: 'shuffle', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, choiceIds: [], effectText: text });
    if (index === 2) return tool('execute_atomic', { command: { kind: 'look', selection: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'all' } } }, choiceIds: [], effectText: text });
    if (index === 3) return tool('request_choice', { kind: 'select', title: '选择卡牌', options: match.state.zones['A:deck']!.contents.items.map((_, index) => ({ id: String(index), position: { zoneId: 'A:deck', index } })), minimum: 1, maximum: 1, effectText: text });
    if (index === 4) return tool('execute_atomic', { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'indices', indices: [selectedIndex] } }, destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 'end' } }, choiceIds: [choiceId], effectText: text });
    if (index === 5) return tool('fail_action', { reason: '合成需要回滚整个效果' });
    const data = review(request);
    if (index === 6) return tool('restore_action', { beforeEventId: data.availableRestorePoints[0]!.eventId, reason: '撤销合成错误及之前的洗牌' });
    captured ??= data.choices[0];
    return tool('fail_action', { reason: '合成审查结束' });
  });
  const originalDeck = fixture.match.state.zones['A:deck']!.contents.items.map(ref => ref!.id);
  const action = await fixture.start();
  await fixture.settle('awaiting_choice');
  const shuffled = fixture.match.state.zones['A:deck']!.contents.items;
  selectedIndex = shuffled.findIndex((ref, index) => ref!.id !== originalDeck[index]);
  assert.ok(selectedIndex >= 0, '固定随机流应产生非原位洗牌');
  const restoredIndex = originalDeck.indexOf(shuffled[selectedIndex]!.id);
  choiceId = await fixture.select(String(selectedIndex)); await fixture.settle('failed');
  await fixture.controller.control(action.id, { playerId: 'A', action: 'retry' }); await fixture.settle();
  assert.equal(captured?.invalidated, true);
  assert.deepEqual(captured.selected[0]!.position, { zoneId: 'A:deck', index: selectedIndex }, '审查保留旧位置作为已失效历史，不能附上新未知位置');
  assert.notEqual(captured.selected[0]!.position!.index, restoredIndex);
});

test('公开宝可梦恢复后仍按同一身份重绑，保留人类已选对象', async t => {
  const text = '合成效果：移动这只宝可梦，再给玩家选择的宝可梦放置1个伤害指示物。';
  let choiceId = '', captured: ChoiceReview | undefined;
  const fixture = await scenario(t, text, (index, request) => {
    if (index === 1) return tool('execute_atomic', { command: { kind: 'move', source: { container: { kind: 'zone', zoneId: 'A:bench' }, range: { mode: 'indices', indices: [4] } }, destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 2 } }, choiceIds: [], effectText: text });
    if (index === 2) return tool('request_choice', { kind: 'select', title: '选择公开宝可梦', options: [{ id: 'public', position: { zoneId: 'A:bench', index: 2 } }], minimum: 1, maximum: 1, effectText: text });
    if (index === 3) return tool('execute_atomic', { command: { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:bench', index: 2 } }, field: { key: 'damageCounters', value: 1 } }, choiceIds: [choiceId], effectText: text });
    if (index === 4) return tool('fail_action', { reason: '合成需要恢复移动之前' });
    const data = review(request);
    if (index === 5) return tool('restore_action', { beforeEventId: data.availableRestorePoints[0]!.eventId, reason: '恢复公开对象的原位置' });
    captured ??= data.choices[0];
    return tool('fail_action', { reason: '合成审查结束' });
  });
  const groupId = fixture.match.state.zones['A:bench']!.contents.items[4]!.id;
  const action = await fixture.start({ kind: 'ability', source: { zoneId: 'A:bench', index: 4 }, abilityIndex: 0, target: { zoneId: 'A:bench', index: 2 } });
  choiceId = await fixture.select('public'); await fixture.settle('failed');
  await fixture.controller.control(action.id, { playerId: 'A', action: 'retry' }); await fixture.settle();
  assert.equal(captured?.invalidated, false);
  assert.deepEqual(captured.selected[0]!.position, { zoneId: 'A:bench', index: 4 });
  assert.equal(fixture.match.state.zones['A:bench']!.contents.items[4]!.id, groupId);
});

test('恢复点之前确认的盲奖赏原槽位保持有效，仍不显示隐藏牌面', async t => {
  const text = '合成效果：选择1张自己的奖赏卡加入手牌。';
  let captured: ChoiceReview | undefined;
  const fixture = await scenario(t, text, (index, request) => {
    if (index === 1) return tool('request_choice', { kind: 'select', title: '盲选奖赏', options: [{ id: 'prize', position: { zoneId: 'A:prizes', index: 2 } }], minimum: 1, maximum: 1, effectText: text });
    if (index === 2) return tool('execute_atomic', { command: { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 1 } }, choiceIds: [], effectText: text });
    if (index === 3) return tool('fail_action', { reason: '合成无关状态操作错误' });
    const data = review(request);
    if (index === 4) return tool('restore_action', { beforeEventId: data.availableRestorePoints[0]!.eventId, reason: '仅撤销后来的错误状态，保留之前已选槽位' });
    captured ??= data.choices[0];
    return tool('fail_action', { reason: '合成审查结束' });
  });
  const action = await fixture.start();
  const waiting = await fixture.settle('awaiting_choice'); assert.equal(waiting.choice!.options[0]!.card, undefined);
  await fixture.select('prize'); await fixture.settle('failed');
  await fixture.controller.control(action.id, { playerId: 'A', action: 'retry' }); await fixture.settle();
  assert.equal(captured?.invalidated, false);
  assert.deepEqual(captured.selected, [{ id: 'prize', label: 'A:prizes 第 3 位', position: { zoneId: 'A:prizes', index: 2 } }]);
});
