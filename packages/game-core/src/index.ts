import { randomInt, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { DeckSchema, GameCommandSchema } from '../../protocol/src/index.ts';
import type {
  Actor, CardView, Container, CoreCommand, CoreResult,
  Entropy, GameState, HiddenView, Json, ObjectRef, ObjectView, PlayerId, PlayerSpec,
  Position, Reveal, Selection, TableView, Viewer, Visibility, Zone, ZoneKind,
} from '../../protocol/src/index.ts';

export type * from '../../protocol/src/index.ts';

/** 错误只说明公开的位置和结构，不把隐藏卡牌资料放入文字。 */
export class CoreError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'CoreError'; this.code = code; }
}

const defaults: Entropy = { uuid: randomUUID, integer: randomInt };
const other = (id: PlayerId): PlayerId => id === 'A' ? 'B' : 'A';
function fail(code: string, message: string): never { throw new CoreError(code, message); }
const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
const eq = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const integer = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INDEX', `${label}必须是非负安全整数`);
};
const validPlayer = (id: unknown): id is PlayerId => id === 'A' || id === 'B';
const validVisibility = (value: Visibility): boolean => value?.mode === 'hidden' || value?.mode === 'public' ||
  (value?.mode === 'players' && Array.isArray(value.playerIds) && value.playerIds.length > 0 && new Set(value.playerIds).size === value.playerIds.length && value.playerIds.every(validPlayer));
const readRandom = (entropy: Entropy, max: number): number => {
  const value = entropy.integer(max);
  if (!Number.isSafeInteger(value) || value < 0 || value >= max) fail('INVALID_ENTROPY', '随机源返回了无效结果');
  return value;
};
function freshId(state: Pick<GameState, 'cards' | 'groups' | 'definitions'>, entropy: Entropy): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = entropy.uuid();
    if (typeof id !== 'string' || !id) fail('INVALID_ENTROPY', '身份生成器返回了无效结果');
    if (!Object.hasOwn(state.cards, id) && !Object.hasOwn(state.groups, id) && !Object.hasOwn(state.definitions, id)) return id;
  }
  return fail('INVALID_ENTROPY', '身份生成器重复返回已有身份');
}

export function createGame(input: { id: string; players: [PlayerSpec, PlayerSpec] }, entropy: Entropy = defaults): GameState {
  if (!input.id || input.players.length !== 2 || input.players[0].id !== 'A' || input.players[1].id !== 'B') fail('INVALID_GAME', '必须按 A、B 顺序提供双方资料');
  for (const player of input.players) {
    if (!Value.Check(DeckSchema, player.deck)) fail('INVALID_DECK', '卡组 JSON 不符合资料格式');
    if (!player.deck.cards.some(entry => entry.card.kind === 'pokemon' && entry.card.stage === '基础')) fail('NO_BASIC_POKEMON', '每副卡组至少需要一张基础宝可梦');
  }
  const state: GameState = {
    schemaVersion: 1, id: input.id, revision: 0, players: clone(input.players), definitions: {}, cards: {}, groups: {}, zones: {},
    playerMarkers: { A: {}, B: {} },
    flow: { phase: 'setup', turnOwner: null, operator: 'A', turnNumber: 0, firstPlayer: null, choice: null, handoffReturnTo: null, proposedResult: null, result: null },
    setup: { stage: 'first', mulligans: { A: 0, B: 0 }, bonus: { A: 0, B: 0 }, placed: { A: false, B: false }, bonusChosen: { A: false, B: false }, additionalChosen: { A: false, B: false }, failedHands: { A: [], B: [] } },
  };
  const kinds: Exclude<ZoneKind, 'stadium'>[] = ['deck', 'hand', 'prizes', 'discard', 'lost', 'active', 'bench', 'staging'];
  for (const player of state.players) for (const kind of kinds) {
    const length = kind === 'prizes' ? 6 : kind === 'bench' ? 5 : kind === 'active' ? 1 : 0;
    const visibility: Visibility = kind === 'deck' || kind === 'prizes' ? { mode: 'hidden' } :
      kind === 'discard' || kind === 'lost' ? { mode: 'public' } : { mode: 'players', playerIds: [player.id] };
    const id = `${player.id}:${kind}`;
    state.zones[id] = { id, kind, playerId: player.id, contents: { layout: length ? 'slots' : 'sequence', items: Array.from({ length }, () => null) }, defaultVisibility: visibility };
  }
  state.zones.stadium = { id: 'stadium', kind: 'stadium', playerId: null, contents: { layout: 'slots', items: [null] }, defaultVisibility: { mode: 'public' } };
  const definitions = new Map<string, string>();
  for (const player of state.players) for (const entry of player.deck.cards) {
    const key = canonical(entry.card);
    let definitionId = definitions.get(key);
    if (!definitionId) { definitionId = freshId(state, entropy); state.definitions[definitionId] = clone(entry.card); definitions.set(key, definitionId); }
    for (let index = 0; index < entry.count; index++) {
      const id = freshId(state, entropy);
      state.cards[id] = { id, definitionId, ownerId: player.id, state: { markers: {} } };
      state.zones[`${player.id}:deck`]!.contents.items.push({ kind: 'card', id });
    }
  }
  assertState(state);
  return state;
}

