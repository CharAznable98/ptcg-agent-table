import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGame } from '../packages/game-core/src/index.ts';
import type { CardData, DeckData, GameCommand, GameState, ObjectRef, PlayerId } from '../packages/protocol/src/index.ts';
import { MatchRuntime, type MatchRecord } from '../apps/server/src/match.ts';
import type { GameService } from '../apps/server/src/service.ts';
import { ReplayEntropy } from '../apps/server/src/entropy.ts';

/** 自行编写的非官方合成牌，供真实代理与浏览器重复验证，不依赖本机真实卡组。 */
export const practiceBasic: CardData = { kind: 'pokemon', name: '练习叶芽', hp: 100, types: ['草'], stage: '基础', abilities: [{ name: '补给', text: '自己的回合时可以使用1次。从自己的牌库抽1张牌。' }], attacks: [{ name: '轻击', energyCost: [{ type: '草', count: 1 }], damageText: '20', text: '' }], weaknesses: [], resistances: [], retreatCost: 1 };
export const practiceOther: CardData = { kind: 'pokemon', name: '练习岩团', hp: 120, types: ['斗'], stage: '基础', abilities: [], attacks: [{ name: '推击', energyCost: [], damageText: '10', text: '' }], weaknesses: [], resistances: [], retreatCost: 0 };
export const practiceEnergy: CardData = { kind: 'energy', name: '练习草能量', subtype: 'basic', energyType: '草' };
export const practiceSearch: CardData = { kind: 'trainer', name: '练习检索器', subtype: 'item', text: '从自己的牌库选择最多2张基本能量卡，给对手看过后加入手牌。然后重洗牌库。' };
export const practiceDiscard: CardData = { kind: 'trainer', name: '练习交换资源', subtype: 'item', text: '从自己的手牌选择1张卡丢弃。然后从自己的牌库抽2张牌。' };
export const practiceSwitch: CardData = { kind: 'trainer', name: '练习交换器', subtype: 'item', text: '将自己的战斗宝可梦与1只备战宝可梦互换。' };
export const practiceNumber: CardData = { kind: 'trainer', name: '练习补充器', subtype: 'item', text: '从自己的牌库抽最多3张牌。' };
export const practiceOrder: CardData = { kind: 'trainer', name: '练习整理器', subtype: 'item', text: '查看自己的牌库最上面的3张卡，以任意顺序放回牌库最上面。' };
export const practiceCoins: CardData = { kind: 'trainer', name: '练习分段硬币', subtype: 'item', text: '你可以选择投掷1至3次硬币。然后投掷1次硬币。' };
export const practiceEvolution: CardData = { ...practiceBasic, name: '练习枝芽', stage: '1阶进化', evolvesFrom: practiceBasic.name, hp: 140 };
export const practiceDeck: DeckData = { name: '非官方合成练习', cards: [
  { card: practiceBasic, count: 10 }, { card: practiceOther, count: 8 }, { card: practiceEnergy, count: 20 },
  { card: practiceSearch, count: 4 }, { card: practiceDiscard, count: 4 }, { card: practiceSwitch, count: 4 }, { card: practiceEvolution, count: 4 },
  { card: practiceNumber, count: 2 }, { card: practiceOrder, count: 2 }, { card: practiceCoins, count: 2 },
] };

export interface PracticeScenarioOptions {
  attachedEnergy?: boolean;
  aiSpectator?: boolean;
  handoff?: boolean;
  poisoned?: boolean;
  extraHand?: ('number' | 'order' | 'coins')[];
  /** 同名战斗/备战目标的真实选择验收。 */
  healingChoice?: boolean;
}

