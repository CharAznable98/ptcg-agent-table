import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Type, type TSchema } from '@sinclair/typebox';
import { createGame, executeCore, projectTable, resolveSelection, findCardPosition } from '../../../packages/game-core/src/index.ts';
import { GameCommandSchema, CommandEnvelopeSchema, MoveKnownInputSchema, ShowKnownInputSchema, type MoveKnownInput, type ShowKnownInput } from '../../../packages/protocol/src/index.ts';
import type { Actor, CardData, CommandEnvelope, CommandReceipt, CoreCommand, CoreResult, DisputeView, Entropy, GameCommand, GameFlow, GameState, Json, MatchMode, MatchSummary, MatchView, PlayerId, PlayerSpec, Position, PromptConfig, Proposal, PublicEvent, RuntimeStatus, Selection, SetupProgress, Viewer, TableView, CardView, GroupView } from '../../../packages/protocol/src/index.ts';
import { validationError, type JudgeDecision } from '../../../packages/agent/src/schema.ts';
import type { MatchPort, StrategySnapshot, PlayerFrame, ToolDefinition, ToolReceipt, ToolRequest } from '../../../packages/agent/src/types.ts';
import type { PromptBundle } from '../../../packages/agent/src/prompts.ts';
import type { ModelConfig } from '../../../packages/agent/src/config.ts';
import { ApiError, canonical, clone, Journal, now, uid } from './storage.ts';
import { publicInPlayFacts, type InPlayFact } from './in-play-facts.ts';
import { ReplayEntropy, type RandomState } from './entropy.ts';
import { cardContext } from '../../../packages/agent/src/card-context.ts';
import { humanActionRecoveryPoints } from './human-action-recovery.ts';