interface ResolvedContainer { kind: 'zone' | 'group'; zoneId: string; groupId?: string; relation?: 'stack' | 'attached' }
function zoneAt(state: GameState, id: string): Zone { return state.zones[id] ?? fail('ZONE_NOT_FOUND', '指定区域不存在'); }
function objectAt(state: GameState, position: Position): ObjectRef {
  integer(position.index, '区域下标');
  const root = zoneAt(state, position.zoneId).contents.items[position.index];
  if (!root) fail('INVALID_POSITION', '指定位置越界或为空');
  if (!position.member) return root;
  if (root.kind !== 'group') fail('INVALID_POSITION', '指定位置不是卡牌组');
  integer(position.member.index, '成员下标');
  const relation = position.member.relation;
  if (relation !== 'stack' && relation !== 'attached') fail('INVALID_POSITION', '成员关系无效');
  const cardId = state.groups[root.id]![relation][position.member.index];
  if (!cardId) fail('INVALID_POSITION', '指定成员位置越界');
  return { kind: 'card', id: cardId };
}
function resolveContainer(state: GameState, ref: Container): ResolvedContainer {
  if (ref.kind === 'zone') { zoneAt(state, ref.zoneId); return { kind: 'zone', zoneId: ref.zoneId }; }
  if (ref.kind !== 'group' || 'member' in ref.position) fail('INVALID_CONTAINER', '容器引用无效');
  const object = objectAt(state, ref.position);
  if (object.kind !== 'group') fail('INVALID_CONTAINER', '指定位置不是卡牌组');
  if (ref.relation !== 'stack' && ref.relation !== 'attached') fail('INVALID_CONTAINER', '成员关系无效');
  return { kind: 'group', zoneId: ref.position.zoneId, groupId: object.id, relation: ref.relation };
}
function contents(state: GameState, container: ResolvedContainer): (ObjectRef | null)[] {
  return container.kind === 'zone' ? state.zones[container.zoneId]!.contents.items : state.groups[container.groupId!]![container.relation!].map(id => ({ kind: 'card', id }));
}
function writeContents(state: GameState, container: ResolvedContainer, objects: (ObjectRef | null)[]): void {
  if (container.kind === 'zone') state.zones[container.zoneId]!.contents.items = objects;
  else state.groups[container.groupId!]![container.relation!] = objects.map(object => object!.id);
}
function selectedIndices(items: (ObjectRef | null)[], selection: Selection): number[] {
  const range = selection.range;
  let indices: number[];
  if (range.mode === 'all') return items.flatMap((object, index) => object ? [index] : []);
  if (range.mode === 'range') {
    integer(range.start, '起点'); integer(range.count, '数量');
    if (range.start > items.length || range.count > items.length - range.start) fail('OUT_OF_RANGE', '选择区间越界');
    indices = Array.from({ length: range.count }, (_, index) => range.start + index);
  } else if (range.mode === 'indices') {
    indices = [...range.indices]; indices.forEach(index => integer(index, '选择下标'));
    if (new Set(indices).size !== indices.length) fail('DUPLICATE_INDEX', '选择下标不能重复');
    indices.sort((a, b) => a - b);
  } else return fail('INVALID_SELECTION', '选择范围无效');
  for (const index of indices) {
    if (index >= items.length) fail('OUT_OF_RANGE', '选择下标越界');
    if (!items[index]) fail('EMPTY_SLOT', '明确选择不能包含空槽位');
  }
  return indices;
}
function resolveDetails(state: GameState, selection: Selection) {
  const container = resolveContainer(state, selection.container), items = contents(state, container);
  const indices = selectedIndices(items, selection);
  return { container, indices, objects: indices.map(index => items[index]!) };
}
export function resolveSelection(state: GameState, selection: Selection): ObjectRef[] { return clone(resolveDetails(state, selection).objects); }
export function findCardPosition(state: GameState, cardId: string): Position | null {
  for (const zone of Object.values(state.zones)) for (let index = 0; index < zone.contents.items.length; index++) {
    const object = zone.contents.items[index];
    if (object?.kind === 'card' && object.id === cardId) return { zoneId: zone.id, index };
    if (object?.kind === 'group') for (const relation of ['stack', 'attached'] as const) {
      const memberIndex = state.groups[object.id]![relation].indexOf(cardId);
      if (memberIndex !== -1) return { zoneId: zone.id, index, member: { relation, index: memberIndex } };
    }
  }
  return null;
}
function removeItems(state: GameState, container: ResolvedContainer, indices: number[]): void {
  const selected = new Set(indices), items = contents(state, container);
  const slots = container.kind === 'zone' && zoneAt(state, container.zoneId).contents.layout === 'slots';
  writeContents(state, container, slots ? items.map((object, index) => selected.has(index) ? null : object) : items.filter((_, index) => !selected.has(index)));
}
function insertItems(state: GameState, container: ResolvedContainer, index: number, objects: ObjectRef[]): void {
  integer(index, '目标下标');
  if (container.kind === 'group' && objects.some(object => object.kind === 'group')) fail('NESTED_GROUP', '卡牌组不能包含卡牌组');
  const items = contents(state, container);
  if (index > items.length) fail('OUT_OF_RANGE', '目标下标超过移出后的容器长度');
  const slots = container.kind === 'zone' && zoneAt(state, container.zoneId).contents.layout === 'slots';
  if (slots) for (let offset = 0; offset < objects.length; offset++) {
    const target = index + offset;
    if (target < items.length && items[target]) fail('OCCUPIED_SLOT', '目标槽位已有对象');
    items[target] = objects[offset]!;
  } else items.splice(index, 0, ...objects);
  writeContents(state, container, items);
}
/** 自动末尾只使用双方已知的容器大小；不能推断隐藏卡牌组结构。 */
function allowEndDestination(state: GameState, container: ResolvedContainer): void {
  if (container.kind === 'zone') {
    if (zoneAt(state,container.zoneId).contents.layout !== 'sequence') fail('END_REQUIRES_SEQUENCE','末尾位置只适用于顺序容器');
    return;
  }
  const index = zoneAt(state,container.zoneId).contents.items.findIndex(item=>item?.kind==='group' && item.id===container.groupId);
  for (const player of ['A','B'] as const) if (projectTable(state,player).zones.find(zone=>zone.id===container.zoneId)?.items[index]?.kind !== 'group') fail('HIDDEN_INFORMATION','不能自动计算隐藏卡牌组的末尾');
}
function positionIn(state: GameState, container: ResolvedContainer, index: number): Position {
  if (container.kind === 'zone') return { zoneId: container.zoneId, index };
  const root = zoneAt(state, container.zoneId).contents.items.findIndex(object => object?.kind === 'group' && object.id === container.groupId);
  if (root < 0) fail('INVALID_CONTAINER', '卡牌组不在指定区域');
  return { zoneId: container.zoneId, index: root, member: { relation: container.relation!, index } };
}
function cardsOf(state: GameState, object: ObjectRef): string[] { return object.kind === 'card' ? [object.id] : [...state.groups[object.id]!.stack, ...state.groups[object.id]!.attached]; }
function revealSelection(state: GameState, selection: Selection): Reveal['cards'] {
  const resolved = resolveDetails(state, selection);
  return resolved.objects.flatMap(object => cardsOf(state, object).map(id => ({ position: findCardPosition(state, id)!, card: clone(state.definitions[state.cards[id]!.definitionId]!) })));
}

