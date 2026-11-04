import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoreError, createGame, executeCore, findCardPosition, projectTable, resolveSelection,
  type Actor, type CardData, type CoreCommand, type Entropy, type GameState, type Selection,
} from '../src/index.ts';

const basic: CardData = { kind: 'pokemon', name: '小火龙', hp: 70, types: ['火'], stage: '基础', abilities: [], attacks: [], weaknesses: [], resistances: [], retreatCost: 1 };
const energy = { kind: 'energy', subtype: 'basic', name: '基本火能量', energyType: '火' } satisfies CardData;
const a: Actor = { kind: 'player', playerId: 'A' }, b: Actor = { kind: 'player', playerId: 'B' };
const system: Actor = { kind: 'system', purpose: 'setup' }, debug: Actor = { kind: 'system', purpose: 'debug' };
function entropy(values: number[] = []): Entropy {
  let cursor = 0, id = 0;
  return { uuid: () => `id-${++id}`, integer: max => (values[cursor++] ?? 0) % max };
}
function game(): GameState {
  return createGame({ id: 'test', players: [
    { id: 'A', name: '甲', kind: 'human', deck: { name: '甲卡组', cards: [{ card: basic, count: 4 }, { card: energy, count: 8 }] } },
    { id: 'B', name: '乙', kind: 'ai', deck: { name: '乙卡组', cards: [{ card: basic, count: 4 }, { card: { ...energy, text: '仅乙有的描述' }, count: 8 }] } },
  ] }, entropy());
}
const zone = (zoneId: string, indices: number[] = [0]): Selection => ({ container: { kind: 'zone', zoneId }, range: { mode: 'indices', indices } });
const all = (zoneId: string): Selection => ({ container: { kind: 'zone', zoneId }, range: { mode: 'all' } });
const group = (zoneId: string, index: number, relation: 'stack' | 'attached', indices: number[] = [0]): Selection => ({ container: { kind: 'group', position: { zoneId, index }, relation }, range: { mode: 'indices', indices } });
let operationId = 0;
function run(state: GameState, command: CoreCommand, actor: Actor = a) {
  const source = entropy([1, 0, 1, 0]);
  return executeCore(state, command, actor, { integer: source.integer, uuid: () => `operation-${++operationId}` });
}
function move(state: GameState, source: Selection, to: string, index = 0) { return run(state, { kind: 'move', source, destination: { container: { kind: 'zone', zoneId: to }, index } }).state; }
function addGroup(state: GameState, zoneId = 'A:active', index = 0): GameState { return run(state, { kind: 'create_group', destination: { container: { kind: 'zone', zoneId }, index } }).state; }
function inGroup(state: GameState, from: Selection, zoneId = 'A:active', index = 0, relation: 'stack' | 'attached' = 'stack'): GameState {
  return run(state, { kind: 'move', source: from, destination: { container: { kind: 'group', position: { zoneId, index }, relation }, index: 0 } }).state;
}
function starts(state: GameState): GameState { return run(state, { kind: 'set_turn', phase: 'turn', playerId: 'A' }, system).state; }
function throwsCode(action: () => unknown, code: string) { assert.throws(action, (error: unknown) => error instanceof CoreError && error.code === code); }

test('初始化17区域、槽位、两层身份和完整字段去重，输入不变', () => {
  const state = game();
  assert.equal(Object.keys(state.zones).length, 17);
  assert.equal(state.zones['A:bench']!.contents.items.length, 5);
  assert.deepEqual(state.zones['B:prizes']!.contents.items, Array(6).fill(null));
  assert.equal(Object.keys(state.cards).length, 24);
  assert.equal(Object.keys(state.definitions).length, 3);
  const aCard = state.zones['A:deck']!.contents.items[0]!, bCard = state.zones['B:deck']!.contents.items[0]!;
  assert.notEqual(aCard.id, bCard.id);
  assert.equal(state.cards[aCard.id]!.definitionId, state.cards[bCard.id]!.definitionId);
  assert.equal(state.revision, 0);
  assert.deepEqual(basic, { kind: 'pokemon', name: '小火龙', hp: 70, types: ['火'], stage: '基础', abilities: [], attacks: [], weaknesses: [], resistances: [], retreatCost: 1 });
});

test('初始化拒绝零基础、无效卡组和重复熵身份', () => {
  const players = game().players;
  players[0].deck = { cards: [{ card: energy, count: 3 }] };
  throwsCode(() => createGame({ id: 'x', players }), 'NO_BASIC_POKEMON');
  players[0].deck = { cards: [{ card: basic, count: 0 }] };
  throwsCode(() => createGame({ id: 'x', players }), 'INVALID_DECK');
  throwsCode(() => createGame({ id: 'x', players: game().players }, { uuid: () => 'same', integer: () => 0 }), 'INVALID_ENTROPY');
});