const players: PlayerId[] = ['A', 'B'];
const other = (id: PlayerId): PlayerId => id === 'A' ? 'B' : 'A';
export const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
export const selection = (zoneId: string, start = 0, count?: number): Selection => ({ container: { kind: 'zone', zoneId }, range: count === undefined ? { mode: 'all' } : { mode: 'range', start, count } });
const dest = (zoneId: string, index = 0) => ({ container: { kind: 'zone' as const, zoneId }, index });
const system: Actor = { kind: 'system', purpose: 'setup' };
const isBasic = (card: CardData): boolean => card.kind === 'pokemon' && card.stage === '基础';
function cardIdentity(state: GameState, position: Position): string | null {
  const item = state.zones[position.zoneId]?.contents.items[position.index];
  if (!item) return null;
  if (item.kind === 'card') return item.id;
  if (!position.member) return item.id;
  return state.groups[item.id]?.[position.member.relation][position.member.index] ?? null;
}
function visibleCardIds(state: GameState, player: PlayerId): Set<string> {
  const result = new Set<string>();
  const claim = (card: CardView) => { const id = cardIdentity(state, card.position); if (id) result.add(id); };
  for (const zone of projectTable(state, player).zones) for (const object of zone.items) {
    if (object?.kind === 'card') claim(object);
    if (object?.kind === 'group') for (const card of [...object.stack, ...object.attached]) if (card.kind === 'card') claim(card);
  }
  return result;
}
const basicAt = (state: GameState, position: Position, player: PlayerId): string => {
  if (position.zoneId !== `${player}:hand` || position.member) throw new ApiError('INVALID_PLACEMENT', '只能选择本人手牌中的基础宝可梦');
  const object = state.zones[position.zoneId]?.contents.items[position.index];
  if (!object || object.kind !== 'card' || !isBasic(state.definitions[state.cards[object.id]!.definitionId]!)) throw new ApiError('INVALID_PLACEMENT', '所选位置不是基础宝可梦');
  return object.id;
};
type JudgeEndResult = Extract<JudgeDecision['steps'][number], { kind: 'end_match' }>['result'];
interface Task { id: string; command?: CoreCommand; moveCard?: { cardId: string; zoneId: string; index: number; group?: boolean }; revealCard?: string; restoreBefore?: string; endResult?: JudgeEndResult; closeDispute?: boolean }
export interface MatchMeta {
  randomness?: RandomState;
  evaluation?: { id: string; phase: 'baseline' | 'comparison' };
  createdAt: string; rules: string; mode: MatchMode; prompts: PromptBundle; model: ModelConfig;
  strategies: Partial<Record<PlayerId, StrategySnapshot>>;
  runtime: RuntimeStatus; summaries: MatchView['summaries']; dispute: DisputeView | null;
  tasks: Task[]; bonusCards: Record<PlayerId, string[]>; restoredSetupTasks?: Task[]; revoked: Record<string, string>; judgeReason?: { reason: string; evidenceRefs: string[] };
}
interface BaseRecord { state: GameState; meta: MatchMeta }
export interface MatchRecord extends BaseRecord {
  kind: 'init' | 'commit' | 'outcome' | 'runtime'; sequence: number;
  actor?: Actor; request?: { requestId: string; revision: number; command: CoreCommand | { kind: string } }; fingerprint?: string;
  receipt?: CommandReceipt; event?: Record<Viewer, PublicEvent>;
}
export interface MatchOptions { directory: string; entropy?: Entropy }
export class MatchRuntime implements MatchPort {
  readonly directory: string; readonly journal: Journal<MatchRecord>; entropy: Entropy;
  readonly changes = new EventEmitter(); records: MatchRecord[] = []; state!: GameState; meta!: MatchMeta;
  /** 人类执行代理独占该席位的写入；AI 临时接权仍按原流程运行。 */
  readonly humanActionLocks = new Map<PlayerId, { id: string; playerId: PlayerId; label: string; mode?: 'manual' }>();
  get humanActionLock(): { id: string; playerId: PlayerId; label: string } | null { return this.humanActionLocks.get(this.state.flow.operator) ?? this.humanActionLocks.values().next().value ?? null; }
  lockHumanAction(action: { id: string; playerId: PlayerId; label: string; mode?: 'manual' }): void { this.humanActionLocks.set(action.playerId, action); }
  unlockHumanAction(playerId: PlayerId, actionId: string): void { if (this.humanActionLocks.get(playerId)?.id === actionId) this.humanActionLocks.delete(playerId); }
  #eventAction: { id: string; label: string } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #storageFaulted = false;
  #factCache = new Map<string, InPlayFact[]>();
  get storageFaulted(): boolean { return this.#storageFaulted; }
  #writable(): void { if (this.#storageFaulted) throw new ApiError('STORAGE_UNCERTAIN', '本局日志提交状态不确定，已停止后续写入；请重启恢复', 503); }
  constructor(options: MatchOptions) { this.directory = options.directory; this.journal = new Journal(join(options.directory, 'journal.jsonl')); this.entropy = options.entropy ?? new ReplayEntropy(); }
  async create(input: { id: string; players: [PlayerSpec, PlayerSpec]; mode: MatchMode; prompts: PromptBundle; model: ModelConfig; strategies: MatchMeta['strategies']; rules: string; evaluation?: NonNullable<MatchMeta['evaluation']> }): Promise<void> {
    this.state = createGame({ id: input.id, players: input.players }, this.entropy);
    this.meta = { createdAt: now(), rules: input.rules, mode: input.mode, prompts: clone(input.prompts), model: clone(input.model), strategies: input.strategies, runtime: { status: 'idle' }, summaries: {}, dispute: null, tasks: [], bonusCards: { A: [], B: [] }, revoked: {} };
    if (input.evaluation) this.meta.evaluation = clone(input.evaluation);
    await this.#append({ kind: 'init', sequence: 0, state: this.state, meta: this.meta });
    await this.#startSetup();
  }
  /** 复用开始前的牌序及随机流，隐藏配置仅存在服务端原件。 */
  async createFromScenario(id: string, initial: Pick<MatchRecord, 'state' | 'meta'>): Promise<void> {
    if (!initial.meta.randomness) throw new Error('SCENARIO_RANDOMNESS_MISSING');
    this.entropy = new ReplayEntropy(initial.meta.randomness);
    this.state = { ...clone(initial.state), id };
    this.meta = { ...clone(initial.meta), createdAt: now(), runtime: { status: 'idle' }, summaries: {} };
    await this.#append({ kind: 'init', sequence: 0, state: this.state, meta: this.meta });
    await this.#startSetup();
  }
  async #startSetup(): Promise<void> {
    const id = this.state.id;
    await this.serial(async () => {
      await this.#protocol(system, { requestId: `setup:${id}:coin-mapping`, revision: this.state.revision, command: { kind: 'setup_coin_mapping' } }, () => {}, { heads: 'A', tails: 'B' });
      const coin = await this.#core({ kind: 'random', mode: 'coins', count: 1 }, system, `setup:${id}:coin`);
      const result = coin as unknown as { coins?: string[]; results?: string[]; heads?: number };
      const face = result.coins?.[0] ?? result.results?.[0];
      const chooser: PlayerId = face === 'heads' || face === '正面' || result.heads === 1 ? 'A' : 'B';
      await this.#progress({ ...this.state.flow, operator: chooser, choice: { kind: 'choose_first', playerId: chooser, message: '固定映射：正面 A、反面 B；选择先攻玩家。' } }, { ...this.state.setup, stage: 'first' });
    });
  }
  async recover(): Promise<void> {
    this.#factCache.clear();
    this.records = (await this.journal.read()).map(record => {
      // 旧记录只在内存移除已废弃字段，磁盘原件保持不变。
      const { access: _legacyAccess, ...meta } = record.meta as MatchMeta & { access?: unknown };
      return { ...record, meta };
    }); this.#storageFaulted = false;
    const last = this.records.at(-1); if (!last) throw new ApiError('NOT_FOUND', '对局不存在', 404);
    this.state = clone(last.state); this.meta = clone(last.meta);
    if (this.meta.randomness) this.entropy = new ReplayEntropy(this.meta.randomness);
    if (this.meta.runtime.status === 'running') { this.meta.runtime = { status: 'paused', error: '服务重启，按继续恢复已保存上下文' }; await this.saveRuntime(); }
    await this.serial(() => this.#pump());
  }
  serial<T>(task: () => Promise<T>): Promise<T> { const next = this.#queue.then(() => { this.#writable(); return task(); }); this.#queue = next.catch(() => {}); return next; }
  async #append(record: MatchRecord): Promise<void> { this.#writable(); if (this.entropy instanceof ReplayEntropy) record.meta = { ...record.meta, randomness: this.entropy.snapshot() }; try { await this.journal.append(record); } catch { this.#storageFaulted = true; throw new ApiError('STORAGE_UNCERTAIN', '本局日志提交状态不确定，已停止后续写入；请重启恢复', 503); } this.records.push(clone(record)); this.state = clone(record.state); this.meta = clone(record.meta); this.changes.emit('change'); }
  summary(): MatchSummary { return { id: this.state.id, createdAt: this.meta.createdAt, mode: this.meta.mode, players: this.state.players.map(p => ({ id: p.id, name: p.name, kind: p.kind })), phase: this.state.flow.phase, result: clone(this.state.flow.result), runtime: clone(this.meta.runtime), revision: this.state.revision }; }
  defaultViewer(): Viewer { return this.meta.mode === 'ai_ai' ? 'omniscient' : this.state.players.find(player => player.kind === 'human')!.id; }
  assertViewer(viewer: Viewer, replay = false): void {
    if (this.meta.mode === 'ai_ai' || (replay && this.state.flow.phase === 'finished') || this.state.players.some(player => player.id === viewer && player.kind === 'human')) return;
    throw new ApiError('HIDDEN_INFORMATION', '当前对局不开放此视角', 403);
  }
  humanPlayer(playerId: unknown): PlayerId {
    if (playerId !== 'A' && playerId !== 'B') throw new ApiError('INVALID_PLAYER', '请指定有效的操作席位');
    if (this.state.players.find(player => player.id === playerId)?.kind !== 'human') throw new ApiError('AI_PLAYER', 'AI 席位由后端操作', 403);
    return playerId;
  }
  history(viewer: Viewer, after = '0', limit = 1000): { entries: PublicEvent[]; cursor: string } {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ApiError('INVALID_LIMIT', '历史条数必须是正整数');
    const offset = Number(after); if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError('INVALID_CURSOR', '无效游标');
    const entries = this.records.filter(r => r.event && r.sequence > offset).slice(0, Math.max(1, Math.min(limit, 2000))).map(r => {
      const event = clone(r.event![viewer]); const revokedBy = this.meta.revoked[event.id]; if (revokedBy) event.revokedBy = revokedBy; return event;
    });
    return { entries, cursor: String(entries.at(-1)?.sequence ?? Math.max(offset, this.records.at(-1)?.sequence ?? 0)) };
  }
  view(viewer: Viewer, index?: number): MatchView {
    const events = this.records.filter(r => r.event);
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index > events.length)) throw new ApiError('INVALID_REPLAY_INDEX', '回放位置越界');
    const historical = index === undefined ? null : index === 0 ? this.records[0]! : events[index - 1]!;
    const state = historical?.state ?? this.state;
    const meta = historical?.meta ?? this.meta;
    const subset = historical ? this.records.filter(r => r.sequence <= historical.sequence) : this.records;
    return { ...(this.meta.evaluation ? { evaluation: clone(this.meta.evaluation) } : {}), ...projectTable(state, viewer), mode: this.meta.mode, events: subset.filter(r => r.event).map(r => { const event = clone(r.event![viewer]); const revoked = meta.revoked[event.id]; if (revoked) event.revokedBy = revoked; return event; }), cursor: String(subset.at(-1)?.sequence ?? 0), dispute: clone(meta.dispute), runtime: clone(meta.runtime), summaries: clone(meta.summaries), ...(index === undefined ? {} : { replay: { index, total: events.length } }) };
  }
  async saveRuntime(): Promise<void> { await this.#append({ kind: 'runtime', sequence: this.records.length, state: this.state, meta: this.meta }); }
  async updateRuntime(runtime: RuntimeStatus): Promise<void> { await this.serial(async () => { this.meta.runtime = runtime; await this.saveRuntime(); }); }
  #eventId(): string { return this.entropy.uuid(); }
  #receiptResult(result: CoreResult, actor: Actor): Json {
    const reveals = result.reveals.filter(reveal => actor.kind === 'player' && reveal.recipients.includes(actor.playerId));
    return asJson({ ...((result.result !== null && typeof result.result === 'object' && !Array.isArray(result.result)) ? result.result : { value: result.result }), ...(reveals.length ? { reveals } : {}) });
  }
  async #commit(state: GameState, meta: MatchMeta, actor: Actor, request: MatchRecord['request'], result: Json, reveals: CoreResult['reveals'] = [], label?: string, fixedEventId?: string): Promise<CommandReceipt> {
    const eventId = fixedEventId ?? this.#eventId(); const sequence = this.records.length; const at = now();
    const event = {} as Record<Viewer, PublicEvent>;
    for (const viewer of [...players, 'omniscient'] as Viewer[]) {
      const visible = reveals.filter(r => viewer === 'omniscient' || r.recipients.includes(viewer));
      const table = projectTable(state, viewer), beforeTable = projectTable(this.state, viewer);
      const observed = this.#observed(table, beforeTable, state, this.state);
      event[viewer] = { id: eventId, sequence, revision: state.revision, at, actor: actor.kind === 'player' ? actor.playerId : 'system', commandKind: request!.command.kind, label: label ?? request!.command.kind, ...(this.#eventAction ? { action: clone(this.#eventAction) } : {}), data: asJson({ command: request!.command.kind.startsWith('system_') ? { kind: request!.command.kind } : request!.command, result, ...(visible.length ? { reveals: visible } : {}), ...observed, flow: table.flow, table }) };
    }
    const ownReveals = reveals.filter(reveal => actor.kind === 'player' && reveal.recipients.includes(actor.playerId));
    const receiptResult = ownReveals.length ? asJson({ result, reveals: ownReveals }) : result;
    const receipt: CommandReceipt = { status: 'committed', eventId, revision: state.revision, result: receiptResult };
    await this.#append({ kind: 'commit', sequence, actor, request: request!, fingerprint: canonical({ actor, request }), receipt, event, state, meta });
    return clone(receipt);
  }
  #observed(table: TableView, before: TableView, state: GameState, oldState: GameState): { observedCards: Json[]; observedGroups: Json[] } {
    const flatten = (view: TableView): { cards: CardView[]; groups: GroupView[] } => {
      const cards: CardView[] = [], groups: GroupView[] = [];
      for (const zone of view.zones) for (const item of zone.items) {
        if (item?.kind === 'card') cards.push(item);
        if (item?.kind === 'group') { groups.push(item); for (const card of [...item.stack,...item.attached]) if (card.kind === 'card') cards.push(card); }
      }
      return { cards, groups };
    };
    const current = flatten(table), previous = flatten(before);
    const oldCards = new Map(previous.cards.map(card => [canonical(card.position),card]));
    const oldGroups = new Map(previous.groups.map(group => [canonical(group.position),group]));
    return {
      observedCards: current.cards.filter(card => canonical(oldCards.get(canonical(card.position)) ?? null) !== canonical(card) || cardIdentity(state,card.position) !== cardIdentity(oldState,card.position)).map(card => asJson(card)),
      observedGroups: current.groups.filter(group => canonical(oldGroups.get(canonical(group.position))?.state ?? null) !== canonical(group.state) || cardIdentity(state,group.position) !== cardIdentity(oldState,group.position)).map(group => asJson({ position: group.position, state: group.state })),
    };
  }
  compactHistory(viewer: PlayerId, after = '0', limit = 1000): { entries: PublicEvent[]; cursor: string } {
    const history = this.history(viewer, after, limit);
    return { ...history, entries: history.entries.map(event => {
      const data = event.data as Record<string, Json>;
      const { table: _table, ...compact } = data;
      if (!Object.hasOwn(compact,'observedCards')) {
        const index = this.records.findIndex(record => record.event?.A.id === event.id);
        const record = this.records[index]!, previous = this.records[Math.max(0,index-1)]!;
        Object.assign(compact,this.#observed(projectTable(record.state,viewer),projectTable(previous.state,viewer),record.state,previous.state),{ flow: projectTable(record.state,viewer).flow });
      }
      return { ...event, data: asJson(compact) };
    }) };
  }
  /** 玩家按需读取使用小页；观察增量仍由 compactHistory 完整投递。 */
  readHistory(viewer: PlayerId, args: { after?: string; before?: string; limit?: number }) {
    if (args.after !== undefined && args.before !== undefined) throw new ApiError('INVALID_CURSOR', 'after 与 before 只能选择一个');
    const bound = Number(args.after ?? args.before ?? 0), limit = args.limit ?? 50;
    if (!Number.isSafeInteger(bound) || bound < 0) throw new ApiError('INVALID_CURSOR', '无效游标');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApiError('INVALID_LIMIT', '历史条数须为1到200');
    const all = this.records.filter(record => record.event);
    const forward = args.after !== undefined;
    const candidates = all.filter(record => forward ? record.sequence > bound : args.before === undefined || record.sequence < bound);
    if (!forward) candidates.reverse();
    let entries: PublicEvent[] = [];
    const result = (items: PublicEvent[], oversizedEntry = false) => ({
      entries: items,
      cursor: String(items.at(-1)?.sequence ?? (forward ? bound : this.records.at(-1)?.sequence ?? 0)),
      previousCursor: String(items[0]?.sequence ?? bound),
      hasMore: all.some(record => record.sequence > (items.at(-1)?.sequence ?? bound)),
      hasPrevious: all.some(record => record.sequence < (items[0]?.sequence ?? bound)),
      direction: forward ? 'forward' : 'recent', maxBytes: 24_000, oversizedEntry,
    });
    for (const record of candidates.slice(0, limit)) {
      const event = this.compactHistory(viewer, String(record.sequence - 1), 1).entries[0]!;
      const next = forward ? [...entries, event] : [event, ...entries];
      if (Buffer.byteLength(JSON.stringify(result(next))) > 24_000) {
        // 不切断单条事件；异常大条明确标记，运行模块保护其首次完整投递。
        if (!entries.length) return result(next, true);
        break;
      }
      entries = next;
    }
    return result(entries);
  }
  async #outcome(actor: Actor, request: NonNullable<MatchRecord['request']>, receipt: CommandReceipt): Promise<CommandReceipt> {
    await this.#append({ kind: 'outcome', sequence: this.records.length, actor, request, fingerprint: canonical({ actor, request }), receipt, state: this.state, meta: this.meta }); return clone(receipt);
  }
  async #core(command: CoreCommand, actor: Actor, requestId = uid(), revision = this.state.revision, mutate?: (meta: MatchMeta) => void): Promise<Json> {
    const request = { requestId, revision, command };
    const result = executeCore(this.state, command, actor, this.entropy);
    const meta = clone(this.meta); mutate?.(meta);
    if (!result.changed) { await this.#outcome(actor, request, { status: 'not_executed', revision: this.state.revision, reason: '操作未改变状态' }); return result.result; }
    await this.#commit(result.state, meta, actor, request, result.result, result.reveals);
    return result.result;
  }
  async #progress(flow = this.state.flow, setup = this.state.setup): Promise<void> { await this.#core({ kind: 'system_progress', flow, setup }, system); }
  #basics(id: PlayerId): Position[] { return this.state.zones[`${id}:hand`]!.contents.items.flatMap((object, index) => object?.kind === 'card' && isBasic(this.state.definitions[this.state.cards[object.id]!.definitionId]!) ? [{ zoneId: `${id}:hand`, index }] : []); }
  #task(command: CoreCommand): Task { return { id: uid(), command }; }
  #progressTask(flow: GameFlow, setup: SetupProgress): Task { return this.#task({ kind: 'system_progress', flow, setup }); }
  #moveAll(from: string, to: string, count?: number): Task { return this.#task({ kind: 'move', source: selection(from, 0, count), destination: dest(to) }); }
  async #protocol(actor: Actor, request: NonNullable<MatchRecord['request']>, mutate: (state: GameState, meta: MatchMeta) => void, result: Json = {}): Promise<CommandReceipt> {
    const state = clone(this.state), meta = clone(this.meta); mutate(state, meta); state.revision++;
    return this.#commit(state, meta, actor, request, result);
  }
  #placeTasks(id: PlayerId, cardIds: string[], initial: boolean, benchSlots?: number[]): Task[] {
    const tasks: Task[] = [];
    const free = this.state.zones[`${id}:bench`]!.contents.items.flatMap((item, index) => item ? [] : [index]);
    for (let i = 0; i < cardIds.length; i++) {
      const zoneId = initial && i === 0 ? `${id}:active` : `${id}:bench`;
      const index = initial && i === 0 ? 0 : (benchSlots ?? free)[initial ? i - 1 : i]!;
      tasks.push(this.#task({ kind: 'create_group', destination: dest(zoneId, index) }));
      tasks.push({ id: uid(), moveCard: { cardId: cardIds[i]!, zoneId, index, group: true } });
    }
    if (initial) tasks.push(this.#moveAll(`${id}:deck`, `${id}:prizes`, 6));
    const setup = clone(this.state.setup);
    if (initial) setup.placed[id] = true; else setup.additionalChosen[id] = true;
    tasks.push(this.#progressTask({ ...this.state.flow, choice: null }, setup));
    return tasks;
  }
  #validateProposal(proposal: Proposal): void {
    let candidate = this.state;
    if (proposal.restoreBeforeEventId) candidate = this.#before(proposal.restoreBeforeEventId).state;
    if (proposal.shuffles.length > 32) throw new ApiError('INVALID_PLAN', '处置步骤过多');
    for (const item of proposal.shuffles) resolveSelection(candidate, item);
  }
  #before(eventId: string): BaseRecord {
    const index = this.records.findIndex(r => r.event?.A.id === eventId);
    if (index < 1 || this.meta.revoked[eventId]) throw new ApiError('INVALID_RESTORE_TARGET', '恢复点不在当前有效历史中');
    return this.records[index - 1]!;
  }
  #plan(proposal: Proposal): Task[] {
    this.#validateProposal(proposal);
    return [...(proposal.restoreBeforeEventId ? [{ id: uid(), restoreBefore: proposal.restoreBeforeEventId }] : []), ...proposal.shuffles.map(item => this.#task({ kind: 'shuffle', selection: item })), { id: uid(), closeDispute: true }];
  }
  async command(actor: PlayerId, input: CommandEnvelope, action?: { id: string; label: string }): Promise<CommandReceipt> {
    return this.serial(async () => {
      const lock = this.humanActionLocks.get(actor);
      const manual = lock?.mode === 'manual' && !action;
      if (manual && !['move', 'create_group', 'remove_group', 'set_state', 'look', 'show', 'shuffle', 'declare', 'concede'].includes(input.command.kind))
        throw new ApiError('HUMAN_SETTLEMENT_REQUIRED', '手动修正仅允许调整当前结算；完成后请让代理核对，不能直接推进回合或交权', 409);
      if (lock && this.state.players.find(player => player.id === actor)?.kind === 'human' && action?.id !== lock.id && !manual && input.command.kind !== 'concede')
        throw new ApiError('HUMAN_ACTION_IN_PROGRESS', '请先完成当前结算或让代理修正', 409);
      if (action && (lock?.id !== action.id || lock.playerId !== actor)) throw new ApiError('HUMAN_ACTION_SCOPE', '行动与当前操作席位不匹配', 409);
      this.#eventAction = action ?? (manual && input.command.kind !== 'concede' ? { id: lock.id, label: lock.label } : null);
      try { return await this.#commandHeld(actor,input); }
      finally { this.#eventAction = null; }
    });
  }
  /** 执行代理仅能恢复当前行动的有效因果结算，成功与拒绝均按原请求 ID 收敛。 */
  async restoreHumanAction(actor: PlayerId, input: { requestId: string; revision: number; beforeEventId: string; reason: string }, action: { id: string; label: string }): Promise<CommandReceipt> {
    return this.serial(async () => {
      this.humanPlayer(actor);
      const lock = this.humanActionLocks.get(actor);
      if (!lock || lock.id !== action.id || lock.playerId !== actor) throw new ApiError('HUMAN_ACTION_SCOPE', '恢复请求与当前人类行动不匹配', 409);
      if (!input.requestId?.trim() || !input.beforeEventId?.trim() || !input.reason?.trim() || input.reason.length > 1000 || !Number.isSafeInteger(input.revision) || input.revision < 0)
        throw new ApiError('INVALID_ACTION_RESTORE', '恢复请求需要有效请求标识、版本、恢复点和原因');
      const bound: Actor = { kind: 'player', playerId: actor };
      const recovery = { action: clone(action), beforeEventId: input.beforeEventId, reason: input.reason };
      const previous = this.records.find(record => record.request?.requestId === input.requestId);
      if (previous) {
        const command = previous.request!.command;
        const request = { requestId: input.requestId, revision: input.revision, command: { ...command, recovery } };
        if (command.kind !== 'system_restore' || previous.fingerprint !== canonical({ actor: bound, request })) throw new ApiError('REQUEST_ID_CONFLICT', '该请求标识已被不同请求使用', 409);
        const receipt = clone(previous.receipt!);
        if (receipt.status === 'committed' && this.meta.revoked[receipt.eventId]) receipt.revokedBy = this.meta.revoked[receipt.eventId]!;
        return receipt;
      }
      const index = this.records.findIndex(record => record.event?.A.id === input.beforeEventId);
      const before = index > 0 ? this.records[index - 1]! : null;
      const command = { kind: 'system_restore' as const, state: before?.state ?? this.state, recovery };
      const request = { requestId: input.requestId, revision: input.revision, command };
      if (input.revision !== this.state.revision) return this.#outcome(bound, request, { status: 'rejected', revision: this.state.revision, error: { code: 'REVISION_CONFLICT', message: '牌桌版本已变化，请读取最新观察' } });
      if (!humanActionRecoveryPoints(this, actor, action.id).some(point => point.eventId === input.beforeEventId))
        return this.#outcome(bound, request, { status: 'rejected', revision: this.state.revision, error: { code: 'RECOVERY_SCOPE_CONFLICT', message: '恢复点不属于当前行动的有效结算，或其后已有独立操作、异议或待定流程' } });
      const eventId = this.#eventId(), meta = clone(this.meta), target = this.records[index]!;
      const revokedEvents = this.records.flatMap(record => record.event && record.sequence >= target.sequence && !meta.revoked[record.event.A.id] ? [record.event.A.id] : []);
      for (const id of revokedEvents) meta.revoked[id] = eventId;
      const computed = executeCore(this.state, command, { kind: 'system', purpose: 'disposition' }, this.entropy);
      this.#eventAction = action;
      try {
        return await this.#commit(computed.state, meta, bound, request, asJson({ restoredBefore: input.beforeEventId, revokedEvents, reason: input.reason }), [], '代理修正 · 恢复牌桌与流程', eventId);
      } finally { this.#eventAction = null; }
    });
  }
  async #commandHeld(actor: PlayerId, input: CommandEnvelope): Promise<CommandReceipt> {
    const malformed = validationError(CommandEnvelopeSchema, input); if (malformed) throw new ApiError('INVALID_COMMAND', malformed);
      const bound: Actor = { kind: 'player', playerId: actor }; const request = clone(input);
      // 身份先于缓存读取；跨席位相同 ID 不返回原始私有反馈。
      const previous = this.records.find(r => r.request?.requestId === input.requestId);
      if (previous) {
        if (previous.fingerprint !== canonical({ actor: bound, request })) throw new ApiError('REQUEST_ID_CONFLICT', '该请求标识已被不同请求使用', 409);
        const receipt = clone(previous.receipt!); if (receipt.status === 'committed' && this.meta.revoked[receipt.eventId]) receipt.revokedBy = this.meta.revoked[receipt.eventId]!; return receipt;
      }
      if (input.revision !== this.state.revision) return this.#outcome(bound, request, { status: 'rejected', revision: this.state.revision, error: { code: 'REVISION_CONFLICT', message: '牌桌版本已变化，请读取最新观察' } });
      let receipt: CommandReceipt;
      try {
        const command = input.command;
        if (this.state.flow.phase === 'finished') throw new ApiError('MATCH_FINISHED', '对局已结束');
        if (this.meta.tasks.length && command.kind !== 'concede') throw new ApiError('SYSTEM_PROGRESS_PENDING', '已保存的自动步骤尚未完成，请先恢复运行');
        if (this.state.flow.phase === 'setup' && this.state.flow.choice && ![this.state.flow.choice.kind, 'object', 'concede', 'respond'].includes(command.kind)) throw new ApiError('SETUP_CHOICE_PENDING', '请先完成当前准备选择');
        if (command.kind !== 'concede' && command.kind !== 'respond' && this.meta.dispute && this.meta.dispute.status !== 'closed') throw new ApiError('DISPUTE_PENDING', '异议处理期间暂停普通操作');
        if (command.kind === 'object') {
          if (this.state.flow.operator !== actor && !(this.state.flow.phase === 'result_pending' && this.state.flow.choice?.playerId === actor)) throw new ApiError('NOT_OPERATOR', '当前没有操作权');
          const target = this.records.find(r => r.event?.A.id === command.targetEventId);
          if (!target?.request || !['move','shuffle','set_state','look','show','random','create_group','remove_group','declare','set_turn','handoff','report_result'].includes(target.request.command.kind)) throw new ApiError('INVALID_DISPUTE_TARGET', '该事件不可作为异议目标');
          if (command.evidenceRefs.some(ref => !this.records.some(record => record.event?.A.id === ref))) throw new ApiError('EVIDENCE_OUT_OF_SCOPE', '证据引用不存在');
          const proposal = command.proposal ?? { restoreBeforeEventId: command.targetEventId, shuffles: [] }; this.#validateProposal(proposal);
          receipt = await this.#protocol(bound, request, (_state, meta) => { meta.dispute = { id: uid(), targetEventId: command.targetEventId, raisedBy: actor, respondent: target.actor?.kind === 'player' ? target.actor.playerId : other(actor), reason: command.reason, proposalId: uid(), proposal, status: 'awaiting_response' }; if (meta.dispute.respondent === actor) meta.dispute.respondent = other(actor); });
        } else if (command.kind === 'respond') {
          const dispute = this.meta.dispute; const response = command.response;
          if (!dispute || dispute.status !== 'awaiting_response' || dispute.respondent !== actor || response.disputeId !== dispute.id) throw new ApiError('INVALID_RESPONSE', '当前没有该席位待回应的异议');
          if (response.kind === 'accept') {
            if (response.proposalId !== dispute.proposalId) throw new ApiError('PROPOSAL_CONFLICT', '认可的处置提议不匹配');
            const tasks = this.#plan(dispute.proposal);
            receipt = await this.#protocol(bound, request, (_state, meta) => { meta.dispute!.status = 'applying'; meta.tasks = tasks; });
          } else { if (response.evidenceRefs.some(ref => !this.records.some(record => record.event?.A.id === ref))) throw new ApiError('EVIDENCE_OUT_OF_SCOPE', '证据引用不存在'); receipt = await this.#protocol(bound, request, (_state, meta) => { meta.dispute!.status = 'awaiting_judge'; meta.judgeReason = { reason: response.reason, evidenceRefs: response.evidenceRefs }; }); }
        } else if (['choose_first','initial_placement','mulligan_draw','additional_bench'].includes(command.kind)) {
          const choice = this.state.flow.choice;
          if (!choice || choice.playerId !== actor || choice.kind !== command.kind) throw new ApiError('INVALID_CHOICE', '当前未请求该准备决策');
          if (command.kind === 'choose_first') {
            const flow = { ...this.state.flow, firstPlayer: command.firstPlayer, choice: null };
            const setup = { ...this.state.setup, stage: 'placement' as const };
            const tasks = players.flatMap(id => [this.#task({ kind: 'shuffle', selection: selection(`${id}:deck`) }), this.#moveAll(`${id}:deck`, `${id}:hand`, 7)]);
            tasks.push(this.#progressTask(flow, setup));
            receipt = await this.#protocol(bound, request, (_state, meta) => { meta.tasks = tasks; });
          } else if (command.kind === 'initial_placement' || command.kind === 'additional_bench') {
            const initial = command.kind === 'initial_placement';
            const positions = initial ? [command.active, ...command.bench] : command.bench;
            if (command.bench.length > (initial ? 5 : this.state.zones[`${actor}:bench`]!.contents.items.filter(item => !item).length)) throw new ApiError('BENCH_FULL', '备战选择超出可用空间');
            if (command.benchSlots && (command.benchSlots.length !== command.bench.length || command.benchSlots.some(slot => this.state.zones[`${actor}:bench`]!.contents.items[slot] !== null))) throw new ApiError('INVALID_BENCH_SLOT', '备战落点必须与选牌一一对应且为空位');
            const ids = positions.map(position => basicAt(this.state, position, actor));
            if (!initial && ids.some(id => !this.meta.bonusCards[actor].includes(id))) throw new ApiError('INVALID_ADDITIONAL_BENCH', '追加备战只能选择本次补抽所得基础宝可梦');
            if (new Set(ids).size !== ids.length) throw new ApiError('DUPLICATE_SELECTION', '准备选择不得重复');
            const tasks = this.#placeTasks(actor, ids, initial, command.benchSlots);
            receipt = await this.#protocol(bound, request, (_state, meta) => { meta.tasks = tasks; });
          } else if (command.kind === 'mulligan_draw') {
            if (command.count > (choice.maximum ?? 0) || command.count > this.state.zones[`${actor}:deck`]!.contents.items.length) throw new ApiError('INVALID_BONUS_COUNT', '补抽数量超出允许范围');
            const setup = clone(this.state.setup); setup.bonusChosen[actor] = true;
            const tasks = command.count ? [this.#moveAll(`${actor}:deck`, `${actor}:hand`, command.count)] : [];
            tasks.push(this.#progressTask({ ...this.state.flow, choice: null }, setup));
            const bonusIds = this.state.zones[`${actor}:deck`]!.contents.items.slice(0, command.count).flatMap(ref => ref?.kind === 'card' ? [ref.id] : []);
            receipt = await this.#protocol(bound, request, (_state, meta) => { meta.tasks = tasks; meta.bonusCards[actor] = bonusIds; });
          } else throw new ApiError('INVALID_COMMAND', '未支持的准备选择');
        } else {
          const computed = executeCore(this.state, command, bound, this.entropy);
          if (!computed.changed) receipt = await this.#outcome(bound, request, { status: 'not_executed', revision: this.state.revision, reason: '操作未改变状态' });
          else {
            const meta = clone(this.meta); if (command.kind === 'concede') { meta.tasks = []; if (meta.dispute) meta.dispute.status = 'closed'; }
            receipt = await this.#commit(computed.state, meta, bound, request, computed.result, computed.reveals);
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'COMMAND_REJECTED';
        receipt = await this.#outcome(bound, request, { status: 'rejected', revision: this.state.revision, error: { code, message: error instanceof Error ? error.message : '操作被拒绝' } });
      }
      if (receipt.status === 'committed') { try { await this.#pump(); } catch (error) { this.meta.runtime = { status: 'aborted', error: error instanceof Error ? error.message : '自动步骤失败' }; await this.saveRuntime(); } }
      return receipt;
  }
  #branchTasks(tasks: Task[], branchId: string): Task[] { return tasks.map(task => ({ ...clone(task), id: `${branchId}:${task.id}` })); }
  async resumeAutomatic(): Promise<void> { await this.serial(() => this.#pump()); }
  async #pump(): Promise<void> {
    for (let budget = 0; budget < 2048; budget++) {
      if (this.meta.tasks.length) { await this.#runTask(this.meta.tasks[0]!); continue; }
      if (this.meta.dispute && this.meta.dispute.status !== 'closed') return;
      if (this.state.flow.phase !== 'setup' || this.state.flow.choice) return;
      if (!await this.#advanceSetup()) return;
    }
    this.meta.runtime = { status: 'aborted', error: '自动准备超过 2048 个步骤，已保存现场' }; await this.saveRuntime();
  }
  async #runTask(task: Task): Promise<void> {
    const actor: Actor = { kind: 'system', purpose: this.meta.dispute?.status === 'applying' ? 'disposition' : 'setup' };
    let command = task.command;
    if (task.moveCard) {
      const position = findCardPosition(this.state, task.moveCard.cardId); if (!position) throw new ApiError('SETUP_CARD_MISSING', '准备卡牌不在当前状态中', 500);
      command = { kind: 'move', source: { container: { kind: 'zone', zoneId: position.zoneId }, range: { mode: 'indices', indices: [position.index] } }, destination: task.moveCard.group ? { container: { kind: 'group', position: { zoneId: task.moveCard.zoneId, index: task.moveCard.index }, relation: 'stack' }, index: 0 } : dest(task.moveCard.zoneId, task.moveCard.index) };
    }
    if (task.revealCard) { const position = findCardPosition(this.state, task.revealCard); if (!position) throw new ApiError('SETUP_CARD_MISSING', '无法公开不存在的卡牌', 500); command = { kind: 'set_state', target: { kind: 'card', position }, field: { key: 'visibility', value: { mode: 'public' } } }; }
    if (task.restoreBefore) {
      const before = this.#before(task.restoreBefore); const meta = clone(this.meta); const eventId = this.#eventId();
      const target = this.records.find(r => r.event?.A.id === task.restoreBefore)!;
      for (const record of this.records) if (record.event && record.sequence >= target.sequence && !meta.revoked[record.event.A.id] && record.actor?.kind !== undefined && record.request?.command.kind !== 'object' && record.request?.command.kind !== 'respond') meta.revoked[record.event.A.id] = eventId;
      meta.tasks.shift(); if (before.state.flow.phase === 'setup' && before.meta.dispute?.status !== 'applying') { meta.restoredSetupTasks = this.#branchTasks(before.meta.tasks, eventId); meta.bonusCards = clone(before.meta.bonusCards); }
      const result = executeCore(this.state, { kind: 'system_restore', state: before.state }, actor, this.entropy);
      await this.#commit(result.state, meta, actor, { requestId: `task:${task.id}`, revision: this.state.revision, command: { kind: 'system_restore', state: before.state } }, asJson({ restoredBefore: task.restoreBefore, revokedEvents: Object.keys(meta.revoked).filter(id => !this.meta.revoked[id]) }), [], '恢复牌桌与流程', eventId);
      return;
    }
    if (task.closeDispute) { await this.#protocol(actor, { requestId: `task:${task.id}`, revision: this.state.revision, command: { kind: 'close_dispute' } }, (_state, meta) => { meta.tasks.shift(); meta.dispute!.status = 'closed'; if (meta.restoredSetupTasks) { meta.tasks.push(...meta.restoredSetupTasks); delete meta.restoredSetupTasks; } }); return; }
    if (task.endResult?.kind === 'confirm_reported_result') {
      if (!this.#validReportedResults().includes(task.endResult.reportEventId)) throw new ApiError('INVALID_REPORTED_RESULT', '裁判确认引用不是当前有效的待确认结果');
      await this.#core({ kind: 'confirm_result', agree: true }, actor, `task:${task.id}`, this.state.revision, meta => { meta.tasks.shift(); }); return;
    }
    if (task.endResult?.kind === 'abnormal') { await this.#protocol(actor, { requestId: `task:${task.id}`, revision: this.state.revision, command: { kind: 'judge_end' } }, (state, meta) => { state.flow = { ...state.flow, phase: 'finished', choice: null, handoffReturnTo: null, proposedResult: null, result: { kind: 'abnormal', reason: '裁判判定异常结束' } }; meta.tasks.shift(); }); return; }
    if (!command) throw new ApiError('INVALID_TASK', '系统任务缺少命令', 500);
    const result = executeCore(this.state, command, actor, this.entropy); const meta = clone(this.meta); meta.tasks.shift();
    // 纯空操作仍原子记录任务游标，避免重启死循环。
    if (!result.changed) await this.#append({ kind: 'outcome', sequence: this.records.length, actor, request: { requestId: `task:${task.id}`, revision: this.state.revision, command }, receipt: { status: 'not_executed', revision: this.state.revision, reason: '系统步骤为空操作' }, state: this.state, meta });
    else await this.#commit(result.state, meta, actor, { requestId: `task:${task.id}`, revision: this.state.revision, command }, result.result, result.reveals);
  }
  async #setTasks(tasks: Task[]): Promise<void> { await this.#protocol(system, { requestId: uid(), revision: this.state.revision, command: { kind: 'setup_schedule' } }, (_state, meta) => { meta.tasks = tasks; }); }
  async #advanceSetup(): Promise<boolean> {
    const setup = clone(this.state.setup), flow = clone(this.state.flow);
    if (setup.stage === 'first') return false;
    if (setup.stage === 'placement' || setup.stage === 'mulligan') {
      const unplaced = players.filter(id => !setup.placed[id]);
      if (!unplaced.length) { setup.stage = 'bonus'; await this.#progress({ ...flow, choice: null }, setup); return true; }
      const good = unplaced.filter(id => this.#basics(id).length > 0), bad = unplaced.filter(id => !this.#basics(id).length);
      if (good.length) {
        const order = flow.firstPlayer ?? 'A'; const id = good.includes(order) ? order : good[0]!;
        await this.#progress({ ...flow, operator: id, choice: { kind: 'initial_placement', playerId: id, eligible: this.#basics(id), maximum: 5 } }, setup); return false;
      }
      if (!bad.length) throw new ApiError('SETUP_STATE_INVALID', '准备状态不一致', 500);
      const tasks: Task[] = [];
      for (const id of bad) {
        const hand = this.state.zones[`${id}:hand`]!.contents.items;
        setup.failedHands[id].push(hand.flatMap(ref => ref?.kind === 'card' ? [clone(this.state.definitions[this.state.cards[ref.id]!.definitionId]!)] : [])); setup.mulligans[id]++;
        if (bad.length === 1) setup.bonus[other(id)]++;
        tasks.push(this.#task({ kind: 'show', selection: selection(`${id}:hand`) }));
      }
      for (const id of bad) tasks.push(this.#moveAll(`${id}:hand`, `${id}:deck`), this.#task({ kind: 'shuffle', selection: selection(`${id}:deck`) }), this.#moveAll(`${id}:deck`, `${id}:hand`, 7));
      tasks.push(this.#progressTask({ ...flow, choice: null }, setup)); await this.#setTasks(tasks); return true;
    }
    if (setup.stage === 'bonus') {
      for (const id of players) if (!setup.bonusChosen[id]) {
        if (setup.bonus[id] > 0) { await this.#progress({ ...flow, operator: id, choice: { kind: 'mulligan_draw', playerId: id, maximum: setup.bonus[id], failedHands: setup.failedHands[other(id)] } }, setup); return false; }
        setup.bonusChosen[id] = true;
      }
      setup.stage = 'additional'; await this.#progress({ ...flow, choice: null }, setup); return true;
    }
    if (setup.stage === 'additional') {
      for (const id of players) if (!setup.additionalChosen[id]) {
        const free = this.state.zones[`${id}:bench`]!.contents.items.filter(item => !item).length;
        const eligible = this.#basics(id).filter(position => { const ref = this.state.zones[position.zoneId]!.contents.items[position.index]; return !!ref && this.meta.bonusCards[id].includes(ref.id); });
        if (eligible.length && free) { await this.#progress({ ...flow, operator: id, choice: { kind: 'additional_bench', playerId: id, eligible, maximum: free } }, setup); return false; }
        setup.additionalChosen[id] = true;
      }
      setup.stage = 'reveal'; await this.#progress({ ...flow, choice: null }, setup); return true;
    }
    if (setup.stage === 'reveal') {
      const tasks: Task[] = [];
      for (const id of players) for (const zone of ['active', 'bench']) tasks.push(this.#task({ kind: 'set_state', target: { kind: 'zone', zoneId: `${id}:${zone}` }, field: { key: 'visibility', value: { mode: 'public' } } }));
      setup.stage = 'done'; const first = flow.firstPlayer!;
      tasks.push(this.#progressTask({ ...flow, phase: 'turn', turnOwner: first, operator: first, turnNumber: 1, choice: null }, setup)); await this.#setTasks(tasks); return true;
    }
    return false;
  }
  async debug(input: { kind: 'restore'; targetEventId: string } | { kind: 'abort'; reason: string }): Promise<void> {
    await this.serial(async () => {
      if (this.meta.dispute && this.meta.dispute.status !== 'closed') throw new ApiError('DISPUTE_PENDING', '先完成异议处置，不能改写进行中的计划');
      if (input.kind === 'restore') { this.#before(input.targetEventId); const actor: Actor = { kind: 'system', purpose: 'debug' }; const before = this.#before(input.targetEventId); const state = executeCore(this.state, { kind: 'system_restore', state: before.state }, actor, this.entropy).state; const meta = clone(this.meta); const anchor = this.records.find(r => r.event?.A.id === input.targetEventId)!.sequence; const marker = uid(); for (const record of this.records) if (record.event && record.sequence >= anchor && !meta.revoked[record.event.A.id]) meta.revoked[record.event.A.id] = marker; meta.tasks = state.flow.phase === 'setup' ? this.#branchTasks(before.meta.dispute?.status === 'applying' ? before.meta.restoredSetupTasks ?? [] : before.meta.tasks, marker) : []; meta.bonusCards = clone(before.meta.bonusCards); delete meta.restoredSetupTasks; meta.runtime = { status: 'paused' }; await this.#commit(state, meta, actor, { requestId: uid(), revision: this.state.revision, command: { kind: 'debug_restore' } }, asJson(input), [], '调试恢复', marker); }
      else { this.meta.runtime = { status: 'aborted', error: input.reason }; await this.#protocol({ kind: 'system', purpose: 'debug' }, { requestId: uid(), revision: this.state.revision, command: { kind: 'debug_abort' } }, () => {}, asJson(input)); }
    });
  }
  tools(id: PlayerId, catalog = false): ToolDefinition[] {
    let names: string[];
    const dispute = this.meta.dispute;
    if (catalog) names = (GameCommandSchema as unknown as { anyOf: { properties: { kind: { const: string } } }[] }).anyOf.map(schema => schema.properties.kind.const);
    else if (this.state.flow.phase === 'finished') return [];
    else if (dispute && dispute.status !== 'closed') names = dispute.status === 'awaiting_response' && dispute.respondent === id ? ['respond','concede'] : [];
    else if (this.state.flow.phase === 'result_pending') names = this.state.flow.choice?.playerId === id ? ['confirm_result','object','concede'] : [];
    else if (this.state.flow.choice?.kind === 'handoff') names = this.state.flow.choice.playerId === id ? ['move','shuffle','set_state','look','show','random','create_group','remove_group','declare','handoff','concede','object'] : [];
    else if (this.state.flow.choice) names = this.state.flow.choice.playerId === id ? [this.state.flow.choice.kind, 'concede', 'object'] : [];
    else names = this.state.flow.operator === id ? ['move','shuffle','set_state','look','show','random','create_group','remove_group','declare','set_turn','handoff','report_result','confirm_result','concede','object'] : [];
    const configured = this.meta.prompts as PromptBundle & Partial<PromptConfig>;
    const schemas = (GameCommandSchema as unknown as { anyOf: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean; type: string }[] }).anyOf;
    const tools: ToolDefinition[] = schemas.flatMap(schema => {
      const kind = (schema.properties.kind as { const: string }).const;
      if (!names.includes(kind)) return [];
      const inputSchema = clone(schema); delete inputSchema.properties.kind; inputSchema.required = inputSchema.required.filter(key => key !== 'kind');
      return [{ name: kind, description: configured.toolDescriptions?.[kind] ?? kind, inputSchema: inputSchema as unknown as TSchema, effect: 'command' as const,
        ...(configured.feedback?.positionEncoding ? { argumentEncoding: 'ptcg-positions-v1' as const } : {}) }];
    });
    for (const [name, required, inputSchema] of [['move_known','move',MoveKnownInputSchema],['show_known','show',ShowKnownInputSchema]] as const) {
      if (names.includes(required) && configured.toolDescriptions?.[name]) tools.push({ name, description: configured.toolDescriptions[name], inputSchema, effect:'command',
        ...(configured.feedback?.positionEncoding ? { argumentEncoding:'ptcg-positions-v1' as const } : {}) });
    }
    if (names.length) tools.push({ name: 'read_history', description: configured.toolDescriptions?.read_history ?? 'read_history', inputSchema: Type.Object({ after: Type.Optional(Type.String()), before: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }), effect: 'read' }, { name: 'read_rules', description: configured.toolDescriptions?.read_rules ?? 'read_rules', inputSchema: Type.Object({ id: Type.Optional(Type.String()), query: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }), effect: 'read' });
    return tools;
  }
  rulesText = '';
  #factsAt(index: number, viewer: PlayerId): InPlayFact[] {
    const key = `${index}:${viewer}`, cached = this.#factCache.get(key);
    if (cached) return cached;
    const row = this.records[index]; if (!row) return [];
    const facts = publicInPlayFacts(this.records.slice(0, index + 1), row.state, row.meta.revoked, viewer);
    this.#factCache.set(key, facts); return facts;
  }
  #agentObservation(event: PublicEvent, viewer: PlayerId): PublicEvent {
    const index = this.records.findIndex(row => row.event?.A.id === event.id);
    if (index < 0) return event;
    const facts = this.#factsAt(index, viewer), prior = this.#factsAt(index - 1, viewer);
    const changed = facts.filter(fact => canonical(prior.find(old => old.lineageRef === fact.lineageRef)) !== canonical(fact));
    const departed = prior.filter(old => !facts.some(fact => fact.lineageRef === old.lineageRef)).map(old => old.lineageRef);
    const data = event.data as Record<string, Json>;
    return changed.length || departed.length ? { ...event, data: asJson({ ...data, ...(changed.length ? { inPlayFacts: changed } : {}), ...(departed.length ? { departedInPlayRefs: departed } : {}) }) } : event;
  }
  async observe(matchId: string, player: string, after: string | null): Promise<PlayerFrame> {
    if (matchId !== this.state.id || !players.includes(player as PlayerId)) throw new ApiError('FORBIDDEN', '席位不匹配', 403);
    const id = player as PlayerId; const tools = this.tools(id); const history = this.compactHistory(id, after ?? '0', 2000);
    return { matchId, playerId: id, revision: this.state.revision, cursor: history.cursor, status: this.state.flow.phase === 'finished' ? 'finished' : tools.length ? 'active' : 'waiting', snapshot: asJson({ ...projectTable(this.state, id), dispute: this.meta.dispute, runtime: this.meta.runtime, inPlayFacts: this.#factsAt(this.records.length - 1, id) }), observations: history.entries.map(event => ({ id: event.id, revision: event.revision, data: asJson(this.#agentObservation(event, id)) })), tools, toolCatalog: this.tools(id, true) };
  }
  async execute(request: ToolRequest): Promise<ToolReceipt> {
    if (request.matchId !== this.state.id || !players.includes(request.playerId as PlayerId)) throw new ApiError('FORBIDDEN', '席位不匹配', 403);
    const id = request.playerId as PlayerId;
    if (request.tool === 'move_known' || request.tool === 'show_known') return this.#executeKnown(request,id);
    if (request.tool === 'read_history' || request.tool === 'read_rules') {
      const args = request.arguments as { after?: string; before?: string; limit?: number; id?: string; query?: string };
      try {
        if (request.tool === 'read_history') return { status: 'read', revision: this.state.revision, data: asJson(this.readHistory(id, args)) };
        const rules = this.meta.rules;
        const sections = rules.split(/(?=^# (?:规则基准|卡牌说明文语义|赛场规则摘要)$)/mu).filter(text => text.trim());
        const selected = args.id ? sections.filter(text => text.split('\n')[0] === `# ${args.id}`) : sections;
        if (args.id && !selected.length) throw new ApiError('RULE_NOT_FOUND', '本局冻结规则中没有该来源');
        if (!args.query) return { status: 'read', revision: this.state.revision, data: asJson({ rules: selected.join('\n\n') }) };
        const snippets = selected.flatMap(text => { const lines = text.split('\n'); return lines.flatMap((line, index) => line.includes(args.query!) ? [{ source: lines[0]!.slice(2), text: lines.slice(Math.max(0,index-2),index+4).join('\n') }] : []); }).slice(0,args.limit ?? 10);
        return { status: 'read', revision: this.state.revision, data: asJson({ query: args.query, snippets }) };
      } catch (error) { return { status: 'rejected', revision: this.state.revision, data: asJson({ error: error instanceof Error ? error.message : '读取失败' }) }; }
    }
    const receipt = await this.command(id, { requestId: request.requestId, revision: request.revision, command: { ...(request.arguments as object), kind: request.tool } as GameCommand });
    if (request.tool === 'look' && receipt.status === 'committed' && this.state.revision === receipt.revision && this.state.flow.operator === id) {
      const selected = (request.arguments as {selection:Selection}).selection;
      if (selected.container.kind === 'zone' && selected.range.mode === 'all' && this.meta.prompts.toolDescriptions.move_known && this.meta.prompts.toolDescriptions.show_known)
        return { status:receipt.status,revision:receipt.revision,data:asJson(receipt),continuation:'continue',continuationGuard:{kind:'named_selection',zoneIds:[selected.container.zoneId]} };
    }
    const continuation = this.#continuation(request, receipt);
    const shuffledZone = request.tool === 'shuffle' ? (request.arguments as { selection: Selection }).selection.container : null;
    return { status: receipt.status, revision: receipt.revision, data: asJson(receipt), continuation, ...(continuation === 'continue' && shuffledZone?.kind === 'zone' ? { continuationGuard: { kind: 'hidden_shuffle' as const, zoneIds: [shuffledZone.zoneId] } } : {}) };
  }
  /** 根据已选牌面定位，失败只交还选择；不查看未知牌、不决定替代目标。 */
  async #executeKnown(request: ToolRequest, id: PlayerId): Promise<ToolReceipt> {
    return this.serial(() => this.#executeKnownHeld(request,id));
  }
  async #executeKnownHeld(request: ToolRequest, id: PlayerId): Promise<ToolReceipt> {
    const schema = request.tool === 'move_known' ? MoveKnownInputSchema : ShowKnownInputSchema;
    const malformed = validationError(schema,request.arguments);
    if (malformed) return {status:'rejected',revision:this.state.revision,data:{error:malformed},continuation:'observe'};
    const args = request.arguments as unknown as MoveKnownInput | ShowKnownInput;
    const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
    const prefix = `known:${digest([id,request.requestId])}:`, internalId = prefix + digest([request.revision,request.tool,args]);
    const wrap = (receipt: CommandReceipt, command?: GameCommand): ToolReceipt => {
      const actual = command ? { ...request, requestId:internalId, tool:command.kind, arguments:asJson(Object.fromEntries(Object.entries(command).filter(([key])=>key!=='kind'))) } : request;
      return {status:receipt.status,revision:receipt.revision,data:asJson(receipt),continuation:command ? this.#continuation(actual,receipt,this.#namedKnownCards(id,args.zoneId,this.records.findIndex(row=>row.request?.requestId===internalId)-1)) : 'observe'};
    };
    const cached = (): ToolReceipt | null => {
      const previous = this.records.find(row => row.request?.requestId.startsWith(prefix));
      if (!previous) return null;
      if (previous.request!.requestId !== internalId || previous.actor?.kind !== 'player' || previous.actor.playerId !== id) throw new ApiError('REQUEST_ID_CONFLICT','该请求标识已被不同请求使用',409);
      const receipt = clone(previous.receipt!); if (receipt.status === 'committed' && this.meta.revoked[receipt.eventId]) receipt.revokedBy = this.meta.revoked[receipt.eventId]!;
      return wrap(receipt,receipt.status === 'committed' ? previous.request!.command as GameCommand : undefined);
    };
    const previous = cached(); if (previous) return previous;
    const outcome = async (receipt: CommandReceipt): Promise<ToolReceipt> => {
      const previous = cached(); if (previous) return previous;
      const current: CommandReceipt = request.revision === this.state.revision ? receipt : {status:'rejected',revision:this.state.revision,error:{code:'REVISION_CONFLICT',message:'牌桌版本已变化，请读取最新观察'}};
      return wrap(await this.#outcome({kind:'player',playerId:id},{requestId:internalId,revision:request.revision,command:{...args,kind:request.tool}},current));
    };
    if (request.revision !== this.state.revision) return outcome({status:'rejected',revision:this.state.revision,error:{code:'REVISION_CONFLICT',message:'牌桌版本已变化，请读取最新观察'}});
    if (!this.tools(id).some(tool=>tool.name===request.tool)) return outcome({status:'rejected',revision:this.state.revision,error:{code:'TOOL_UNAVAILABLE',message:'当前不可执行该操作'}});
    const known = visibleCardIds(this.state,id);
    for (const cardId of this.#namedKnownCards(id,args.zoneId)) known.add(cardId);
    const matches = this.state.zones[args.zoneId]?.contents.items.flatMap((item,index)=>{
      if (item?.kind !== 'card' || !known.has(item.id)) return [];
      const card = this.state.definitions[this.state.cards[item.id]!.definitionId]!;
      if (card.name !== args.name || args.cardRef && !Object.hasOwn(cardContext(card).knownCards,args.cardRef)) return [];
      return [index];
    }) ?? [];
    const index = matches[args.occurrence ?? 0];
    if (index === undefined) return outcome({status:'not_executed',revision:this.state.revision,reason:'当前可查看散牌中没有所选牌面，需重新观察并选择'});
    const command: GameCommand = request.tool === 'move_known'
      ? {kind:'move',source:selection(args.zoneId,index,1),destination:(args as MoveKnownInput).destination}
      : {kind:'show',selection:selection(args.zoneId,index,1)};
    return wrap(await this.#commandHeld(id,{requestId:internalId,revision:request.revision,command}),command);
  }
  /** 私有查看后确定移出不使剩余散牌失忆；离区、洗牌或恢复断开关联。 */
  #namedKnownCards(viewer: PlayerId, zoneId: string, through = this.records.length - 1): Set<string> {
    const known = new Set<string>();
    for (const row of this.records.slice(0,through+1)) {
      const command = row.event ? row.request?.command : undefined;
      if (command?.kind === 'system_restore') known.clear();
      if (command?.kind === 'shuffle') {
        const selected = (command as Extract<GameCommand,{kind:'shuffle'}>).selection;
        if (selected.container.kind === 'zone' ? selected.container.zoneId === zoneId : selected.container.position.zoneId === zoneId) known.clear();
      }
      const current = new Set(row.state.zones[zoneId]?.contents.items.flatMap(item=>item?.kind==='card'?[item.id]:[]) ?? []);
      for (const id of known) if (!current.has(id)) known.delete(id);
      const reveals = (row.event?.[viewer].data as {reveals?:{cards:{position:Position}[]}[]} | undefined)?.reveals ?? [];
      for (const reveal of reveals) for (const card of reveal.cards) {
        if (card.position.zoneId !== zoneId || card.position.member) continue;
        const id = cardIdentity(row.state,card.position); if (id && current.has(id)) known.add(id);
      }
    }
    return known;
  }
  #transientKnown(beforeIndex: number, viewer: PlayerId): Set<string> {
    const known = new Set<string>(), invalid = new Set<string>(), current = this.records[beforeIndex]!.state;
    const identity = (state: GameState, zoneId: string) => canonical([state.zones[zoneId]?.contents, state.zones[zoneId]?.contents.items.flatMap(item => item?.kind === 'group' ? [state.groups[item.id]] : [])]);
    for (let index = beforeIndex; index > 0; index--) {
      const row = this.records[index]!, previous = this.records[index - 1]!;
      if (row.request?.command.kind === 'system_restore') break;
      const reveals = (row.event?.[viewer].data as { reveals?: { cards: { position: Position }[] }[] } | undefined)?.reveals ?? [];
      for (const reveal of reveals) for (const card of reveal.cards) {
        if (invalid.has(card.position.zoneId)) continue;
        const id = cardIdentity(row.state, card.position);
        if (id && cardIdentity(current, card.position) === id) known.add(id);
      }
      for (const zoneId of Object.keys(row.state.zones)) if (identity(row.state, zoneId) !== identity(previous.state, zoneId)) invalid.add(zoneId);
      if (row.request?.command.kind === 'shuffle') {
        const selection = (row.request.command as { selection: Selection }).selection;
        if (selection.container.kind === 'zone') invalid.add(selection.container.zoneId);
        else for (const zoneId of Object.keys(row.state.zones)) invalid.add(zoneId);
      }
    }
    return known;
  }
  #continuation(request: ToolRequest, receipt: CommandReceipt, extraKnown: Iterable<string> = []): 'continue' | 'observe' {
    if (receipt.status !== 'committed' || receipt.revokedBy || !['declare','move','create_group','remove_group','set_state','shuffle','show','set_turn'].includes(request.tool)) return 'observe';
    if (this.state.revision !== receipt.revision || this.state.flow.operator !== request.playerId) return 'observe';
    // 从原始记录重建，幂等重试也不能将一次开牌误判为可继续。
    const index = this.records.findIndex(record => record.request?.requestId === request.requestId && record.receipt?.status === 'committed');
    if (index < 1) return 'observe';
    const before = this.records[index - 1]!.state, after = this.records[index]!.state;
    const enteredCheck = request.tool === 'set_turn' && before.flow.phase === 'turn' && after.flow.phase === 'check'
      && canonical({ ...before.flow, phase: 'check', turnOwner: null }) === canonical(after.flow);
    if (canonical(before.flow) !== canonical(after.flow) && !enteredCheck) return 'observe';
    const known = visibleCardIds(before, request.playerId as PlayerId);
    for (const id of extraKnown) known.add(id);
    for (const id of this.#transientKnown(index - 1, request.playerId as PlayerId)) known.add(id);
    for (const id of visibleCardIds(after, request.playerId as PlayerId)) if (!known.has(id)) return 'observe';
    const revealed = (this.records[index]!.event?.[request.playerId as PlayerId].data as { reveals?: { cards: { position: Position }[] }[] })?.reveals ?? [];
    for (const reveal of revealed) for (const card of reveal.cards) { const id = cardIdentity(after, card.position); if (!id || !known.has(id)) return 'observe'; }
    if (request.tool === 'shuffle') {
      const selection = (request.arguments as { selection: Selection }).selection;
      if (selection.container.kind !== 'zone') return 'observe';
      const visible = visibleCardIds(after, request.playerId as PlayerId);
      const ids = resolveSelection(after, selection).flatMap(item => item.kind === 'card' ? [item.id] : [...after.groups[item.id]!.stack, ...after.groups[item.id]!.attached]);
      if (ids.some(id => visible.has(id))) return 'observe';
    }
    return 'continue';
  }
  #validReportedResults(state = this.state, beforeSequence = this.records.length): string[] {
    if (state.flow.phase !== 'result_pending' || !state.flow.proposedResult) return [];
    for (let index = Math.min(beforeSequence, this.records.length) - 1; index >= 0; index--) {
      const record = this.records[index]!; const command = record.request?.command;
      if (record.event && !this.meta.revoked[record.event.A.id] && command?.kind === 'report_result' && 'result' in command && canonical(command.result) === canonical(state.flow.proposedResult)) return [record.event.A.id];
    }
    return [];
  }
  judgeInput(): { facts: Json; evidenceIds: string[]; validRestoreTargets: string[]; validReportedResults: string[]; zones: { zoneId: string; size: number }[] } {
    return { facts: asJson({ state: this.state, dispute: this.meta.dispute, defense: this.meta.judgeReason, events: this.records.filter(r => r.event).map(r => ({ id: r.event!.A.id, request: r.request, revokedBy: this.meta.revoked[r.event!.A.id] })) }), evidenceIds: this.records.flatMap(r => r.event ? [r.event.A.id] : []), validRestoreTargets: this.records.flatMap(r => r.event && !this.meta.revoked[r.event.A.id] ? [r.event.A.id] : []), validReportedResults: this.#validReportedResults(), zones: Object.values(this.state.zones).map(zone => ({ zoneId: zone.id, size: zone.contents.items.length })) };
  }
  #judgeProposal(decision: JudgeDecision): Proposal {
    const proposal: Proposal = { shuffles: decision.steps.flatMap(step => step.kind === 'shuffle' ? [{ container: { kind: 'zone' as const, zoneId: step.zoneId }, range: { mode: 'indices' as const, indices: step.indices } }] : []) };
    const restore = decision.steps.find(step => step.kind === 'restore'); if (restore?.kind === 'restore') proposal.restoreBeforeEventId = restore.targetEventId;
    return proposal;
  }
  /** 模型重试阶段只读核验；不生成随机结果、任务 ID 或持久授权。 */
  validateJudge(decision: JudgeDecision): void {
    if (this.meta.dispute?.status !== 'awaiting_judge') throw new ApiError('DISPUTE_STATE_CHANGED', '当前异议已不再等待裁判');
    const proposal = this.#judgeProposal(decision); this.#validateProposal(proposal);
    const end = decision.steps.find(step => step.kind === 'end_match');
    if (end?.kind === 'end_match' && end.result.kind === 'confirm_reported_result') {
      const reportEventId = end.result.reportEventId;
      const candidate = proposal.restoreBeforeEventId ? this.#before(proposal.restoreBeforeEventId).state : this.state;
      const cutoff = proposal.restoreBeforeEventId ? this.records.findIndex(record => record.event?.A.id === proposal.restoreBeforeEventId) : this.records.length;
      if (!this.#validReportedResults().includes(reportEventId) || !this.#validReportedResults(candidate, cutoff).includes(reportEventId)) throw new ApiError('INVALID_REPORTED_RESULT', '裁判确认引用在当前或恢复后的候选状态中无效');
    }
  }
  async applyJudge(decision: JudgeDecision): Promise<void> {
    await this.serial(async () => {
      if (this.meta.dispute?.status !== 'awaiting_judge') return;
      this.validateJudge(decision);
      const proposal = this.#judgeProposal(decision);
      const tasks = this.#plan(proposal); const end = decision.steps.find(step => step.kind === 'end_match');
      if (end?.kind === 'end_match') tasks.splice(tasks.length - 1, 0, { id: uid(), endResult: clone(end.result) });
      await this.#protocol({ kind: 'system', purpose: 'disposition' }, { requestId: `judge:${this.meta.dispute.id}`, revision: this.state.revision, command: { kind: 'judge_ruling' } }, (_state, meta) => { meta.dispute!.status = 'applying'; meta.dispute!.ruling = { verdict: decision.verdict, ruleRefs: decision.ruleRefs, steps: decision.steps.map(step => step.kind === 'end_match' && step.result.kind === 'abnormal' ? { kind: step.kind, result: { kind: 'abnormal', reason: '裁判判定异常结束' } } : asJson(step)) }; meta.tasks = tasks; });
      await this.#pump();
    });
  }
}