function authorize(state: GameState, command: CoreCommand, actor: Actor): void {
  if (actor.kind === 'system') {
    const permitted = actor.purpose === 'debug' || command.kind === 'system_progress' ||
      (actor.purpose === 'disposition' ? ['system_restore', 'shuffle', 'report_result', 'confirm_result'].includes(command.kind) :
        ['move', 'shuffle', 'set_state', 'show', 'random', 'create_group', 'remove_group', 'declare', 'set_turn'].includes(command.kind));
    if (!permitted) fail('SYSTEM_SCOPE', '系统用途不允许执行此命令');
    if (command.kind === 'look' || command.kind === 'concede') fail('PLAYER_REQUIRED', '该命令需要具体玩家身份');
    return;
  }
  if (!validPlayer(actor.playerId)) fail('INVALID_ACTOR', '玩家身份无效');
  if (command.kind === 'system_progress' || command.kind === 'system_restore') fail('SYSTEM_ONLY', '仅允许内部系统执行');
  if (state.flow.phase === 'finished') fail('GAME_FINISHED', '对局已经结束');
  if (command.kind === 'concede') return;
  if (command.kind === 'confirm_result') {
    if (state.flow.phase !== 'result_pending' || state.flow.choice?.kind !== 'result_confirm' || state.flow.choice.playerId !== actor.playerId) fail('INVALID_PHASE', '当前没有请求该玩家确认结果');
    return;
  }
  if (state.flow.phase === 'result_pending') fail('RESULT_PENDING', '结果等待确认，不能修改牌桌');
  if (state.flow.operator !== actor.playerId) fail('NOT_OPERATOR', '当前不持有操作权');
}