test('选择范围严格处理越界、重复、空槽位、零区间和源顺序', () => {
  let state = game();
  throwsCode(() => resolveSelection(state, zone('A:deck', [0, 0])), 'DUPLICATE_INDEX');
  throwsCode(() => resolveSelection(state, { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 11, count: 2 } }), 'OUT_OF_RANGE');
  assert.deepEqual(resolveSelection(state, { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 12, count: 0 } }), []);
  throwsCode(() => resolveSelection(state, { container: { kind: 'zone', zoneId: 'A:deck' }, range: { mode: 'range', start: 13, count: 0 } }), 'OUT_OF_RANGE');
  const objects = resolveSelection(state, zone('A:deck', [2, 0]));
  assert.deepEqual(objects, [state.zones['A:deck']!.contents.items[0], state.zones['A:deck']!.contents.items[2]]);
  state = move(state, zone('A:deck'), 'A:prizes', 2);
  assert.equal(resolveSelection(state, all('A:prizes')).length, 1);
  throwsCode(() => resolveSelection(state, zone('A:prizes', [0, 2])), 'EMPTY_SLOT');
});

test('P01 同容器目标下标按移出后计算且批量保持源顺序', () => {
  const state = game(), old = structuredClone(state);
  const initial = state.zones['A:deck']!.contents.items.map(object => object!.id);
  const moved = move(state, zone('A:deck', [3, 1]), 'A:deck', 10);
  assert.deepEqual(moved.zones['A:deck']!.contents.items.map(object => object!.id), [...initial.filter((_, i) => i !== 1 && i !== 3), initial[1], initial[3]]);
  assert.equal(moved.revision, 1);
  assert.deepEqual(state, old);
  throwsCode(() => move(state, zone('A:deck', [3, 1]), 'A:deck', 11), 'OUT_OF_RANGE');
});

test('P01 目标组先定位，不因源区域压缩改变对象', () => {
  let state = game();
  state = addGroup(state, 'A:deck', 1);
  const id = state.zones['A:deck']!.contents.items[1]!.id;
  state = inGroup(state, zone('A:deck'), 'A:deck', 1, 'attached');
  assert.equal(state.zones['A:deck']!.contents.items[0]!.id, id);
  assert.equal(state.groups[id]!.attached.length, 1);
  assert.deepEqual(findCardPosition(state, state.groups[id]!.attached[0]!), { zoneId: 'A:deck', index: 0, member: { relation: 'attached', index: 0 } });
});

test('P01 槽位移出留空，连续批量放置，末尾扩展且失败原子', () => {
  let state = game();
  state = move(state, zone('A:deck', [0, 1]), 'A:bench', 4);
  assert.equal(state.zones['A:bench']!.contents.items.length, 6);
  assert.equal(state.zones['A:bench']!.contents.items[4]!.kind, 'card');
  const old = structuredClone(state);
  throwsCode(() => move(state, zone('A:deck', [0, 1]), 'A:bench', 3), 'OCCUPIED_SLOT');
  assert.deepEqual(state, old);
  state = move(state, zone('A:bench', [4]), 'A:hand');
  assert.equal(state.zones['A:bench']!.contents.items[4], null);
  assert.equal(state.zones['A:bench']!.contents.items.length, 6);
  throwsCode(() => move(state, zone('A:deck'), 'A:bench', 7), 'OUT_OF_RANGE');
});

test('区域槽位数通过通用命令扩缩，保留所有对象状态和可见性，不自动解释数量限制', () => {
  let state = addGroup(game(), 'A:bench', 0);
  state = inGroup(state, zone('A:deck'), 'A:bench', 0);
  state = inGroup(state, zone('A:deck'), 'A:bench', 0, 'attached');
  state = run(state, { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:bench', index: 0 } }, field: { key: 'damageCounters', value: 2 } }).state;
  state = run(state, { kind: 'set_state', target: { kind: 'card', position: { zoneId: 'A:bench', index: 0, member: { relation: 'attached', index: 0 } } }, field: { key: 'visibility', value: { mode: 'public' } } }).state;
  for (const count of [8, 3, 11, 1]) {
    const before = structuredClone(state), previousCount = before.zones['A:bench']!.contents.items.length;
    const result = run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value: count } });
    assert.equal(result.changed, true);
    assert.deepEqual(result.result, { key: 'slotCount', previousCount, count });
    assert.deepEqual(result.reveals, []);
    assert.deepEqual(state, before);
    const expected = structuredClone(before);
    expected.zones['A:bench']!.contents.items = Array.from({ length: count }, (_, index) => before.zones['A:bench']!.contents.items[index] ?? null);
    expected.revision++;
    assert.deepEqual(result.state, expected);
    assert.equal(projectTable(result.state, 'B').zones.find(zone => zone.id === 'A:bench')!.items.length, count);
    state = result.state;
  }
  // 既有原子操作仍可在末尾增加位置，物理长度不是卡文合法性判断器。
  state = addGroup(state, 'A:bench', 1);
  assert.equal(state.zones['A:bench']!.contents.items.length, 2);
});