function seedTable(state: GameState, options: PracticeScenarioOptions) {
  function take(seat: PlayerId, name: string): ObjectRef {
    const deck = state.zones[`${seat}:deck`]!.contents.items;
    const index = deck.findIndex(ref => ref?.kind === 'card' && state.definitions[state.cards[ref.id]!.definitionId]?.name === name);
    const ref = deck.splice(index, 1)[0];
    if (index < 0 || !ref) throw new Error(`合成牌缺失：${seat}/${name}`);
    return ref;
  }
  function pokemon(seat: PlayerId, zone: 'active' | 'bench', index: number, name: string, damageCounters = 0) {
    const ref = take(seat, name), id = `practice:${seat}:${zone}:${index}`;
    state.groups[id] = { id, stack: [ref.id], attached: [], state: { damageCounters, specialConditions: [], markers: { enteredTurn: 1 } } };
    state.zones[`${seat}:${zone}`]!.contents.items[index] = { kind: 'group', id };
  }
  // 交权场景随后由 B 的 10 点招式造成昏厥；可选中毒检查先补 10 点。
  pokemon('A', 'active', 0, practiceBasic.name, options.handoff ? (options.poisoned ? 8 : 9) : 0);
  pokemon('A', 'bench', 0, practiceOther.name);
  pokemon('A', 'bench', 4, practiceBasic.name);
  pokemon('B', 'active', 0, practiceOther.name, 1);
  pokemon('B', 'bench', 0, practiceBasic.name);
  if (options.healingChoice) {
    for (const [id, card] of Object.entries(state.definitions)) if (card.name === practiceBasic.name && card.kind === 'pokemon') state.definitions[id] = { ...card, abilities: [{ name: '定向恢复', text: '自己的回合时可以使用1次。选择自己场上的1只宝可梦，移除1个伤害指示物。' }] };
    state.groups['practice:A:active:0']!.state.damageCounters = 1;
    state.groups['practice:A:bench:4']!.state.damageCounters = 2;
  }
  if (options.attachedEnergy) state.groups['practice:A:active:0']!.attached.push(take('A', practiceEnergy.name).id);
  const extraCards = { number: practiceNumber, order: practiceOrder, coins: practiceCoins };
  const extras = (options.extraHand ?? []).map(kind => extraCards[kind]);
  state.zones['A:hand']!.contents.items = [practiceBasic, practiceEnergy, practiceEnergy, practiceEvolution, practiceSearch, practiceDiscard, practiceSwitch, ...extras].map(card => take('A', card.name));
  state.zones['B:hand']!.contents.items = Array.from({ length: 7 }, () => take('B', practiceEnergy.name));
  for (const seat of ['A', 'B'] as const) state.zones[`${seat}:prizes`]!.contents.items = Array.from({ length: 6 }, () => take(seat, practiceEnergy.name));
  state.flow = { phase: 'turn', turnOwner: 'A', operator: 'A', turnNumber: 1, firstPlayer: 'A', choice: null, handoffReturnTo: null, proposedResult: null, result: null };
  if (options.extraHand?.includes('order')) {
    const knownTop = [practiceOther, practiceEnergy, practiceBasic].map(card => take('A', card.name));
    state.zones['A:deck']!.contents.items.unshift(...knownTop);
  }
  for (const seat of ['A', 'B'] as const) for (const kind of ['active', 'bench'] as const) state.zones[`${seat}:${kind}`]!.defaultVisibility = { mode: 'public' };
  state.setup = { stage: 'done', mulligans: { A: 0, B: 0 }, bonus: { A: 0, B: 0 }, placed: { A: true, B: true }, bonusChosen: { A: true, B: true }, additionalChosen: { A: true, B: true }, failedHands: { A: [], B: [] } };
  // init 是 A 第 1 回合的合成中途状态。后续两次回合抽牌恢复测试起点的原手牌顺序。
  for (const seat of ['A', 'B'] as const) {
    const draw = state.zones[`${seat}:hand`]!.contents.items.pop();
    if (!draw) throw new Error(`合成场景缺少后续抽牌：${seat}`);
    state.zones[`${seat}:deck`]!.contents.items.unshift(draw);
  }
}