export function executeCore(input: GameState, command: CoreCommand, actor: Actor, entropy: Entropy = defaults): CoreResult {
  if (command.kind !== 'system_progress' && command.kind !== 'system_restore' && !Value.Check(GameCommandSchema, command)) fail('INVALID_COMMAND', '命令格式无效');
  authorize(input, command, actor);
  const state = clone(input);
  let result: Json = {}, reveals: Reveal[] = [], changed = true;
  const empty = () => { changed = false; result = { reason: '选择为空' }; };
  switch (command.kind) {
    case 'move': {
      const source = resolveDetails(state, command.source), destination = resolveContainer(state, command.destination.container);
      const requestedIndex = command.destination.index;
      if (requestedIndex === 'end') allowEndDestination(state,destination); else integer(requestedIndex, '目标下标');
      if (source.objects.length > 1 && source.objects.some(object => object.kind === 'group')) fail('MULTIPLE_GROUPS', '批量移动只接受同源单卡');
      if (destination.kind === 'group' && source.objects.some(object => object.kind === 'group')) fail('NESTED_GROUP', '卡牌组不能放入卡牌组');
      if (!source.objects.length) { insertItems(state, destination, requestedIndex === 'end' ? contents(state,destination).length : requestedIndex, []); empty(); break; }
      removeItems(state, source.container, source.indices);
      const destinationIndex = requestedIndex === 'end' ? contents(state,destination).length : requestedIndex;
      insertItems(state, destination, destinationIndex, source.objects);
      if (source.container.zoneId !== destination.zoneId) for (const object of source.objects) for (const id of cardsOf(state, object)) delete state.cards[id]!.state.visibility;
      changed = !eq(state, input); result = { count: source.objects.length, ...(requestedIndex === 'end' ? {destinationIndex} : {}) }; break;
    }
    case 'shuffle': {
      const selected = resolveDetails(state, command.selection);
      if (!selected.objects.length) { empty(); break; }
      const shuffled = [...selected.objects];
      const shuffleEntropy = entropy.scoped?.(`shuffle:${state.flow.turnNumber}:${canonical(selected.container)}`) ?? entropy;
      for (let index = shuffled.length - 1; index > 0; index--) { const target = readRandom(shuffleEntropy, index + 1); [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!]; }
      const items = contents(state, selected.container);
      selected.indices.forEach((index, offset) => { items[index] = shuffled[offset]!; });
      writeContents(state, selected.container, items); result = { count: shuffled.length }; break;
    }
    case 'set_state': {
      const field = command.field;
      let target: Record<string, unknown>, kind: string = command.target.kind;
      if (command.target.kind === 'zone') {
        if (field.key !== 'visibility' || field.value === null) fail('INVALID_FIELD', '区域仅支持设置非空默认可见范围');
        zoneAt(state, command.target.zoneId).defaultVisibility = clone(field.value);
        changed = !eq(state, input); result = { key: field.key }; break;
      } else if (command.target.kind === 'player') target = { markers: state.playerMarkers[command.target.playerId] };
      else {
        const object = objectAt(state, command.target.position);
        if (object.kind !== command.target.kind) fail('INVALID_TARGET', '目标对象类型不匹配');
        target = object.kind === 'card' ? state.cards[object.id]!.state : state.groups[object.id]!.state as unknown as Record<string, unknown>;
      }
      if (field.key === 'marker') {
        const markers = target.markers as Record<string, string | number | boolean>;
        if (field.value === null) delete markers[field.name]; else Object.defineProperty(markers, field.name, { value: field.value, enumerable: true, configurable: true, writable: true });
      } else if (field.key === 'visibility') {
        if (kind !== 'card') fail('INVALID_FIELD', '当前对象不支持牌面可见范围');
        if (field.value === null) delete target.visibility; else target.visibility = clone(field.value);
      } else {
        if (kind !== 'group') fail('INVALID_FIELD', '当前对象不支持组状态');
        target[field.key] = clone(field.value);
      }
      changed = !eq(state, input); result = { key: field.key }; break;
    }
    case 'look': case 'show': {
      const selected = resolveDetails(state, command.selection);
      if (!selected.objects.length) { empty(); break; }
      const cards = revealSelection(state, command.selection);
      const recipients: PlayerId[] = command.kind === 'show' ? ['A', 'B'] : [actor.kind === 'player' ? actor.playerId : fail('PLAYER_REQUIRED', '查看需要玩家身份')];
      reveals = [{ recipients, cards }]; result = { count: cards.length }; break;
    }
    case 'random': {
      const randomEntropy = entropy.scoped?.(`random:${state.flow.turnNumber}:${actor.kind === 'player' ? actor.playerId : actor.purpose}:${command.mode}:${command.selection ? canonical(command.selection.container) : ''}`) ?? entropy;
      if (command.mode === 'selection') {
        if (!command.selection) fail('INVALID_COMMAND', '随机选择需要指定范围');
        const selected = resolveDetails(state, command.selection), count = command.count ?? 1;
        if (!selected.objects.length) { empty(); break; }
        if (count > selected.objects.length) fail('OUT_OF_RANGE', '随机选择数量超过候选位置');
        const available = [...selected.indices], positions: Position[] = [];
        for (let index = 0; index < count; index++) positions.push(positionIn(state, selected.container, available.splice(readRandom(randomEntropy, available.length), 1)[0]!));
        result = { mode: 'selection', positions: positions as unknown as Json }; break;
      }
      if (command.selection || (command.mode === 'until_tails' && command.count !== undefined)) fail('INVALID_COMMAND', '投币参数不适用于当前模式');
      const coins: string[] = [];
      const count = command.mode === 'coins' ? command.count ?? 1 : 1000;
      for (let index = 0; index < count; index++) {
        const coin = readRandom(randomEntropy, 2) === 0 ? 'heads' : 'tails'; coins.push(coin);
        if (command.mode === 'until_tails' && coin === 'tails') break;
      }
      if (command.mode === 'until_tails' && coins.at(-1) !== 'tails') fail('RANDOM_LIMIT_EXCEEDED', '连续投币在1000次限额内未达到反面，操作未完成');
      result = { mode: command.mode, coins }; break;
    }
    case 'create_group': {
      const destination = resolveContainer(state, command.destination.container);
      if (destination.kind !== 'zone') fail('NESTED_GROUP', '只能在区域创建卡牌组');
      const id = freshId(state, entropy);
      state.groups[id] = { id, stack: [], attached: [], state: { damageCounters: 0, specialConditions: [], markers: {} } };
      insertItems(state, destination, command.destination.index, [{ kind: 'group', id }]); result = { position: { zoneId: destination.zoneId, index: command.destination.index } }; break;
    }
    case 'remove_group': {
      if (command.position.member) fail('INVALID_TARGET', '移除卡牌组不能指定成员');
      const object = objectAt(state, command.position);
      if (object.kind !== 'group') fail('INVALID_TARGET', '指定位置不是卡牌组');
      const group = state.groups[object.id]!;
      if (group.stack.length || group.attached.length) fail('GROUP_NOT_EMPTY', '不能移除非空卡牌组');
      removeItems(state, { kind: 'zone', zoneId: command.position.zoneId }, [command.position.index]);
      delete state.groups[object.id]; result = { removed: true }; break;
    }
    case 'declare': result = { text: command.text }; break;
    case 'set_turn': {
      if (state.flow.phase === 'setup' && actor.kind !== 'system') fail('INVALID_PHASE', '准备流程尚未完成');
      if ((command.phase === 'check') !== (command.playerId === null)) fail('INVALID_COMMAND', '回合必须指定归属，检查阶段必须没有回合归属');
      state.flow.phase = command.phase; state.flow.turnOwner = command.playerId; state.flow.choice = null; state.flow.handoffReturnTo = null;
      if (command.phase === 'turn') { state.flow.operator = command.playerId!; state.flow.turnNumber++; }
      changed = !eq(state, input); result = { phase: command.phase, turnOwner: command.playerId }; break;
    }
    case 'handoff': {
      if (command.returning) {
        if (!state.flow.handoffReturnTo || command.to !== state.flow.handoffReturnTo) fail('INVALID_HANDOFF', '必须归还给已记录的操作方');
        state.flow.operator = command.to; state.flow.handoffReturnTo = null; state.flow.choice = null;
      } else {
        if (state.flow.handoffReturnTo || state.flow.operator === command.to) fail('INVALID_HANDOFF', '不能嵌套交接或交给当前操作方');
        state.flow.handoffReturnTo = state.flow.operator; state.flow.operator = command.to;
        state.flow.choice = { kind: 'handoff', playerId: command.to, message: command.reason };
      }
      result = { to: command.to, returning: command.returning ?? false }; break;
    }
    case 'report_result': {
      if (command.result.kind === 'abnormal') {
        if (actor.kind !== 'system' || actor.purpose === 'setup') fail('SYSTEM_ONLY', '异常结束需要裁判处置或显式系统调试');
        state.flow.result = clone(command.result); state.flow.phase = 'finished'; state.flow.proposedResult = null; state.flow.choice = null; state.flow.handoffReturnTo = null;
      } else {
        const responder = actor.kind === 'player' ? other(actor.playerId) : other(state.flow.operator);
        state.flow.phase = 'result_pending'; state.flow.proposedResult = clone(command.result);
        state.flow.operator = responder; state.flow.choice = { kind: 'result_confirm', playerId: responder }; state.flow.handoffReturnTo = null;
      }
      result = { reported: true }; break;
    }
    case 'confirm_result': {
      if (state.flow.phase !== 'result_pending' || !state.flow.proposedResult) fail('INVALID_PHASE', '当前没有待确认结果');
      state.flow.result = clone(state.flow.proposedResult); state.flow.proposedResult = null; state.flow.phase = 'finished'; state.flow.choice = null; result = { confirmed: true }; break;
    }
    case 'concede': {
      if (actor.kind !== 'player') fail('PLAYER_REQUIRED', '认输需要玩家身份');
      state.flow.result = { kind: 'win', winner: other(actor.playerId), reason: `${actor.playerId}认输` };
      state.flow.phase = 'finished'; state.flow.proposedResult = null; state.flow.choice = null; state.flow.handoffReturnTo = null; result = { concededBy: actor.playerId }; break;
    }
    case 'system_progress': {
      if (command.flow) state.flow = clone(command.flow);
      if (command.setup) state.setup = clone(command.setup);
      changed = !eq(state, input); result = { progressed: changed }; break;
    }
    case 'system_restore': {
      if (command.state.id !== input.id || command.state.schemaVersion !== input.schemaVersion) fail('INVALID_RESTORE', '恢复状态不属于当前对局');
      const restored = clone(command.state); restored.revision = input.revision + 1; assertState(restored);
      return { state: restored, changed: true, result: { restored: true }, reveals: [] };
    }
    default: return fail('RUNTIME_COMMAND_REQUIRED', '该命令需要对局运行服务处理');
  }
  assertState(state);
  state.revision = changed ? input.revision + 1 : input.revision;
  return { state: changed ? state : clone(input), result, reveals, changed };
}