test('槽位缩小遇到尾部卡牌组或卡牌时原子拒绝，须先显式移走完整对象', () => {
  let state = run(game(), { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value: 8 } }).state;
  state = addGroup(state, 'A:bench', 7);
  state = inGroup(state, zone('A:deck'), 'A:bench', 7);
  state = inGroup(state, zone('A:deck'), 'A:bench', 7, 'attached');
  const before = structuredClone(state), id = state.zones['A:bench']!.contents.items[7]!.id;
  throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value: 5 } }), 'SLOT_NOT_EMPTY');
  assert.deepEqual(state, before);
  assert.deepEqual(state.groups[id], before.groups[id]);
  state = move(state, zone('A:bench', [7]), 'A:bench', 0);
  state = run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value: 5 } }).state;
  assert.equal(state.zones['A:bench']!.contents.items[0]!.id, id);
  assert.deepEqual(state.groups[id], before.groups[id]);
  assert.deepEqual(state.cards, before.cards);
  state = move(state, zone('A:deck'), 'A:prizes', 5);
  const cardTail = structuredClone(state);
  throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:prizes' }, field: { key: 'slotCount', value: 5 } }), 'SLOT_NOT_EMPTY');
  assert.deepEqual(state, cardTail);
});

test('槽位数相同时不推进版本，空槽位区域可设为零并重新扩容', () => {
  const state = game(), before = structuredClone(state);
  const unchanged = run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value: 5 } });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.state, before);
  assert.deepEqual(unchanged.result, { key: 'slotCount', previousCount: 5, count: 5 });
  const empty = run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value: 0 } }).state;
  assert.deepEqual(empty.zones['A:bench']!.contents, { layout: 'slots', items: [] });
  const expanded = run(empty, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value: 1000 } }).state;
  assert.deepEqual(expanded.zones['A:bench']!.contents.items, Array(1000).fill(null));
  assert.deepEqual(state, before);
});

test('槽位数拒绝非槽位区域、非区域目标和无效数量，拒绝不改原状态', () => {
  const state = addGroup(game()), before = structuredClone(state);
  throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:deck' }, field: { key: 'slotCount', value: 8 } }), 'SLOT_LAYOUT_REQUIRED');
  for (const target of [{ kind: 'player', playerId: 'A' }, { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, { kind: 'card', position: { zoneId: 'A:deck', index: 0 } }] as const) {
    throwsCode(() => run(state, { kind: 'set_state', target, field: { key: 'slotCount', value: 8 } }), 'INVALID_FIELD');
  }
  throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'missing' }, field: { key: 'slotCount', value: 8 } }), 'ZONE_NOT_FOUND');
  for (const value of [-1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY]) {
    throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:bench' }, field: { key: 'slotCount', value } }), 'INVALID_COMMAND');
  }
  assert.deepEqual(state, before);
});

test('P01 单组整体移动保留组状态，跨区域清除所有成员覆盖', () => {
  let state = addGroup(game());
  state = inGroup(state, zone('A:deck', [0, 1]));
  state = inGroup(state, zone('A:deck'), 'A:active', 0, 'attached');
  const groupId = state.zones['A:active']!.contents.items[0]!.id;
  state = run(state, { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 999 } }).state;
  for (const relation of ['stack', 'attached'] as const) for (let index = 0; index < state.groups[groupId]![relation].length; index++) state = run(state, { kind: 'set_state', target: { kind: 'card', position: { zoneId: 'A:active', index: 0, member: { relation, index } } }, field: { key: 'visibility', value: { mode: 'public' } } }).state;
  const oldGroup = structuredClone(state.groups[groupId]);
  state = move(state, zone('A:active'), 'B:bench', 0);
  assert.deepEqual(state.groups[groupId], oldGroup);
  for (const id of [...state.groups[groupId]!.stack, ...state.groups[groupId]!.attached]) assert.equal(state.cards[id]!.state.visibility, undefined);
  assert.equal(state.cards[state.groups[groupId]!.stack[0]!]!.ownerId, 'A');
});

