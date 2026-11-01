import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GameService } from '../apps/server/src/service.ts';
import { MatchRuntime, type MatchRecord } from '../apps/server/src/match.ts';
import type { CardData, ObjectRef } from '../packages/protocol/src/index.ts';

/** 隔离 QA 的布局压力快照。复制合成局，不更改模板或用户对局，不作规则验证。 */
export async function seedLayoutPressure(service: GameService, id: string, template: MatchRuntime): Promise<MatchRuntime> {
  if (service.matches.has(id)) return service.matches.get(id)!;
  const state = structuredClone(template.state), meta = structuredClone(template.meta);
  state.id = id; state.revision = 0;
  meta.runtime = { status: 'waiting' }; meta.createdAt = new Date().toISOString();
  const source = state.zones['A:active']!.contents.items[0];
  if (source?.kind !== 'group') throw new Error('布局模板缺少战斗宝可梦');
  const active = state.groups[source.id]!;
  const definition = state.definitions[state.cards[active.stack.at(-1)!]!.definitionId];
  if (definition?.kind !== 'pokemon') throw new Error('布局模板缺少宝可梦卡面');
  definition.name = '合成超长名称的布局压力宝可梦';
  definition.abilities = [{ name: '补给', text: '自己的回合时可以使用1次。从自己的牌库抽1张牌。' }];
  definition.attacks = [
    { name: '轻击', energyCost: [], damageText: '20', text: '' },
    { name: '合成长名称的连环冲击', energyCost: [], damageText: '120+', text: '' },
  ];
  // 取已存在的卡牌构造压力，不复制同一实例到两个区域。
  function take(predicate: (card: CardData) => boolean): ObjectRef {
    const deck = state.zones['A:deck']!.contents.items;
    const index = deck.findIndex(item => item?.kind === 'card' && predicate(state.definitions[state.cards[item.id]!.definitionId]!));
    if (index < 0) throw new Error('布局模板中的合成牌不足');
    return deck.splice(index, 1)[0]!;
  }
  const longName = '合成超长附着卡牌名称与版本识别信息';
  for (let count = 0; count < 2; count++) {
    const energy = take(card => card.kind === 'energy');
    const card = state.cards[energy.id]!;
    const definitionId = `${id}:long-attachment`;
    state.definitions[definitionId] = { kind: 'energy', subtype: 'special', name: longName, text: '非官方合成布局测试。' };
    card.definitionId = definitionId; active.attached.push(energy.id);
  }
  active.state.specialConditions = ['poisoned', 'burned', 'confused'];
  active.state.damageCounters = 3;
  const bench = state.zones['A:bench']!.contents.items;
  for (let index = 0; index < bench.length; index++) if (!bench[index]) {
    const card = take(card => card.kind === 'pokemon' && card.stage === '基础');
    const groupId = `${id}:bench:${index}`;
    state.groups[groupId] = { id: groupId, stack: [card.id], attached: [], state: { damageCounters: index, specialConditions: [], markers: {} } };
    bench[index] = { kind: 'group', id: groupId };
  }
  const directory = join(service.dataDir, 'matches', id);
  await mkdir(directory, { recursive: true });
  const initial: MatchRecord = { kind: 'init', sequence: 0, state, meta };
  await writeFile(join(directory, 'journal.jsonl'), `${JSON.stringify(initial)}\n`, { flag: 'wx' });
  const match = new MatchRuntime({ directory });
  await match.recover(); match.rulesText = meta.rules;
  service.matches.set(id, match);
  return match;
}