function canSee(visibility: Visibility, viewer: Viewer): boolean {
  return viewer === 'omniscient' || visibility.mode === 'public' || (visibility.mode === 'players' && visibility.playerIds.includes(viewer));
}
export function projectTable(state: GameState, viewer: Viewer): TableView {
  if (viewer !== 'omniscient' && !validPlayer(viewer)) fail('INVALID_VIEWER', '观察视角无效');
  const viewCard = (id: string, position: Position, zone: Zone): CardView | HiddenView => {
    const card = state.cards[id]!;
    return canSee(card.state.visibility ?? zone.defaultVisibility, viewer) ?
      { kind: 'card', position, card: clone(state.definitions[card.definitionId]!), ownerId: card.ownerId, markers: clone(card.state.markers) } : { kind: 'hidden', position };
  };
  const zones = Object.values(state.zones).map(zone => ({
    id: zone.id, kind: zone.kind, playerId: zone.playerId, layout: zone.contents.layout, defaultVisibility: clone(zone.defaultVisibility),
    items: zone.contents.items.map((object, index): ObjectView | null => {
      if (!object) return null;
      const position = { zoneId: zone.id, index };
      if (object.kind === 'card') return viewCard(object.id, position, zone);
      const group = state.groups[object.id]!;
      const members = (relation: 'stack' | 'attached') => group[relation].map((id, memberIndex) => viewCard(id, { ...position, member: { relation, index: memberIndex } }, zone));
      const stack = members('stack'), attached = members('attached');
      // 全部隐藏时折叠为单个占位，组形态和唯一标记都不能成为隐藏身份。
      if (viewer !== 'omniscient' && !stack.some(card => card.kind === 'card') && !attached.some(card => card.kind === 'card') && (!canSee(zone.defaultVisibility, viewer) || stack.length + attached.length > 0)) return { kind: 'hidden', position };
      return { kind: 'group', position, stack, attached, state: clone(group.state) };
    }),
  }));
  const flow = clone(state.flow);
  if (flow.choice && viewer !== 'omniscient' && flow.choice.playerId !== viewer) flow.choice = { kind: flow.choice.kind, playerId: flow.choice.playerId };
  return {
    id: state.id, revision: state.revision, viewer, players: state.players.map(({ id, name, kind }) => ({ id, name, kind })), zones, flow,
    ...(viewer !== 'omniscient' ? { ownDeck: clone(state.players.find(player => player.id === viewer)!.deck) } : {}),
    playerMarkers: viewer === 'omniscient' ? clone(state.playerMarkers) : { [viewer]: clone(state.playerMarkers[viewer]) },
  };
}