test('P01 拒绝多组批量、混合批量、嵌套与非法位置', () => {
  let state = addGroup(game(), 'A:staging');
  state = addGroup(state, 'A:staging', 1);
  throwsCode(() => move(state, all('A:staging'), 'A:hand'), 'MULTIPLE_GROUPS');
  throwsCode(() => inGroup(state, zone('A:staging'), 'A:staging', 1), 'NESTED_GROUP');
  throwsCode(() => inGroup(state, zone('A:deck'), 'A:active'), 'INVALID_POSITION');
  state = move(state, zone('A:deck'), 'A:staging', 0);
  throwsCode(() => move(state, zone('A:staging', [0, 1]), 'A:hand'), 'MULTIPLE_GROUPS');
});

test('P01 同区成员移动保留覆盖和标记，单卡离组不传组状态', () => {
  let state = addGroup(game());
  state = inGroup(state, zone('A:deck'));
  const id = state.groups[state.zones['A:active']!.contents.items[0]!.id]!.stack[0]!;
  state = run(state, { kind: 'set_state', target: { kind: 'card', position: findCardPosition(state, id)! }, field: { key: 'visibility', value: { mode: 'hidden' } } }).state;
  state = run(state, { kind: 'set_state', target: { kind: 'card', position: findCardPosition(state, id)! }, field: { key: 'marker', name: 'secret', value: true } }).state;
  state = inGroup(state, group('A:active', 0, 'stack'), 'A:active', 0, 'attached');
  assert.deepEqual(state.cards[id]!.state.visibility, { mode: 'hidden' });
  state = move(state, group('A:active', 0, 'attached'), 'A:hand');
  assert.equal(state.cards[id]!.state.visibility, undefined);
  assert.equal(state.cards[id]!.state.markers.secret, true);
  assert.equal(Object.keys(state.groups).length, 1);
});

test('P01 空选择无版本变化，同位置无变化不记执行', () => {
  const state = game();
  const empty = run(state, { kind: 'move', source: all('A:hand'), destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 0 } });
  assert.equal(empty.changed, false); assert.equal(empty.state.revision, 0);
  const same = run(state, { kind: 'move', source: zone('A:deck'), destination: { container: { kind: 'zone', zoneId: 'A:deck' }, index: 0 } });
  assert.equal(same.changed, false); assert.deepEqual(same.state, state);
});

test('P02 只洗选中位置，集合不变，无排列身份泄露', () => {
  const state = game(), old = state.zones['A:deck']!.contents.items;
  const result = executeCore(state, { kind: 'shuffle', selection: zone('A:deck', [0, 2, 4]) }, a, entropy([0, 0]));
  const now = result.state.zones['A:deck']!.contents.items;
  assert.deepEqual([now[0], now[2], now[4]], [old[2], old[4], old[0]]);
  assert.equal(now[1]!.id, old[1]!.id);
  assert.deepEqual(result.result, { count: 3 }); assert.deepEqual(result.reveals, []);
  assert.equal(result.changed, true); assert.equal(result.state.revision, 1);
});

test('P02 空范围不执行，随机源失败不提交', () => {
  const state = game(), before = structuredClone(state);
  assert.equal(run(state, { kind: 'shuffle', selection: all('A:hand') }).changed, false);
  throwsCode(() => executeCore(state, { kind: 'shuffle', selection: all('A:deck') }, a, { uuid: () => 'x', integer: () => -1 }), 'INVALID_ENTROPY');
  assert.deepEqual(state, before);
});

test('P03 单状态类型与标记清除，不自动互斥或昏厥', () => {
  let state = addGroup(game());
  const target = { kind: 'group' as const, position: { zoneId: 'A:active', index: 0 } };
  state = run(state, { kind: 'set_state', target, field: { key: 'specialConditions', value: ['asleep', 'paralyzed', 'confused'] } }).state;
  state = run(state, { kind: 'set_state', target, field: { key: 'damageCounters', value: 999 } }).state;
  state = run(state, { kind: 'set_state', target: { kind: 'player', playerId: 'A' }, field: { key: 'marker', name: 'VSTAR', value: true } }).state;
  assert.equal(state.flow.phase, 'setup');
  assert.equal(Object.values(state.groups)[0]!.state.specialConditions.length, 3);
  const same = run(state, { kind: 'set_state', target, field: { key: 'damageCounters', value: 999 } }); assert.equal(same.changed, false);
  state = run(state, { kind: 'set_state', target: { kind: 'player', playerId: 'A' }, field: { key: 'marker', name: 'VSTAR', value: null } }).state;
  assert.deepEqual(state.playerMarkers.A, {});
  throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'card', position: { zoneId: 'A:deck', index: 0 } }, field: { key: 'damageCounters', value: 1 } }), 'INVALID_FIELD');
});

