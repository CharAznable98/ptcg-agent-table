import { randomInt } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { Json, MatchPort, Observation, PlayerFrame, ToolDefinition, ToolReceipt, ToolRequest, TraceSink } from '../src/types.ts';

const Position = Type.Object({ zoneId: Type.String(), index: Type.Integer({ minimum: 0 }), member: Type.Optional(Type.Object({ relation: Type.Union([Type.Literal('stack'), Type.Literal('attached')]), index: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })) }, { additionalProperties: false });
const Destination = Type.Object({ zoneId: Type.String(), index: Type.Integer({ minimum: 0 }), relation: Type.Optional(Type.Union([Type.Literal('stack'), Type.Literal('attached')])) }, { additionalProperties: false });
export const TABLE_TOOLS: ToolDefinition[] = [
  { name: 'move', description: 'P01：该测试端口只移动单张卡，不移动整个组。取组内卡必须使用 source.member。序列下标0为顶部；目标 index 表示插入位置。destination.relation 指向现有组附着／叠放；移出成员不自动删除空组。', effect: 'command', inputSchema: Type.Object({ source: Position, destination: Destination }, { additionalProperties: false }) },
  { name: 'set_damage', description: 'P03：设置一个卡牌组的伤害指示物总数，每个单位10点。系统不替你计算招式伤害。', effect: 'command', inputSchema: Type.Object({ position: Position, damageCounters: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }) },
  { name: 'coin', description: 'P06：由服务端投掷一枚硬币并返回正反面。不要在收到结果前假设后续伤害。', effect: 'command', inputSchema: Type.Object({}, { additionalProperties: false }) },
  { name: 'declare', description: 'F01：明确宣告要使用的招式或其他意图；宣告本身不附能、不投币、不造成伤害。', effect: 'command', inputSchema: Type.Object({ text: Type.String({ minLength: 1 }) }, { additionalProperties: false }) },
  { name: 'remove_empty_group', description: 'P08：移除空卡牌组；必须先移出全部 stack 和 attached 卡牌。', effect: 'command', inputSchema: Type.Object({ position: Position }, { additionalProperties: false }) },
  { name: 'report_result', description: 'F04：按当前牌桌依据报告胜利，等待对手确认；不能自动确认或虚报。', effect: 'command', inputSchema: Type.Object({ winner: Type.String(), reason: Type.String() }, { additionalProperties: false }) },
  { name: 'confirm_result', description: 'F04：由被请求的对手确认已有的结果报告；测试片段只涵盖无争议确认。', effect: 'command', inputSchema: Type.Object({ agree: Type.Boolean() }, { additionalProperties: false }) },
];

interface Card { internalId: string; name: string; kind: string; text: string; hp?: number }
interface Group { stack: Card[]; attached: Card[]; damageCounters: number }
type ObjectOnTable = Card | Group;
function isGroup(object: ObjectOnTable | null | undefined): object is Group { return !!object && 'stack' in object; }
function card(id: string, name: string, kind: string, text = '', hp?: number): Card { return { internalId: id, name, kind, text, ...(hp ? { hp } : {}) }; }