/** 结构不变量与玩法规则分离：不判 HP、进化、能量、卡组60张等。 */
function assertState(state: GameState): void {
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !validPlayer(state.flow.operator) || !validPlayer(state.flow.turnOwner) && state.flow.turnOwner !== null) fail('INVALID_STATE', '对局流程无效');
  const cards = new Set<string>(), groups = new Set<string>();
  const claimCard = (id: string) => {
    if (!state.cards[id] || cards.has(id)) fail('INVALID_STATE', '卡牌实例必须且只能存在于一个位置');
    const card = state.cards[id]!;
    if (!state.definitions[card.definitionId] || !validPlayer(card.ownerId) || card.state.visibility && !validVisibility(card.state.visibility)) fail('INVALID_STATE', '卡牌资料引用或可见范围无效');
    cards.add(id);
  };
  for (const zone of Object.values(state.zones)) {
    if (!validVisibility(zone.defaultVisibility)) fail('INVALID_STATE', '区域默认可见范围无效');
    for (const object of zone.contents.items) {
      if (!object) { if (zone.contents.layout === 'sequence') fail('INVALID_STATE', '序列中不能出现空槽位'); continue; }
      if (object.kind === 'card') claimCard(object.id);
      else if (object.kind === 'group') {
        const group = state.groups[object.id];
        if (!group || groups.has(object.id)) fail('INVALID_STATE', '卡牌组必须且只能存在于一个区域');
        if (!Number.isSafeInteger(group.state.damageCounters) || group.state.damageCounters < 0 || new Set(group.state.specialConditions).size !== group.state.specialConditions.length || group.state.specialConditions.some(value => !['poisoned', 'burned', 'asleep', 'paralyzed', 'confused'].includes(value))) fail('INVALID_STATE', '卡牌组状态无效');
        groups.add(object.id); [...group.stack, ...group.attached].forEach(claimCard);
      } else fail('INVALID_STATE', '区域对象类别无效');
    }
  }
  if (cards.size !== Object.keys(state.cards).length || groups.size !== Object.keys(state.groups).length) fail('INVALID_STATE', '存在没有位置的卡牌或卡牌组');
}