test('P04 查看只给自己且无持续变更，P05 展示给双方，包括隐藏组成员', () => {
  let state = addGroup(game(), 'A:deck', 0);
  state = inGroup(state, zone('A:deck', [1, 2]), 'A:deck');
  const look = run(state, { kind: 'look', selection: zone('A:deck') });
  assert.deepEqual(look.result, { count: 2 }); assert.deepEqual(look.reveals[0]!.recipients, ['A']);
  assert.equal(look.reveals[0]!.cards[0]!.position.member!.relation, 'stack');
  assert.equal(look.state.revision, state.revision + 1);
  assert.deepEqual(look.state.cards, state.cards);
  assert.equal(projectTable(look.state, 'A').zones.find(z => z.id === 'A:deck')!.items[0]!.kind, 'hidden');
  const show = run(look.state, { kind: 'show', selection: zone('A:deck') });
  assert.deepEqual(show.reveals[0]!.recipients, ['A', 'B']);
  assert.deepEqual(show.reveals[0]!.cards, look.reveals[0]!.cards);
  assert.equal(run(state, { kind: 'look', selection: all('A:hand') }).changed, false);
});

test('P06 多枚硬币、到首反保留顺序，固定结果只记录一次版本', () => {
  const state = game();
  const fixed = executeCore(state, { kind: 'random', mode: 'coins', count: 3 }, a, entropy([0, 1, 0]));
  assert.deepEqual(fixed.result, { mode: 'coins', coins: ['heads', 'tails', 'heads'] });
  assert.equal(fixed.state.revision, 1);
  const until = executeCore(state, { kind: 'random', mode: 'until_tails' }, a, entropy([0, 0, 1]));
  assert.deepEqual(until.result, { mode: 'until_tails', coins: ['heads', 'heads', 'tails'] });
  throwsCode(() => executeCore(state, { kind: 'random', mode: 'until_tails' }, a, entropy()), 'RANDOM_LIMIT_EXCEEDED');
  assert.equal(state.revision, 0);
});

test('P06 随机位置不泄露牌面、ID且无放回，空范围不执行', () => {
  const state = game();
  const random = executeCore(state, { kind: 'random', mode: 'selection', selection: zone('A:deck', [0, 2, 4]), count: 2 }, a, entropy([2, 1]));
  assert.deepEqual(random.result, { mode: 'selection', positions: [{ zoneId: 'A:deck', index: 4 }, { zoneId: 'A:deck', index: 2 }] });
  throwsCode(() => run(state, { kind: 'random', mode: 'selection', selection: zone('A:deck'), count: 2 }), 'OUT_OF_RANGE');
  assert.equal(run(state, { kind: 'random', mode: 'selection', selection: all('A:hand') }).changed, false);
  throwsCode(() => run(state, { kind: 'random', mode: 'coins', selection: all('A:hand') }), 'INVALID_COMMAND');
});

test('P07/P08 显式生命周期，非空组拒删，移空后保留状态', () => {
  let state = addGroup(game());
  state = inGroup(state, zone('A:deck'));
  throwsCode(() => run(state, { kind: 'remove_group', position: { zoneId: 'A:active', index: 0 } }), 'GROUP_NOT_EMPTY');
  state = move(state, group('A:active', 0, 'stack'), 'A:hand');
  assert.equal(Object.keys(state.groups).length, 1);
  state = run(state, { kind: 'remove_group', position: { zoneId: 'A:active', index: 0 } }).state;
  assert.equal(Object.keys(state.groups).length, 0); assert.equal(state.zones['A:active']!.contents.items[0], null);
});

test('宣告只留结果，显式回合/检查和额外自己回合不结算卡牌', () => {
  let state = game();
  const declared = run(state, { kind: 'declare', text: '使用招式' });
  assert.deepEqual(declared.result, { text: '使用招式' }); assert.equal(declared.state.revision, 1);
  state = starts(declared.state);
  const count = state.zones['A:deck']!.contents.items.length;
  state = run(state, { kind: 'set_turn', phase: 'check', playerId: null }).state;
  assert.equal(state.flow.turnOwner, null);
  state = run(state, { kind: 'set_turn', phase: 'turn', playerId: 'A' }).state;
  assert.equal(state.flow.turnNumber, 2); assert.equal(state.zones['A:deck']!.contents.items.length, count);
  throwsCode(() => run(state, { kind: 'set_turn', phase: 'check', playerId: 'A' }), 'INVALID_COMMAND');
});