/** 由普通命令形成有效历史，公开在场时点不能仅靠 enteredTurn 标记声明。 */
async function advancePracticeHistory(match: MatchRuntime, options: PracticeScenarioOptions): Promise<void> {
  async function execute(command: GameCommand): Promise<void> {
    const receipt = await match.command(match.state.flow.operator, { requestId: crypto.randomUUID(), revision: match.state.revision, command });
    if (receipt.status !== 'committed') throw new Error(`合成场景命令未提交：${command.kind}/${JSON.stringify(receipt)}`);
  }
  const check = () => execute({ kind: 'set_turn', phase: 'check', playerId: null });
  const startTurn = async (playerId: PlayerId) => {
    await execute({ kind: 'set_turn', phase: 'turn', playerId });
    await execute({ kind: 'move', source: { container: { kind: 'zone', zoneId: `${playerId}:deck` }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: `${playerId}:hand` }, index: 'end' } });
  };
  await check(); await startTurn('B'); await check(); await startTurn('A');
  if (options.poisoned) await execute({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'specialConditions', value: ['poisoned'] } });
  if (options.handoff) {
    await check();
    if (options.poisoned) await execute({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 9 } });
    await startTurn('B');
    await execute({ kind: 'declare', text: '使用招式：练习岩团的推击，对练习叶芽造成10点伤害。' });
    await execute({ kind: 'set_state', target: { kind: 'group', position: { zoneId: 'A:active', index: 0 } }, field: { key: 'damageCounters', value: 10 } });
    const active = match.state.groups['practice:A:active:0']!;
    for (const relation of ['stack', 'attached'] as const) if (active[relation].length) {
      await execute({ kind: 'move', source: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation }, range: { mode: 'all' } }, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 'end' } });
    }
    await execute({ kind: 'remove_group', position: { zoneId: 'A:active', index: 0 } });
    await execute({ kind: 'move', source: { container: { kind: 'zone', zoneId: 'B:prizes' }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: 'B:hand' }, index: 'end' } });
    await execute({ kind: 'handoff', to: 'A', reason: '对手的招式使你的战斗宝可梦昏厥。请选择1只备战宝可梦放到战斗场，完成后归还操作权。' });
  }
}

export async function seedHumanScenario(service: GameService, id: string, options: PracticeScenarioOptions = {}): Promise<MatchRuntime> {
  if (service.matches.has(id)) throw new Error(`合成场景已存在：${id}`);
  const directory = join(service.dataDir, 'matches', id), entropy = new ReplayEntropy();
  const state = createGame({ id, players: [{ id: 'A', name: '练习方', kind: 'human', deck: practiceDeck }, { id: 'B', name: '对照方', kind: 'human', deck: practiceDeck }] }, entropy);
  seedTable(state, options);
  if (options.aiSpectator) state.players = state.players.map(player => ({ ...player, kind: 'ai' })) as GameState['players'];
  const model = { ...await service.modelConfig(), model: 'gpt-6.1-terra', reasoningEffort: 'medium' as const, fast: false as const };
  const meta: MatchRecord['meta'] = { createdAt: new Date().toISOString(), rules: service.rulesText(), mode: options.aiSpectator ? 'ai_ai' : 'local', prompts: await service.prompts() as MatchRecord['meta']['prompts'], model, strategies: {}, runtime: { status: 'waiting' }, summaries: {}, dispute: null, tasks: [], bonusCards: { A: [], B: [] }, revoked: {}, randomness: entropy.snapshot() };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'journal.jsonl'), `${JSON.stringify({ kind: 'init', sequence: 0, state, meta } satisfies MatchRecord)}\n`, { flag: 'wx' });
  const match = new MatchRuntime({ directory });
  await match.recover(); match.rulesText = meta.rules;
  await advancePracticeHistory(match, options);
  service.matches.set(id, match);
  return match;
}