/** 验证专用的晚局牌桌片段。只实现本场景所需的一致性操作，不是完整游戏引擎。 */
export class TableFixture implements MatchPort {
  readonly matchId: string;
  readonly trace: TraceSink;
  revision = 0;
  operator = 'A';
  finished = false;
  reported: { winner: string; reason: string } | null = null;
  randomCalls = 0;
  coinResult: 'heads' | 'tails' | null = null;
  injectedStale = false;
  injectedDisconnect = false;
  readonly receipts = new Map<string, { request: string; receipt: ToolReceipt }>();
  readonly journal: { request: ToolRequest; receipt: ToolReceipt }[] = [];
  readonly events: Observation[] = [];
  readonly privateNotes = { A: 'PRIVATE_A_violet_8217', B: 'PRIVATE_B_indigo_6394' };
  readonly zones: Record<string, (ObjectOnTable | null)[]>;
  constructor(matchId: string, trace: TraceSink, readonlyFaults?: { stale?: boolean; disconnectAfterCoin?: boolean }) {
    this.matchId = matchId; this.trace = trace; this.faults = readonlyFaults ?? {};
    this.zones = {
      A_deck: [card('a-draw', '验证能量', 'energy', '提供草能量')],
      A_hand: [card('a-energy', '基本草能量', 'energy', '提供草能量')],
      A_active: [{ stack: [card('a-active', '验证种子（合成测试卡）', 'pokemon', '招式「硬币叶片」：需要1个草能量。投掷一枚硬币，正面造成60点伤害，反面造成20点伤害。', 60)], attached: [], damageCounters: 0 }],
      A_bench: [], A_prizes: [card('a-prize', '验证奖赏', 'energy')], A_discard: [],
      B_deck: [], B_hand: [card('b-hand', '对手隐藏测试牌', 'trainer')],
      B_active: [{ stack: [card('b-active', '验证靶子（合成测试卡）', 'pokemon', '无特殊效果；本次片段已受到40点伤害。', 60)], attached: [], damageCounters: 4 }],
      B_bench: [], B_prizes: [card('b-prize', '隐藏奖赏', 'energy')], B_discard: [],
    };
  }
  readonly faults: { stale?: boolean; disconnectAfterCoin?: boolean };
  #view(value: ObjectOnTable | null): Json {
    if (value === null) return null;
    if (isGroup(value)) return { stack: value.stack.map(c => this.#view(c)), attached: value.attached.map(c => this.#view(c)), damageCounters: value.damageCounters };
    const { internalId: _, ...visible } = value;
    return visible;
  }
  async observe(matchId: string, playerId: string, after: string | null): Promise<PlayerFrame> {
    if (matchId !== this.matchId || !['A', 'B'].includes(playerId)) throw new Error('FIXTURE_SCOPE_INVALID');
    const snapshot: Record<string, Json> = {};
    for (const [id, objects] of Object.entries(this.zones)) {
      const hidden = id.endsWith('_deck') || id.endsWith('_prizes') || (id.endsWith('_hand') && !id.startsWith(playerId + '_'));
      snapshot[id] = objects.map(o => o === null ? null : hidden ? { hidden: true } : this.#view(o));
    }
    snapshot.flow = { turn: 'A的后攻第2回合，已经完成回合最初抽牌', operator: this.operator,
      task: '按卡文继续这一晚局片段，完成招式、昏厥、奖赏和有依据的结果报告／确认。两边均无备战。', reportedResult: this.reported, result: this.finished ? this.reported : null };
    snapshot.ownPrivateNote = this.privateNotes[playerId as 'A' | 'B'];
    const tools = this.reported ? TABLE_TOOLS.filter(t => t.name === 'confirm_result') : TABLE_TOOLS.filter(t => t.name !== 'confirm_result');
    return { matchId, playerId, revision: this.revision, cursor: String(this.events.length), status: this.finished ? 'finished' : this.operator === playerId ? 'active' : 'waiting',
      snapshot, observations: this.events.slice(Number(after ?? '0')), tools };
  }
  #locate(position: { zoneId: string; index: number; member?: { relation: 'stack' | 'attached'; index: number } }): { list: (ObjectOnTable | null)[] | Card[]; index: number } {
    const zone = this.zones[position.zoneId];
    if (!zone || position.index >= zone.length || !zone[position.index]) throw new Error('POSITION_INVALID');
    if (!position.member) return { list: zone, index: position.index };
    const group = zone[position.index];
    if (!isGroup(group) || !group[position.member.relation][position.member.index]) throw new Error('MEMBER_INVALID');
    return { list: group[position.member.relation], index: position.member.index };
  }
  async execute(request: ToolRequest): Promise<ToolReceipt> {
    if (request.matchId !== this.matchId || !['A', 'B'].includes(request.playerId)) throw new Error('FIXTURE_SCOPE_INVALID');
    const encoded = JSON.stringify(request);
    const existing = this.receipts.get(request.requestId);
    if (existing) {
      if (existing.request !== encoded) throw new Error('REQUEST_CONFLICT');
      return existing.receipt;
    }
    if (this.faults.stale && !this.injectedStale) {
      this.injectedStale = true;
      this.revision++;
      this.events.push({ id: `event-${this.revision}`, revision: this.revision, data: { kind: 'validation_interleaving', message: '注入一次并发版本变化，牌桌位置未改变；请重新观察。' } });
    }
    let receipt: ToolReceipt;
    if (request.revision !== this.revision || request.playerId !== this.operator) receipt = { status: 'rejected', revision: this.revision, data: { error: 'STALE_REVISION_OR_PERMISSION', message: '没有执行，请按新快照重新决定' } };
    else {
      try {
        const args = request.arguments as Record<string, Json>;
        let data: Json = { tool: request.tool };
        switch (request.tool) {
          case 'move': {
            const source = args.source as { zoneId: string; index: number; member?: { relation: 'stack' | 'attached'; index: number } };
            const destination = args.destination as { zoneId: string; index: number; relation?: 'stack' | 'attached' };
            const target = this.zones[destination.zoneId];
            if (!target) throw new Error('DESTINATION_INVALID');
            const found = this.#locate(source);
            const object = found.list[found.index];
            if (!object) throw new Error('SOURCE_EMPTY');
            if (isGroup(object)) throw new Error('该测试端口只支持单张卡，请用 member 选择组内卡');
            let list: (ObjectOnTable | null)[] | Card[] = target;
            let index = destination.index;
            if (destination.relation) {
              const group = target[index];
              if (!isGroup(group) || isGroup(object)) throw new Error('ATTACHMENT_INVALID');
              list = group[destination.relation]; index = list.length;
            } else if (index > target.length || ((destination.zoneId.endsWith('_active') || destination.zoneId.endsWith('_prizes')) && target[index])) throw new Error('DESTINATION_OCCUPIED');
            if (found.list === this.zones[source.zoneId] && (source.zoneId.endsWith('_active') || source.zoneId.endsWith('_prizes'))) found.list[found.index] = null;
            else found.list.splice(found.index, 1);
            if (destination.zoneId.endsWith('_active') || destination.zoneId.endsWith('_prizes')) list[index] = object as Card;
            else list.splice(index, 0, object as Card);
            break;
          }
          case 'set_damage': {
            const position = args.position as { zoneId: string; index: number };
            const object = this.zones[position.zoneId]?.[position.index];
            if (!isGroup(object) || !Number.isSafeInteger(args.damageCounters) || Number(args.damageCounters) < 0) throw new Error('DAMAGE_INVALID');
            object.damageCounters = Number(args.damageCounters); break;
          }
          case 'coin': this.randomCalls++; this.coinResult = randomInt(2) ? 'heads' : 'tails'; data = { result: this.coinResult }; break;
          case 'declare': data = { declaration: String(args.text) }; break;
          case 'remove_empty_group': {
            const position = args.position as { zoneId: string; index: number };
            const group = this.zones[position.zoneId]?.[position.index];
            if (!isGroup(group) || group.stack.length || group.attached.length) throw new Error('GROUP_NOT_EMPTY');
            this.zones[position.zoneId]![position.index] = null; break;
          }
          case 'report_result': this.reported = { winner: String(args.winner), reason: String(args.reason) }; this.operator = request.playerId === 'A' ? 'B' : 'A'; data = this.reported; break;
          case 'confirm_result': if (!this.reported || args.agree !== true) throw new Error('RESULT_NOT_CONFIRMED'); this.finished = true; data = this.reported; break;
          default: throw new Error('TOOL_UNKNOWN');
        }
        this.revision++;
        receipt = { status: 'committed', revision: this.revision, data };
        this.events.push({ id: `event-${this.revision}`, revision: this.revision, data: { tool: request.tool, playerId: request.playerId, result: data } });
      } catch (error) { receipt = { status: 'rejected', revision: this.revision, data: { error: error instanceof Error ? error.message : 'INVALID' } }; }
    }
    this.receipts.set(request.requestId, { request: encoded, receipt });
    this.journal.push({ request, receipt });
    await this.trace.append({ kind: 'fixture_command', request, receipt });
    if (this.faults.disconnectAfterCoin && request.tool === 'coin' && receipt.status === 'committed' && !this.injectedDisconnect) {
      this.injectedDisconnect = true;
      throw new Error('SIMULATED_DISCONNECT_AFTER_COMMIT');
    }
    return receipt;
  }
}