test('操作权交接与归还只改变operator，拒绝嵌套和错误归还', () => {
  let state = starts(game());
  state = run(state, { kind: 'handoff', to: 'B', reason: '选择替换宝可梦' }).state;
  assert.equal(state.flow.turnOwner, 'A'); assert.equal(state.flow.operator, 'B');
  throwsCode(() => move(state, zone('A:deck'), 'A:hand'), 'NOT_OPERATOR');
  throwsCode(() => run(state, { kind: 'handoff', to: 'A', reason: '嵌套' }, b), 'INVALID_HANDOFF');
  state = run(state, { kind: 'handoff', to: 'A', reason: '已选', returning: true }, b).state;
  assert.equal(state.flow.operator, 'A'); assert.equal(state.flow.handoffReturnTo, null);
});

test('普通结果需对手确认，等待期间冻结普通命令且结束后拒绝修改', () => {
  let state = starts(game());
  state = run(state, { kind: 'report_result', result: { kind: 'win', winner: 'A', reason: '拿完奖赏' } }).state;
  assert.equal(state.flow.phase, 'result_pending'); assert.equal(state.flow.result, null);
  throwsCode(() => run(state, { kind: 'confirm_result', agree: true }), 'INVALID_PHASE');
  throwsCode(() => run(state, { kind: 'declare', text: '继续' }, b), 'RESULT_PENDING');
  state = run(state, { kind: 'confirm_result', agree: true }, b).state;
  assert.equal(state.flow.phase, 'finished'); assert.equal(state.flow.result!.kind, 'win');
  throwsCode(() => run(state, { kind: 'concede' }), 'GAME_FINISHED');
});

test('裁判处置可确认当前待定结果，不能确认不存在的报告', () => {
  const disposition: Actor = { kind: 'system', purpose: 'disposition' };
  let state = starts(game());
  throwsCode(() => run(state, { kind: 'confirm_result', agree: true }, disposition), 'INVALID_PHASE');
  state = run(state, { kind: 'report_result', result: { kind: 'win', winner: 'A', reason: '已取得全部奖赏' } }).state;
  state = run(state, { kind: 'confirm_result', agree: true }, disposition).state;
  assert.equal(state.flow.phase, 'finished');
  assert.deepEqual(state.flow.result, { kind: 'win', winner: 'A', reason: '已取得全部奖赏' });
});

test('认输不要求操作权，平局须确认，异常结束限系统', () => {
  const state = starts(game());
  const conceded = run(state, { kind: 'concede' }, b).state;
  assert.deepEqual(conceded.flow.result, { kind: 'win', winner: 'A', reason: 'B认输' });
  const draw = run(state, { kind: 'report_result', result: { kind: 'draw', reason: '双方平局' } }).state;
  assert.equal(run(draw, { kind: 'confirm_result', agree: true }, b).state.flow.result!.kind, 'draw');
  throwsCode(() => run(state, { kind: 'report_result', result: { kind: 'abnormal', reason: '异常' } }), 'SYSTEM_ONLY');
  assert.equal(run(state, { kind: 'report_result', result: { kind: 'abnormal', reason: '裁判异常结束' } }, { kind: 'system', purpose: 'disposition' }).state.flow.phase, 'finished');
});

test('system_progress 更新flow/setup，system_restore恢复完整状态且版本持续递增', () => {
  const state = game(), snapshot = structuredClone(state);
  const advanced = move(starts(state), zone('A:deck'), 'A:hand');
  const setup = structuredClone(advanced.setup); setup.stage = 'done';
  const progressed = run(advanced, { kind: 'system_progress', setup }, system).state;
  assert.equal(progressed.setup.stage, 'done');
  const restored = run(progressed, { kind: 'system_restore', state: snapshot }, { kind: 'system', purpose: 'disposition' }).state;
  assert.equal(restored.revision, progressed.revision + 1);
  assert.deepEqual(restored.flow, snapshot.flow); assert.deepEqual(restored.setup, snapshot.setup); assert.deepEqual(restored.zones, snapshot.zones);
  assert.deepEqual(snapshot, state);
  throwsCode(() => run(state, { kind: 'system_progress', setup }), 'SYSTEM_ONLY');
});

test('restore 拒绝错误对局、重复卡牌与孤立卡牌，原状态不变', () => {
  const state = game(), invalid = structuredClone(state);
  invalid.id = 'other';
  throwsCode(() => run(state, { kind: 'system_restore', state: invalid }, debug), 'INVALID_RESTORE');
  invalid.id = state.id; invalid.zones['A:hand']!.contents.items.push(invalid.zones['A:deck']!.contents.items[0]!);
  throwsCode(() => run(state, { kind: 'system_restore', state: invalid }, debug), 'INVALID_STATE');
  invalid.zones['A:hand']!.contents.items = []; invalid.zones['A:deck']!.contents.items.shift();
  throwsCode(() => run(state, { kind: 'system_restore', state: invalid }, debug), 'INVALID_STATE');
  assert.equal(state.zones['A:deck']!.contents.items.length, 12);
});

test('后端专属准备和异议协议必须明确拒绝', () => {
  const state = game();
  throwsCode(() => run(state, { kind: 'choose_first', firstPlayer: 'A' }), 'RUNTIME_COMMAND_REQUIRED');
  throwsCode(() => run(state, { kind: 'object', targetEventId: 'event', reason: '违反规则', evidenceRefs: [] }), 'RUNTIME_COMMAND_REQUIRED');
  throwsCode(() => run(state, { kind: 'move', source: zone('A:deck'), destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 0 } }, { kind: 'system', purpose: 'disposition' }), 'SYSTEM_SCOPE');
});

test('隐藏投影无UUID、归属、唯一标记和隐藏组结构，不暴露对手卡组', () => {
  let state = addGroup(game(), 'A:deck', 0);
  state = inGroup(state, zone('A:deck', [1, 2]), 'A:deck');
  state = run(state, { kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:deck', index: 0 } }, field: { key: 'marker', name: 'group-secret', value: '唯一' } }).state;
  state = run(state, { kind: 'set_state', target: { kind: 'card', position: { zoneId: 'A:deck', index: 0, member: { relation: 'stack', index: 0 } } }, field: { key: 'marker', name: 'card-secret', value: '唯一' } }).state;
  const view = projectTable(state, 'A'), text = JSON.stringify(view);
  assert.equal(text.includes('id-'), false); assert.equal(text.includes('仅乙有的描述'), false); assert.equal(text.includes('group-secret'), false); assert.equal(text.includes('card-secret'), false);
  assert.deepEqual(view.zones.find(z => z.id === 'A:deck')!.items[0], { kind: 'hidden', position: { zoneId: 'A:deck', index: 0 } });
  assert.equal(view.ownDeck!.name, '甲卡组');
  const omni = projectTable(state, 'omniscient');
  assert.equal(omni.zones.find(z => z.id === 'A:deck')!.items[0]!.kind, 'group');
});

test('可见覆盖、私有手牌和准备敏感choice按席位投影，返回视图可安全修改', () => {
  let state = move(game(), zone('A:deck'), 'A:hand');
  const flow = structuredClone(state.flow);
  flow.choice = { kind: 'mulligan_draw', playerId: 'A', maximum: 3, eligible: [{ zoneId: 'A:hand', index: 0 }], failedHands: [[energy]], message: '私有提示' };
  state = run(state, { kind: 'system_progress', flow }, system).state;
  const av = projectTable(state, 'A'), bv = projectTable(state, 'B');
  assert.equal(av.zones.find(z => z.id === 'A:hand')!.items[0]!.kind, 'card');
  assert.equal(bv.zones.find(z => z.id === 'A:hand')!.items[0]!.kind, 'hidden');
  assert.deepEqual(bv.flow.choice, { kind: 'mulligan_draw', playerId: 'A' });
  assert.equal(av.flow.choice!.maximum, 3);
  av.flow.operator = 'B'; av.ownDeck!.name = '改动';
  assert.equal(state.flow.operator, 'A'); assert.equal(state.players[0].deck.name, '甲卡组');
});

test('P03 区域可见范围须非空，开局公开不影响覆盖', () => {
  let state = addGroup(game());
  state = inGroup(state, zone('A:deck', [0, 1]));
  state = run(state, { kind: 'set_state', target: { kind: 'card', position: { zoneId: 'A:active', index: 0, member: { relation: 'stack', index: 0 } } }, field: { key: 'visibility', value: { mode: 'hidden' } } }).state;
  assert.equal(projectTable(state, 'B').zones.find(zone => zone.id === 'A:active')!.items[0]!.kind, 'hidden');
  state = run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:active' }, field: { key: 'visibility', value: { mode: 'public' } } }, system).state;
  const view = projectTable(state, 'B').zones.find(zone => zone.id === 'A:active')!.items[0]!;
  assert.equal(view.kind, 'group');
  if (view.kind === 'group') { assert.equal(view.stack[0]!.kind, 'hidden'); assert.equal(view.stack[1]!.kind, 'card'); }
  throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:active' }, field: { key: 'visibility', value: null } }), 'INVALID_FIELD');
  throwsCode(() => run(state, { kind: 'set_state', target: { kind: 'zone', zoneId: 'A:active' }, field: { key: 'marker', name: 'x', value: true } }), 'INVALID_FIELD');
});

test('P02 洗槽位all保留空位，洗成员保持所属组和组状态', () => {
  let state = move(game(), zone('A:deck', [0, 1]), 'A:prizes', 3);
  const before = structuredClone(state.zones['A:prizes']!.contents.items);
  state = executeCore(state, { kind: 'shuffle', selection: all('A:prizes') }, a, entropy([0])).state;
  assert.deepEqual(state.zones['A:prizes']!.contents.items, [null, null, null, before[4], before[3], null]);
  state = addGroup(state);
  state = inGroup(state, zone('A:deck', [0, 1, 2]));
  const id = state.zones['A:active']!.contents.items[0]!.id;
  const cards = [...state.groups[id]!.stack];
  const result = executeCore(state, { kind: 'shuffle', selection: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation: 'stack' }, range: { mode: 'all' } } }, a, entropy([0, 0]));
  assert.deepEqual(result.state.groups[id]!.stack, [cards[1], cards[2], cards[0]]);
  assert.deepEqual(result.state.groups[id]!.state, state.groups[id]!.state);
});

test('所有对外结果及失败信息不含内部身份或隐藏牌名', () => {
  const state = game();
  const outcomes = [
    run(state, { kind: 'look', selection: all('B:deck') }).result,
    run(state, { kind: 'shuffle', selection: all('B:deck') }).result,
    run(state, { kind: 'random', mode: 'selection', selection: all('B:deck') }).result,
  ];
  for (const result of outcomes) {
    const text = JSON.stringify(result);
    assert.equal(text.includes('id-'), false); assert.equal(text.includes('基本火能量'), false); assert.equal(text.includes('仅乙有的描述'), false);
  }
  assert.throws(() => move(state, zone('B:deck'), 'missing'), error => error instanceof CoreError && !error.message.includes('id-'));
});

test('move末尾位置在实际移出后计算，连续放牌不需要调用者数牌',()=>{
 const initial=starts(game()), objects=[...initial.zones['A:deck']!.contents.items];
 const result=run(initial,{kind:'move',source:zone('A:deck',[0]),destination:{container:{kind:'zone',zoneId:'A:deck'},index:'end'}});
 assert.deepEqual(result.state.zones['A:deck']!.contents.items,[...objects.slice(1),objects[0]]);
 assert.deepEqual(result.result,{count:1,destinationIndex:objects.length-1});
 const second=run(result.state,{kind:'move',source:zone('A:deck',[0,1]),destination:{container:{kind:'zone',zoneId:'A:deck'},index:'end'}});
 assert.deepEqual(second.state.zones['A:deck']!.contents.items.slice(-2),objects.slice(1,3));
 assert.deepEqual(initial.zones['A:deck']!.contents.items,objects);
});
test('末尾插入支持公开组成员，拒绝槽位和推断隐藏组大小',()=>{
 let state=starts(game());state=addGroup(state);state=inGroup(state,zone('A:deck'));
 state=run(state,{kind:'set_state',target:{kind:'zone',zoneId:'A:active'},field:{key:'visibility',value:{mode:'public'}}}).state;
 const result=run(state,{kind:'move',source:zone('A:deck'),destination:{container:{kind:'group',position:{zoneId:'A:active',index:0},relation:'attached'},index:'end'}});
 assert.deepEqual(result.result,{count:1,destinationIndex:0});
 throwsCode(()=>run(state,{kind:'move',source:zone('A:deck'),destination:{container:{kind:'zone',zoneId:'A:bench'},index:'end'}}),'END_REQUIRES_SEQUENCE');
 const hidden=run(state,{kind:'set_state',target:{kind:'card',position:{zoneId:'A:active',index:0,member:{relation:'stack',index:0}}},field:{key:'visibility',value:{mode:'players',playerIds:['A']}}}).state;
 throwsCode(()=>run(hidden,{kind:'move',source:zone('A:deck'),destination:{container:{kind:'group',position:{zoneId:'A:active',index:0},relation:'attached'},index:'end'}}),'HIDDEN_INFORMATION');
});
