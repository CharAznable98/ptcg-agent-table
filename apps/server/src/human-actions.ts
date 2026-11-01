import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { resolveSelection } from '../../../packages/game-core/src/index.ts';
import { JsonlTrace, SecretRedactor, validationError, loadDefaultPrompts } from '../../../packages/agent/src/index.ts';
import type { ModelConfig, ModelGateway, ModelItem, ToolDefinition } from '../../../packages/agent/src/index.ts';
import {
  GameCommandSchema, PositionSchema, ContainerSchema, MoveDestinationSchema, HumanActionInputSchema, HumanChoiceAnswerSchema, HumanActionControlSchema,
  type CardData, type GameCommand, type HumanActionChoice, type HumanActionControl, type HumanActionInput,
  type HumanActionView, type HumanChoiceAnswer, type HumanChoiceOption, type ObjectView, type PlayerId,
  type Position, type PromptConfig, type Selection, type Viewer, type GameState, type Container, type MoveDestination,
} from '../../../packages/protocol/src/index.ts';
import { ApiError, atomicJson, canonical, clone, readJson, uid } from './storage.ts';
import { MatchRuntime, asJson } from './match.ts';
import { humanTurnStart, turnStartTexts } from './human-turn-start.ts';
import { committedHumanSteps } from './human-action-evidence.ts';
import { humanActionRecoveryPoints } from './human-action-recovery.ts';
import { createHumanActionContext, humanActionInput, type HumanActionContext } from './human-action-context.ts';

const object = <T extends Record<string, import('@sinclair/typebox').TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const text = Type.String({ minLength: 1, maxLength: 500 });
const effectText = Type.String({ minLength: 1, maxLength: 10000 });
const QuantityScopeSchema = Type.Union([
  object({ kind: Type.Literal('move'), source: ContainerSchema, destination: ContainerSchema, effectStep: Type.Optional(effectText) }),
  object({ kind: Type.Literal('show'), source: ContainerSchema, effectStep: Type.Optional(effectText) }),
  object({ kind: Type.Literal('random'), mode: Type.Union([Type.Literal('coins'), Type.Literal('until_tails'), Type.Literal('selection')]), source: Type.Optional(ContainerSchema), effectStep: Type.Optional(effectText) }),
  object({ kind: Type.Literal('set_state'), target: object({ kind: Type.Literal('group'), position: PositionSchema }), field: Type.Literal('damageCounters'), effectStep: Type.Optional(effectText) }),
]);
const ChoiceResolutionSchema = Type.Union([
  object({ kind: Type.Literal('move'), container: ContainerSchema }),
  object({ kind: Type.Literal('keep'), container: ContainerSchema }),
  object({ kind: Type.Literal('show') }), object({ kind: Type.Literal('look') }), object({ kind: Type.Literal('state') }),
]);
const RequestChoiceSchema = object({
  kind: Type.Union([Type.Literal('select'), Type.Literal('order'), Type.Literal('number')]), title: text,
  options: Type.Array(object({ id: text, label: Type.Optional(text), position: Type.Optional(PositionSchema) }), { maxItems: 200 }),
  minimum: Type.Integer({ minimum: 0, maximum: 1000 }), maximum: Type.Integer({ minimum: 0, maximum: 1000 }),
  orderDestination: Type.Optional(MoveDestinationSchema),
  quantityScopes: Type.Optional(Type.Array(QuantityScopeSchema, { minItems: 1, maxItems: 20 })),
  effectText: Type.Optional(effectText),
  resolution: Type.Optional(ChoiceResolutionSchema),
});
const MechanicalSchema = Type.Union([
  object({ kind: Type.Literal('switch'), target: PositionSchema }),
  object({ kind: Type.Literal('draw'), basis: Type.Union([Type.Literal('fixed'), Type.Literal('prizes')]), effectStep: effectText }),
  object({ kind: Type.Literal('place'), choiceId: text, target: PositionSchema }),
  object({ kind: Type.Literal('remainder'), choiceId: text }),
]);
const ExecuteSchema = object({
  command: GameCommandSchema,
  /** 明确引用已由人确认的选择；空数组只允许意图内对象及机械操作。 */
  choiceIds: Type.Array(text, { maxItems: 100, uniqueItems: true }),
  /** 超出手势本身的机械效果须引用当前来源卡的完整说明文，不能发起无关行动。 */
  effectText: Type.Optional(effectText),
  effectStep: Type.Optional(effectText),
  mechanical: Type.Optional(MechanicalSchema),
});
const SequenceSchema = object({ steps: Type.Array(ExecuteSchema, { minItems: 1, maxItems: 24 }), finish: Type.Boolean() });
const FinishSchema = object({});
const FailSchema = object({ reason: text });
const RestoreSchema = object({ beforeEventId: text, reason: text });
type ChoiceRequest = Static<typeof RequestChoiceSchema>;
type ExecuteRequest = Static<typeof ExecuteSchema>;
const effectQuote = (request: Pick<ExecuteRequest, 'effectStep' | 'mechanical'>): string | undefined => request.effectStep ?? (request.mechanical?.kind === 'draw' ? request.mechanical.effectStep : undefined);
interface OrderDestination extends MoveDestination { groupIdentity?: string; inferred?: boolean }
interface EffectStep { effectText: string; start: number; end: number }
interface QuantityBinding { scope: string; step: EffectStep }
type ChoiceResolution = Static<typeof ChoiceResolutionSchema> & { groupIdentity?: string };
interface ChoiceUse { choiceId: string; keys: string[] }
interface QuantityUse { choiceId: string; scope: string; count: number }
interface AuthorizationCommit { quantities: QuantityUse[]; orders: { choiceId: string; destination: OrderDestination }[]; extraTurn?: boolean; steps?: string[]; choices?: ChoiceUse[] }
interface PlacementBinding { choiceId: string; effectText: string; target: Position; cardId: string; groupId?: string }
interface SwitchBinding { target: string; effectText: string; active: Position; bench: Position; activeId: string; benchId: string }
interface AnswerRecord { requestId: string; fingerprint: string; choice: HumanActionChoice; selected: string[]; number?: number; identities: string[]; candidateIdentities?: string[]; candidateRevision?: number; consumed: string[]; invalidated?: boolean; orderDestination?: OrderDestination; quantityUses?: QuantityUse[]; quantityScopes?: string[]; quantityBindings?: QuantityBinding[]; selectionKeys?: string[]; executed?: string[]; resolution?: ChoiceResolution }
interface PendingCommand { requestId: string; revision: number; command: GameCommand; callId: string; consumedIdentities: string[]; authorization?: AuthorizationCommit; sequenceIndex?: number }
interface PendingRecovery { requestId: string; revision: number; beforeEventId: string; reason: string; callId: string }
interface RecoverySession { instructions: string; toolDescription: string; messageStart: number; reviewPasses: number; rollbackCount: number; modelCalls?: number; lastFailure?: string }
interface ExecutionSequence { callId: string; steps: ExecuteRequest[]; finish: boolean; next: number; receipts: unknown[]; stopped?: boolean }
interface ActionState {
  schemaVersion: 1; input: HumanActionInput; view: HumanActionView; instructions: string;
  toolDescriptions: Record<string, string>;
  feedback: Record<string, string>; configurationVersion: string;
  messages: ModelItem[]; pending: PendingCommand | null; failures: number; modelCalls: number;
  cursor: string | null;
  answers: AnswerRecord[]; initialIdentities: string[]; initialLocations: string[];
  revealed: { position: Position; card: CardData; identity: string; stamp: string }[];
  choiceCallId?: string; sourceCard?: CardData; initialTurn: number; effectTexts: string[];
  initialHandoffReturnTo?: PlayerId; initialHandoffReason?: string;
  choiceOrderDestination?: OrderDestination; extraTurnGranted?: boolean;
  choiceQuantityScopes?: string[];
  choiceQuantityBindings?: QuantityBinding[]; effectStepUses?: string[];
  choiceResolution?: ChoiceResolution;
  sequence?: ExecutionSequence;
  turnStart?: { key: string; requiresReview: boolean };
  interrupted?: boolean;
  recovery?: RecoverySession;
  pendingRecovery?: PendingRecovery;
  mechanicalSwitches?: SwitchBinding[];
  mechanicalPlacements?: PlacementBinding[];
  context?: HumanActionContext;
  manual?: boolean;
}
interface ExecutorConfiguration { schemaVersion: 1; version: string; instructions: string; toolDescriptions: Record<string, string>; feedback: Record<string, string> }
interface ControllerOptions {
  match: MatchRuntime;
  playerId?: PlayerId;
  modelFactory: (config: ModelConfig, trace: JsonlTrace) => ModelGateway;
  prompts: () => Promise<PromptConfig>;
  wake: () => void;
}
const active = (view: HumanActionView) => view.status === 'running' || view.status === 'awaiting_choice';
const key = (position: Position) => canonical(position);
const location = (position: Position) => `${position.zoneId}/${position.index}`;
const positionKeyChanged = (left: Position, right: Position) => canonical(left) !== canonical(right);
const user = (value: unknown): ModelItem => ({ role: 'user', content: JSON.stringify(value) });
const field = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function at(view: { zones: { id: string; items: (ObjectView | null)[] }[] }, position: Position): ObjectView | null {
  const parent = view.zones.find(zone => zone.id === position.zoneId)?.items[position.index] ?? null;
  if (!position.member || parent?.kind !== 'group') return position.member ? null : parent;
  return parent[position.member.relation][position.member.index] ?? null;
}
function identityInState(state: GameState, position: Position): string | null {
  const parent = state.zones[position.zoneId]?.contents.items[position.index];
  if (!parent) return null;
  if (!position.member) return `${parent.kind}:${parent.id}`;
  if (parent.kind !== 'group') return null;
  const card = state.groups[parent.id]?.[position.member.relation][position.member.index];
  return card ? `card:${card}` : null;
}
function positionOfIdentity(state: GameState, identity: string): Position | null {
  for (const zone of Object.values(state.zones)) for (const [index, ref] of zone.contents.items.entries()) {
    if (!ref) continue;
    if (`${ref.kind}:${ref.id}` === identity) return { zoneId: zone.id, index };
    if (ref.kind === 'group') for (const relation of ['stack', 'attached'] as const) {
      const member = state.groups[ref.id]?.[relation].findIndex(id => `card:${id}` === identity) ?? -1;
      if (member >= 0) return { zoneId: zone.id, index, member: { relation, index: member } };
    }
  }
  return null;
}
const identity = (match: MatchRuntime, position: Position) => identityInState(match.state, position);
function cardAt(match: MatchRuntime, playerId: PlayerId, position: Position): CardData | null {
  const item = at(match.view(playerId), position);
  if (item?.kind === 'card') return item.card;
  const top = item?.kind === 'group' ? item.stack.at(-1) : null;
  return top?.kind === 'card' ? top.card : null;
}
function zoneStamp(match: MatchRuntime, zoneId: string): string {
  const zone = match.state.zones[zoneId];
  if (!zone) return '';
  return canonical({ items: zone.contents.items, groups: zone.contents.items.flatMap(item => item?.kind === 'group' ? [match.state.groups[item.id] && { stack: match.state.groups[item.id]!.stack, attached: match.state.groups[item.id]!.attached }] : []) });
}
function cardEffects(card: CardData | null): string[] {
  if (!card) return [];
  return [...('text' in card && card.text ? [card.text] : []), ...(card.rulesText ? [card.rulesText] : []), ...(card.kind === 'pokemon' ? card.abilities.map(ability => ability.text) : [])].filter(Boolean);
}
function label(input: HumanActionInput, source: CardData | null): string {
  const names = { play: '使用', attach: '附着', evolve: '进化', attack: '使用招式', ability: '使用特性', retreat: '撤退', draw: '抽牌', end_turn: '结束回合', turn_start: '回合开始', resolve_handoff: '完成受托操作' };
  if (input.intent.kind === 'attack' && source?.kind === 'pokemon') return `${source.name} · ${source.attacks[input.intent.attackIndex]?.name ?? '招式'}`;
  if (input.intent.kind === 'ability' && source?.kind === 'pokemon') return `${source.name} · ${source.abilities[input.intent.abilityIndex]?.name ?? '特性'}`;
  return `${names[input.intent.kind]}${source ? ` ${source.name}` : ''}`;
}

/** 面向一次人类意图的独立编排。现有 AI 玩家上下文、策略和工具循环不参与这里的决策。 */
export class HumanActionController {
  readonly match: MatchRuntime;
  readonly playerId: PlayerId;
  readonly options: ControllerOptions;
  #state: ActionState | null = null;
  #publishedView: HumanActionView | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #driver: { controller: AbortController; promise: Promise<void> } | null = null;
  #resumeQueued = false;
  #waitingForControl = false;
  #preparingTurn: Promise<void> | null = null;
  #closed = false;
  constructor(options: ControllerOptions) {
    this.options = options; this.match = options.match; this.playerId = this.match.humanPlayer(options.playerId ?? this.match.defaultViewer());
    this.match.changes.on('change', this.#changed);
  }
  #changed = () => {
    if (!this.#waitingForControl || !this.#state || this.#driver || this.#state.view.status !== 'running' || this.match.state.flow.phase !== 'finished' && this.match.state.flow.operator !== this.#state.view.playerId || this.#resumeQueued) return;
    this.#resumeQueued = true;
    queueMicrotask(() => { this.#resumeQueued = false; if (this.#state?.view.status === 'running' && !this.#driver) this.#launch(); });
  };
  get running(): boolean { return Boolean(this.#driver); }
  async ensureTurnStart(): Promise<void> {
    if (this.#closed) return;
    if (this.#preparingTurn) return this.#preparingTurn;
    const task = (async () => {
      await this.match.serial(async () => {});
      if (this.#closed) return;
      const turn = humanTurnStart(this.match, this.playerId);
      if (!turn || turn.drew || this.#state && (active(this.#state.view) || this.#state.pending || this.#state.pendingRecovery || this.#state.interrupted || this.#requiresResolution())) return;
      await this.start({ playerId: this.playerId, requestId: `turn-start:${this.playerId}:${turn.key}`, revision: this.match.state.revision, intent: { kind: 'turn_start' } });
      if (!turn.requiresReview) await this.#driver?.promise;
    })();
    this.#preparingTurn = task;
    try { await task; } finally { if (this.#preparingTurn === task) this.#preparingTurn = null; }
  }
  #path(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError('INVALID_ACTION_ID', '无效行动标识');
    return join(this.match.directory, 'human-actions', `${id}.json`);
  }
  #serial<T>(work: () => Promise<T>): Promise<T> { const next = this.#queue.then(work); this.#queue = next.catch(() => {}); return next; }
  async recover(): Promise<void> {
    const pointer = await readJson<{ id: string }>(join(this.match.directory, `human-action-current-${this.playerId}.json`)) ?? await readJson<{ id: string }>(join(this.match.directory, 'human-action-current.json'));
    if (!pointer) return;
    this.#state = await readJson<ActionState>(this.#path(pointer.id));
    if (!this.#state) throw new ApiError('HUMAN_ACTION_CORRUPT', '当前行动记录缺失', 500);
    if (this.#state.view.playerId !== this.playerId) { this.#state = null; return; }
    const config = await this.#configuration();
    this.#state.toolDescriptions ??= clone(config.toolDescriptions);
    this.#state.feedback ??= clone(config.feedback);
    this.#state.configurationVersion ??= config.version;
    this.#restoreQuantityUses();
    if (await this.#settleKnownTerminal()) { await this.#save(); return; }
    if (this.#state.view.status === 'running') {
      this.#state.view.status = 'failed'; this.#state.view.error = '服务已重启，点击重试继续当前行动';
      this.#state.interrupted = true;
      await this.#save();
    } else if (this.#state.view.status === 'failed' && this.#state.view.error === '服务已重启，点击重试继续当前行动') this.#state.interrupted = true;
    this.#state.view.requiresResolution = this.#requiresResolution();
    if (active(this.#state.view) || this.#state.view.requiresResolution) this.#lock();
    else this.#unlock();
    this.#publishedView = clone(this.#state.view);
  }
  async #configuration(): Promise<ExecutorConfiguration> {
    const defaults = await loadDefaultPrompts(), configured = await this.options.prompts();
    // 只为新的人类行动采用当前角色配置。旧动作保存各自提示词，旧冻结文件与 AI 配置不改写。
    const instructions = configured.humanExecutor ?? defaults.humanExecutor;
    if (!instructions) throw new ApiError('EXECUTOR_PROMPT_MISSING', '请配置人类操作代理提示词');
    const toolDescriptions = { ...defaults.toolDescriptions, ...this.match.meta.prompts.toolDescriptions, ...configured.toolDescriptions };
    const feedback = { ...defaults.feedback, ...this.match.meta.prompts.feedback, ...configured.feedback };
    const contents = { instructions, toolDescriptions, feedback };
    const value: ExecutorConfiguration = { schemaVersion: 1, version: createHash('sha256').update(canonical(contents)).digest('hex'), ...contents };
    const path = join(this.match.directory, `human-action-config-${value.version}.json`);
    const frozen = await readJson<ExecutorConfiguration>(path); if (frozen) return frozen;
    await atomicJson(path, value); return value;
  }
  view(viewer: Viewer): HumanActionView | null {
    if (!this.#publishedView || viewer !== this.#publishedView.playerId) return null;
    return { ...clone(this.#publishedView), revision: this.match.state.revision };
  }
  #lock(): void {
    const view = this.#state!.view;
    this.match.lockHumanAction({ id: view.id, playerId: view.playerId, label: view.label, ...(this.#state!.manual ? { mode: 'manual' as const } : {}) });
  }
  #unlock(): void { if (this.#state) this.match.unlockHumanAction(this.playerId, this.#state.view.id); }
  #terminalFlowCommitted(): boolean {
    const intent = this.#state!.input.intent;
    return intent.kind === 'resolve_handoff' ? this.#returned() : ['attack', 'end_turn'].includes(intent.kind) && this.#turnEnded();
  }
  #settleCompletedFlow(): boolean {
    const state = this.#state!;
    if (state.pending || state.pendingRecovery || !this.#terminalFlowCommitted()) return false;
    try { this.#restoreQuantityUses(); this.#validateCompletion(); } catch { return false; }
    if (state.sequence) {
      state.messages.push({ type: 'function_call_output', call_id: state.sequence.callId, output: JSON.stringify({ status: 'completed', executedSteps: state.sequence.next, receipts: state.sequence.receipts }) });
      delete state.sequence;
    }
    state.view.status = 'completed'; delete state.view.error; delete state.view.choice; delete state.manual; delete state.interrupted;
    return true;
  }
  async #settleKnownTerminal(): Promise<boolean> {
    const state = this.#state!;
    if (!this.#terminalFlowCommitted()) return false;
    const pending = state.pending;
    // 仅查询已经存在的同ID有效回执；恢复服务不能提交尚未执行的旧请求。
    if (pending && this.match.records.some(record => record.request?.requestId === pending.requestId && record.request.revision === pending.revision && canonical(record.request.command) === canonical(pending.command) && record.receipt?.status === 'committed' && record.event && !this.match.meta.revoked[record.event.A.id])) {
      this.#lock(); await this.#executePending();
    }
    return this.#settleCompletedFlow();
  }
  #requiresResolution(): boolean {
    const state = this.#state;
    if (!state) return false;
    if (state.manual) return true;
    if (state.view.status === 'completed') return false;
    if (state.pending || state.pendingRecovery) return true;
    if (!['failed', 'cancelled'].includes(state.view.status)) return false;
    if (!this.#actionRecords().some(({ command }) => !['declare', 'system_restore'].includes(command.kind))) return false;
    // 这些基础意图的结果可由宿主完整核实；卡牌效果不能仅凭已支付费用认定结算完成。
    if (['draw', 'attach', 'evolve', 'retreat'].includes(state.input.intent.kind)) {
      try { this.#validateCompletion(); return false; } catch { /* 未完成仍保留结算义务。 */ }
    }
    return true;
  }
  async #save(): Promise<void> {
    const state = this.#state!;
    state.view.revision = this.match.state.revision;
    state.view.requiresResolution = this.#requiresResolution();
    if (active(state.view) || state.view.requiresResolution) this.#lock();
    else this.#unlock();
    state.view.eventIds = this.match.records.flatMap(record => record.event?.A.action?.id === state.view.id ? [record.event.A.id] : []);
    await atomicJson(this.#path(state.view.id), state);
    this.#publishedView = clone(state.view);
    this.match.changes.emit('change');
  }
  async start(raw: unknown): Promise<HumanActionView> {
    const malformed = validationError(HumanActionInputSchema, raw); if (malformed) throw new ApiError('INVALID_HUMAN_ACTION', malformed);
    const input = clone(raw as HumanActionInput);
    const playerId = this.match.humanPlayer(input.playerId);
    if (playerId !== this.playerId) throw new ApiError('FORBIDDEN', '不能控制其他席位的执行代理', 403);
    if (input.intent.kind !== 'turn_start') {
      await this.ensureTurnStart();
      const turn = humanTurnStart(this.match, this.playerId);
      if (turn && (!turn.drew || this.#state?.turnStart?.key === turn.key && this.#state.view.status !== 'completed')) throw new ApiError('TURN_START_PENDING', '请先完成回合开始处理；执行中断时可让代理继续修正', 409);
    }
    return this.#serial(async () => {
      const id = createHash('sha256').update(input.requestId).digest('hex').slice(0, 32);
      const previous = await readJson<ActionState>(this.#path(id));
      if (previous) {
        if (canonical(previous.input) !== canonical(input)) throw new ApiError('REQUEST_ID_CONFLICT', '请求标识已被其他行动使用', 409);
        return { ...clone(previous.view), revision: this.match.state.revision };
      }
      if (this.#driver && this.#state && !active(this.#state.view)) await this.#driver.promise;
      return this.match.serial(async () => {
        if (this.#state && (active(this.#state.view) || this.#requiresResolution())) throw new ApiError('HUMAN_ACTION_IN_PROGRESS', '请先完成当前结算，或让代理修正后再操作', 409);
        if (this.match.state.revision !== input.revision) throw new ApiError('REVISION_CONFLICT', '牌桌已变化，请重新操作', 409);
        if (this.match.state.flow.operator !== playerId || this.match.state.flow.phase === 'setup' || this.match.state.flow.phase === 'finished' || this.match.meta.dispute && this.match.meta.dispute.status !== 'closed') throw new ApiError('NOT_OPERATOR', '当前不能发起牌桌行动', 409);
        const intent = input.intent;
        const turnStart = intent.kind === 'turn_start' ? humanTurnStart(this.match, playerId) : null;
        if (intent.kind === 'turn_start' && (!turnStart || turnStart.drew)) throw new ApiError('TURN_START_ALREADY_HANDLED', '本回合开局抽牌已经完成或当前不在开局处理时点', 409);
        const flow = this.match.state.flow;
        if (intent.kind === 'resolve_handoff' && (flow.choice?.kind !== 'handoff' || flow.choice.playerId !== playerId || !flow.handoffReturnTo)) throw new ApiError('INVALID_HANDOFF', '当前没有等待本席位处理的受托操作', 409);
        if (flow.choice?.kind === 'handoff' && intent.kind !== 'resolve_handoff') throw new ApiError('HANDOFF_ACTION_REQUIRED', '请先完成受托操作并归还操作权', 409);
        const source = 'source' in intent ? intent.source ?? null : null;
        if (source && (!source.zoneId.startsWith(`${playerId}:`) || !identity(this.match, source))) throw new ApiError('INVALID_ACTION_SOURCE', '请使用本人当前牌桌上的卡牌');
        const sourceCard = source ? cardAt(this.match, playerId, source) : null;
        if (source && !sourceCard) throw new ApiError('HIDDEN_INFORMATION', '不能用未知牌面发起此行动', 403);
        if ((intent.kind === 'attack' || intent.kind === 'ability') && (sourceCard?.kind !== 'pokemon' || !(intent.kind === 'attack' ? sourceCard.attacks[intent.attackIndex] : sourceCard.abilities[intent.abilityIndex]))) throw new ApiError('INVALID_ACTION', '所选招式或特性不存在');
        const config = await this.#configuration();
        const positions = [source, 'target' in intent ? intent.target ?? null : null].filter((value): value is Position => value !== null);
        const targetCard = 'target' in intent && intent.target ? cardAt(this.match, playerId, intent.target) : null;
        const publicGroups = this.match.view(playerId).zones.flatMap(zone => zone.items.flatMap(item => item?.kind === 'group' ? [item] : []));
        const handoffCards = intent.kind === 'resolve_handoff' ? this.#handoffCards() : [];
        const effectTexts = intent.kind === 'attack' && sourceCard?.kind === 'pokemon' ? [sourceCard.attacks[intent.attackIndex]!.text, ...cardEffects(targetCard)]
          : intent.kind === 'ability' && sourceCard?.kind === 'pokemon' ? [sourceCard.abilities[intent.abilityIndex]!.text, ...cardEffects(targetCard)]
          : intent.kind === 'turn_start' ? turnStart!.cards.flatMap(turnStartTexts) : intent.kind === 'end_turn' ? publicGroups.flatMap(group => cardEffects(cardAt(this.match, playerId, group.position))) : [...cardEffects(sourceCard), ...cardEffects(targetCard), ...handoffCards.flatMap(card => [...cardEffects(card), ...(card.kind === 'pokemon' ? card.attacks.map(attack => attack.text) : [])])];
        const handoffReturnTo = intent.kind === 'resolve_handoff' ? flow.handoffReturnTo : null;
        const emptyActive = intent.kind === 'resolve_handoff' && !this.match.state.zones[`${playerId}:active`]!.contents.items[0] ? [`${playerId}:active/0`] : [];
        this.#state = { schemaVersion: 1, input, instructions: config.instructions, toolDescriptions: clone(config.toolDescriptions), feedback: clone(config.feedback), configurationVersion: config.version, context: createHumanActionContext(), messages: [user({ stage: 'human_action_rules', rules: this.match.meta.rules }), user({ stage: 'human_action_setup', intent, sourceCard, ...(handoffReturnTo ? { handoff: { returnTo: handoffReturnTo, reason: flow.choice?.message ?? '', sourceCards: handoffCards } } : {}) })], pending: null, failures: 0, modelCalls: 0, cursor: null, answers: [], revealed: [], initialTurn: this.match.state.flow.turnNumber, effectTexts: effectTexts.filter(Boolean),
          ...(handoffReturnTo ? { initialHandoffReturnTo: handoffReturnTo, initialHandoffReason: flow.choice?.message ?? '' } : {}),
          initialIdentities: positions.flatMap(position => identity(this.match, position) ? [identity(this.match, position)!] : []), initialLocations: [...positions.map(location), ...emptyActive],
          ...(sourceCard ? { sourceCard } : {}),
          ...(turnStart ? { turnStart: { key: turnStart.key, requiresReview: turnStart.requiresReview } } : {}),
          view: { id, playerId, intent, label: label(input, sourceCard), status: 'running', revision: input.revision, eventIds: [] } };
        this.#lock(); await this.#save();
        await atomicJson(join(this.match.directory, `human-action-current-${playerId}.json`), { id });
        this.#launch(); return this.view(playerId)!;
      });
    });
  }
  async answer(id: string, raw: unknown): Promise<HumanActionView> {
    const malformed = validationError(HumanChoiceAnswerSchema, raw); if (malformed) throw new ApiError('INVALID_HUMAN_CHOICE', malformed);
    const input = clone(raw as HumanChoiceAnswer); this.match.humanPlayer(input.playerId);
    return this.#serial(async () => {
      const state = this.#owned(id, input.playerId);
      const previous = state.answers.find(answer => answer.requestId === input.requestId);
      if (previous) { if (previous.fingerprint !== canonical(input)) throw new ApiError('REQUEST_ID_CONFLICT', '选择请求标识已被使用', 409); return this.view(input.playerId)!; }
      const choice = state.view.choice;
      if (state.view.status !== 'awaiting_choice' || !choice || choice.id !== input.choiceId) throw new ApiError('CHOICE_EXPIRED', '此选择已失效', 409);
      if (input.revision !== this.match.state.revision) throw new ApiError('REVISION_CONFLICT', '牌桌已变化，请重新载入选择', 409);
      if (choice.kind === 'number') {
        if (input.selected.length || !Number.isInteger(input.number) || input.number! < choice.minimum || input.number! > choice.maximum) throw new ApiError('INVALID_CHOICE', '请选择范围内的数量');
      } else if (input.number !== undefined || input.selected.length < choice.minimum || input.selected.length > choice.maximum || input.selected.some(selected => !choice.options.some(option => option.id === selected))) throw new ApiError('INVALID_CHOICE', '所选项或数量不符合要求');
      const selectedOptions = input.selected.map(selected => choice.options.find(option => option.id === selected)!);
      const orderDestination = choice.kind === 'order' && state.choiceResolution?.kind !== 'state' ? state.choiceOrderDestination ?? this.#inferOrderDestination(selectedOptions) : undefined;
      state.answers.push({ requestId: input.requestId, fingerprint: canonical(input), choice: clone(choice), selected: input.selected, ...(input.number === undefined ? {} : { number: input.number }), identities: selectedOptions.flatMap(option => option.position && identity(this.match, option.position) ? [identity(this.match, option.position)!] : []), candidateRevision: this.match.state.revision, candidateIdentities: choice.options.flatMap(option => option.position && identity(this.match, option.position) ? [identity(this.match, option.position)!] : []), consumed: [], selectionKeys: selectedOptions.flatMap(option => option.position ? [identity(this.match, option.position) ?? `slot:${location(option.position)}`] : []), executed: [], ...(orderDestination ? { orderDestination } : {}), ...(state.choiceQuantityScopes ? { quantityScopes: clone(state.choiceQuantityScopes) } : {}), ...(state.choiceQuantityBindings ? { quantityBindings: clone(state.choiceQuantityBindings) } : {}), ...(state.choiceResolution ? { resolution: clone(state.choiceResolution) } : {}) });
      state.messages.push({ type: 'function_call_output', call_id: state.choiceCallId!, output: JSON.stringify({ status: 'human_confirmed', choiceId: choice.id, selected: selectedOptions.map(option => ({ id: option.id, label: option.label, ...(option.position ? { position: option.position } : {}) })), ...(input.number === undefined ? {} : { number: input.number }) }) });
      delete state.choiceCallId; delete state.choiceOrderDestination; delete state.choiceQuantityScopes; delete state.choiceQuantityBindings; delete state.choiceResolution; delete state.view.choice; delete state.view.error;
      state.view.status = 'running'; state.failures = 0; this.#lock(); await this.#save(); this.#launch(); return this.view(input.playerId)!;
    });
  }
  #owned(id: string, playerId: PlayerId): ActionState {
    if (this.#state?.view.id !== id) throw new ApiError('ACTION_EXPIRED', '该行动不再是当前行动', 409);
    if (this.#state.view.playerId !== playerId) throw new ApiError('FORBIDDEN', '不能控制其他席位的行动', 403);
    return this.#state;
  }
  #settleTerminalCalls(): void {
    const state = this.#state!;
    const delivered = new Set(state.messages.flatMap(message => message.type === 'function_call_output' ? [String(message.call_id)] : []));
    for (const message of state.messages) {
      if (message.type !== 'function_call' || delivered.has(String(message.call_id))) continue;
      // 仅修复旧版本已知无牌桌副作用的终端回执，绝不为待定原子操作伪造结果。
      if (message.name === 'fail_action' && ['failed', 'cancelled'].includes(state.view.status)) {
        let reason = state.view.error ?? '';
        try { const args = JSON.parse(String(message.arguments)); if (typeof args.reason === 'string') reason = args.reason; } catch {}
        state.messages.push({ type: 'function_call_output', call_id: message.call_id, output: JSON.stringify({ status: 'failed', reason }) });
      } else if (message.name === 'finish_action' && ['completed', 'failed', 'cancelled'].includes(state.view.status)) {
        state.messages.push({ type: 'function_call_output', call_id: message.call_id, output: JSON.stringify({ status: state.view.status === 'completed' ? 'completed' : 'terminal_recorded', actionStatus: state.view.status, eventIds: clone(state.view.eventIds) }) });
      }
    }
  }
  #handoffCards(): CardData[] {
    const cards: CardData[] = [];
    const addObject = (item: ObjectView | null) => {
      if (item?.kind === 'card') cards.push(item.card);
      if (item?.kind === 'group') for (const card of [...item.stack, ...item.attached]) if (card.kind === 'card') cards.push(card.card);
    };
    for (const zone of this.match.view(this.playerId).zones) if (!['hand', 'deck', 'prizes'].includes(zone.kind)) zone.items.forEach(addObject);
    for (const record of this.match.records.slice(-40)) {
      const event = record.event?.[this.playerId]; if (!event) continue;
      const data = field(event.data);
      const observed = Array.isArray(data.observedCards) ? data.observedCards : [];
      for (const item of observed) {
        const row = field(item), position = field(row.position), zoneId = String(position.zoneId ?? '');
        if (!/:(hand|deck|prizes)$/.test(zoneId) && row.card) cards.push(row.card as CardData);
      }
      for (const reveal of Array.isArray(data.reveals) ? data.reveals : []) for (const item of Array.isArray(field(reveal).cards) ? field(reveal).cards as unknown[] : []) if (field(item).card) cards.push(field(item).card as CardData);
    }
    return [...new Map(cards.map(card => [canonical(card), card])).values()];
  }
  async control(id: string, raw: unknown): Promise<HumanActionView> {
    const malformed = validationError(HumanActionControlSchema, raw); if (malformed) throw new ApiError('INVALID_ACTION_CONTROL', malformed);
    const input = raw as HumanActionControl; this.match.humanPlayer(input.playerId);
    return this.#serial(async () => {
      const state = this.#owned(id, input.playerId);
      if (input.action === 'cancel' || input.action === 'manual') {
        this.#driver?.controller.abort(); await this.#driver?.promise;
        if (state.pendingRecovery) { this.#lock(); await this.#executeRecovery(); }
        if (state.pending) {
          // 请求是否落盘只能由原请求 ID 查询/重试收敛；取消不抹掉待定副作用。
          this.#lock(); await this.#executePending();
          if (state.pending) throw new ApiError('ACTION_PENDING', '原请求结果仍待确认，当前行动不能解锁', 409);
        }
        if (this.#settleCompletedFlow()) { await this.#save(); this.options.wake(); return this.view(input.playerId)!; }
        if (state.choiceCallId) state.messages.push({ type: 'function_call_output', call_id: state.choiceCallId, output: JSON.stringify({ status: 'cancelled', reason: '人类取消本次选择，未授权任何默认选项。' }) });
        if (state.sequence) { state.messages.push({ type: 'function_call_output', call_id: state.sequence.callId, output: JSON.stringify({ status: 'cancelled', executedSteps: state.sequence.next, receipts: state.sequence.receipts }) }); delete state.sequence; }
        state.manual = input.action === 'manual';
        state.view.status = 'cancelled'; delete state.view.choice; delete state.choiceCallId; delete state.choiceOrderDestination; delete state.choiceQuantityScopes; delete state.choiceQuantityBindings; delete state.choiceResolution; delete state.view.error;
        delete state.interrupted;
        // 已提交的步骤保留。待定请求在取消前由运行任务按同一 ID 收敛，禁止无记录地回滚。
        this.#unlock(); await this.#save(); return this.view(input.playerId)!;
      }
      if (this.#driver && !active(state.view)) await this.#driver.promise;
      if (this.#driver || state.view.status === 'awaiting_choice') throw new ApiError('ACTION_BUSY', '请先完成当前选择或等待执行结束', 409);
      if (await this.#settleKnownTerminal()) { await this.#save(); this.options.wake(); return this.view(input.playerId)!; }
      if (this.match.state.flow.operator !== input.playerId || this.match.state.flow.phase === 'finished') throw new ApiError('NOT_OPERATOR', '当前不能继续该行动', 409);
      if (input.action === 'retry' && !['failed', 'cancelled'].includes(state.view.status)) throw new ApiError('INVALID_ACTION_CONTROL', '当前行动无需重试');
      delete state.manual;
      this.#settleTerminalCalls();
      this.#restoreQuantityUses();
      const configuration = await this.#configuration();
      const recoveryInstructions = configuration.feedback.humanRecoveryInstructions, toolDescription = configuration.toolDescriptions.human_restore_action;
      if (!recoveryInstructions || !toolDescription) throw new ApiError('RECOVERY_CONFIGURATION_MISSING', '缺少结算修正配置');
      state.recovery = { instructions: recoveryInstructions, toolDescription, messageStart: state.messages.length, reviewPasses: 0, rollbackCount: 0, modelCalls: 0 };
      state.view.recovery = { phase: 'reviewing', attempt: 1 };
      state.view.status = 'running'; delete state.view.error; state.failures = 0;
      delete state.interrupted;
      const opponent = input.playerId === 'A' ? 'B' : 'A';
      state.messages.push(user({ stage: input.action === 'repair' ? 'repair_requested' : 'retry_requested', instruction: configuration.feedback.humanRecoveryRequest,
        availableSettlementHandoffs: this.#cleanupAllowsHandoff(opponent) ? [opponent] : [] }));
      this.#lock(); await this.#save(); this.#launch(); return this.view(input.playerId)!;
    });
  }
  #recoveryReview() {
    const state = this.#state!;
    const steps = committedHumanSteps(this.match, state.view.id, state.messages);
    const first = this.match.records.findIndex(record => record.event?.A.action?.id === state.view.id);
    let unfinished: string | null = null;
    try { this.#validateChoices(); this.#validateOrders(); } catch (error) { unfinished = error instanceof Error ? error.message : '存在未完成选择'; }
    return {
      stage: 'recovery_review', actionId: state.view.id, originalIntent: state.input.intent, initialRevision: state.input.revision,
      latestFailure: state.recovery?.lastFailure ?? null, unfinished,
      choices: state.answers.map(answer => ({ choiceId: answer.choice.id, kind: answer.choice.kind, invalidated: Boolean(answer.invalidated),
        selected: answer.selected.map(id => { const option = answer.choice.options.find(option => option.id === id)!; return { id, label: option.label, ...(option.position ? { position: option.position } : {}) }; }),
        ...(answer.number === undefined ? {} : { number: answer.number, applied: answer.quantityUses ?? [] }), executed: answer.executed ?? [] })),
      committedSteps: steps.map(step => ({ eventId: step.record.event!.A.id, revision: step.record.state.revision, command: step.command, choiceIds: step.choiceIds })),
      relatedHistory: first < 0 ? [] : this.match.records.slice(first).flatMap(record => record.event ? [{ ...record.event[state.view.playerId],
        ...(this.match.meta.revoked[record.event.A.id] ? { revokedBy: this.match.meta.revoked[record.event.A.id] } : {}) }] : []),
      availableRestorePoints: humanActionRecoveryPoints(this.match, state.view.playerId, state.view.id),
      availableSettlementHandoffs: (['A', 'B'] as const).filter(id => id !== state.view.playerId && this.#cleanupAllowsHandoff(id)),
    };
  }
  #modelInput(): ModelItem[] {
    return humanActionInput(this.#state!, () => this.#recoveryReview());
  }
  #rebindChoicesAfterRestore(restoredRevision: number): { keptChoices: string[]; invalidatedChoices: string[] } {
    const state = this.#state!, keptChoices: string[] = [], invalidatedChoices: string[] = [];
    let invalidated = false;
    for (const answer of state.answers) {
      if (answer.invalidated) { invalidatedChoices.push(answer.choice.id); continue; }
      const keys = this.#selectionKeys(answer);
      let confirmedRevision = Infinity;
      try { const revision = JSON.parse(answer.fingerprint).revision; if (Number.isSafeInteger(revision) && revision >= 0) confirmedRevision = revision; } catch { /* 旧选择缺少可核实的时间，不恢复隐藏位置许可。 */ }
      let keyIndex = 0;
      for (const id of answer.selected) {
        const option = answer.choice.options.find(option => option.id === id)!;
        if (!option.position) continue;
        const key = keys[keyIndex++];
        if (!key || key.startsWith('slot:')) continue;
        const position = positionOfIdentity(this.match.state, key);
        if (!position) { invalidated = true; break; }
        // 身份可用于公开对象定位；隐藏位置须仍有原选择时点的许可，不能凭后端身份追踪。
        if (!cardAt(this.match, state.view.playerId, position) && (confirmedRevision > restoredRevision || positionKeyChanged(position, option.position))) {
          invalidated = true; break;
        }
        option.position = position;
      }
      if (invalidated) { answer.invalidated = true; invalidatedChoices.push(answer.choice.id); }
      else keptChoices.push(answer.choice.id);
    }
    // 已经看过的信息仍在历史中；临时查看许可须按恢复后的牌桌重新取得。
    state.revealed = [];
    return { keptChoices, invalidatedChoices };
  }
  async #executeRecovery(): Promise<void> {
    const state = this.#state!, pending = state.pendingRecovery!;
    const receipt = await this.match.restoreHumanAction(state.view.playerId, pending, { id: state.view.id, label: state.view.label });
    let choices: { keptChoices: string[]; invalidatedChoices: string[] } | undefined;
    if (receipt.status === 'committed') {
      if (!state.view.eventIds.includes(receipt.eventId)) state.view.eventIds.push(receipt.eventId);
      state.failures = 0; delete state.mechanicalSwitches; delete state.mechanicalPlacements;
      const restoredIndex = this.match.records.findIndex(record => record.event?.A.id === pending.beforeEventId);
      choices = this.#rebindChoicesAfterRestore(this.match.records[restoredIndex - 1]?.state.revision ?? -1);
      this.#restoreQuantityUses();
      if (state.recovery) state.recovery.rollbackCount++;
      state.view.recovery = { phase: 'rolling_back', attempt: state.view.recovery?.attempt ?? 1, restoredBeforeEventId: pending.beforeEventId };
    } else state.failures++;
    state.messages.push({ type: 'function_call_output', call_id: pending.callId, output: JSON.stringify({ ...receipt, ...(choices ?? {}) }) });
    delete state.pendingRecovery;
    await this.#save();
  }
  async #continueRecovery(reason: string): Promise<boolean> {
    const state = this.#state!, recovery = state.recovery;
    if (!recovery || state.pending || state.pendingRecovery || this.match.storageFaulted || !this.#actionRecords().length) return false;
    this.#restoreQuantityUses();
    recovery.lastFailure = reason;
    if (recovery.reviewPasses < 1) {
      recovery.reviewPasses++; recovery.messageStart = state.messages.length;
      state.view.recovery = { phase: 'reviewing', attempt: (state.view.recovery?.attempt ?? 1) + 1 };
      state.messages.push(user({ stage: 'recovery_review_requested', reason }));
      state.failures = 0; await this.#save(); return true;
    }
    const point = humanActionRecoveryPoints(this.match, state.view.playerId, state.view.id)[0];
    if (recovery.rollbackCount || !point) return false;
    const callId = `call_${uid()}`, restoreReason = `自动修正：${reason}`.slice(0, 500);
    state.messages.push({ type: 'function_call', call_id: callId, name: 'restore_action', arguments: JSON.stringify({ beforeEventId: point.eventId, reason: restoreReason }) });
    state.pendingRecovery = { requestId: `human-recovery:${state.view.id}:${uid()}`, revision: this.match.state.revision, beforeEventId: point.eventId, reason: restoreReason, callId };
    state.view.recovery = { phase: 'rolling_back', attempt: (state.view.recovery?.attempt ?? 1) + 1 };
    await this.#save(); await this.#executeRecovery();
    return !state.pendingRecovery && state.failures === 0;
  }
  #launch(): void {
    if (this.#closed || this.#driver || !this.#state || this.#state.view.status !== 'running') return;
    this.#waitingForControl = false;
    const controller = new AbortController();
    // 将任务排到当前提交之后，确保 202 响应与持久化先于模型副作用。
    const promise = Promise.resolve().then(() => this.#drive(controller.signal)).catch(async error => {
      if (!this.#state) return;
      if (controller.signal.aborted) return;
      this.#state.view.status = 'failed'; this.#state.view.error = error instanceof Error ? error.message : '行动执行中断';
      if (!this.#state.pending && !this.#state.pendingRecovery) this.#unlock(); await this.#save();
    }).finally(() => {
      this.#driver = null;
      if (!controller.signal.aborted && this.#state?.view.status === 'running' && this.match.state.flow.operator === this.#state.view.playerId) this.#launch();
      else this.#changed();
    });
    this.#driver = { controller, promise };
  }
  #tools(): ToolDefinition[] {
    const descriptions = this.#state!.toolDescriptions;
    return [
      { name: 'execute_atomic', description: descriptions.human_execute_atomic!, inputSchema: ExecuteSchema, effect: 'command' },
      { name: 'execute_sequence', description: descriptions.human_execute_sequence ?? '依次执行已经确定、无需观察中间新信息的机械步骤。steps每项与execute_atomic相同，每步独立校验和保存；任一步拒绝立即停止。look/random/shuffle/handoff之后停止其余步骤，须根据新反馈继续。finish=true仅在所有步骤成功且本次行动已完成时结束。', inputSchema: SequenceSchema, effect: 'command' },
      { name: 'request_choice', description: descriptions.human_request_choice!, inputSchema: RequestChoiceSchema, effect: 'read' },
      { name: 'finish_action', description: descriptions.human_finish_action!, inputSchema: FinishSchema, effect: 'read' },
      { name: 'fail_action', description: descriptions.human_fail_action!, inputSchema: FailSchema, effect: 'read' },
      ...(this.#state!.recovery ? [{ name: 'restore_action', description: this.#state!.recovery.toolDescription, inputSchema: RestoreSchema, effect: 'command' as const }] : []),
      ...this.match.tools(this.#state!.view.playerId).filter(tool => ['read_history', 'read_rules'].includes(tool.name)),
    ];
  }
  #choice(request: ChoiceRequest): HumanActionChoice {
    const state = this.#state!, playerId = state.view.playerId;
    const positions = request.options.flatMap(option => option.position ? [key(option.position)] : []);
    if (request.maximum < request.minimum || request.kind !== 'number' && (request.maximum > request.options.length || new Set(request.options.map(option => option.id)).size !== request.options.length || new Set(positions).size !== positions.length)) throw new ApiError('INVALID_CHOICE', '选择范围或选项不完整');
    if (request.kind === 'number' && request.options.length) throw new ApiError('INVALID_CHOICE', '数量选择不应携带选牌选项');
    const options: HumanChoiceOption[] = request.options.map(option => {
      if (!option.position) return { id: option.id, label: option.label ?? option.id };
      const position = option.position;
      const zone = this.match.state.zones[position.zoneId];
      if (!zone || position.index >= zone.contents.items.length || position.member && !identity(this.match, position)) throw new ApiError('INVALID_CHOICE_POSITION', '选择位置不存在');
      const own = zone.playerId === playerId;
      const visible = cardAt(this.match, playerId, position);
      const revealed = state.revealed.find(item => key(item.position) === key(position) && item.stamp === zoneStamp(this.match, position.zoneId) && item.identity === identity(this.match, position));
      if (!own && !visible && !revealed) throw new ApiError('HIDDEN_INFORMATION', '不能读取其他席位的隐藏选项', 403);
      const card = visible ?? revealed?.card;
      return { id: option.id, label: card?.name ?? `${position.zoneId} 第 ${position.index + 1} 位`, position: clone(position), ...(card ? { card: clone(card) } : {}) };
    });
    if (request.orderDestination && request.kind !== 'order') throw new ApiError('INVALID_CHOICE', '只有顺序选择可以声明排序目的地');
    if (request.quantityScopes && request.kind !== 'number') throw new ApiError('INVALID_CHOICE', '只有数量选择可以声明数量适用步骤');
    if (request.resolution && request.kind !== 'select' && !(request.kind === 'order' && request.resolution.kind === 'state')) throw new ApiError('INVALID_CHOICE', '顺序效果可声明state结果，其他执行结果仅用于普通选择');
    if (request.kind === 'order' && request.resolution?.kind === 'state' && request.orderDestination) throw new ApiError('INVALID_CHOICE', '效果处理顺序不应同时声明牌序目的地');
    if (request.kind === 'order' && options.some(option => !option.position || !identity(this.match, option.position))) throw new ApiError('INVALID_CHOICE', '顺序选择必须对应实际卡牌');
    if (request.orderDestination) state.choiceOrderDestination = this.#bindOrderDestination(request.orderDestination);
    else delete state.choiceOrderDestination;
    if (request.quantityScopes) {
      const scopes = request.quantityScopes.map(scope => {
        if (scope.kind === 'set_state') {
          const target = identity(this.match, scope.target.position);
          if (!target?.startsWith('group:')) throw new ApiError('INVALID_QUANTITY_SCOPE', '数量对应的状态目标不存在');
          return canonical({ kind: scope.kind, target, field: scope.field });
        }
        return canonical({ kind: scope.kind, ...(scope.kind === 'random' ? { mode: scope.mode } : {}), ...('source' in scope && scope.source ? { source: this.#containerKey(scope.source) } : {}), ...(scope.kind === 'move' ? { destination: this.#containerKey(scope.destination) } : {}) });
      });
      const bindings = request.quantityScopes.flatMap((scope, index) => scope.effectStep ? [{ scope: scopes[index]!, step: this.#effectStep(request.effectText, scope.effectStep)! }] : []);
      state.choiceQuantityScopes = scopes;
      if (bindings.length) state.choiceQuantityBindings = bindings; else delete state.choiceQuantityBindings;
    } else { delete state.choiceQuantityScopes; delete state.choiceQuantityBindings; }
    if (request.resolution) {
      const resolution = clone(request.resolution);
      if (resolution.kind === 'keep' && (!request.effectText || !state.effectTexts.includes(request.effectText))) throw new ApiError('UNBOUND_CARD_EFFECT', '保留原位须以本次真实完整卡文说明选择的含义');
      if ('container' in resolution) {
        const container = resolution.container, zoneId = container.kind === 'zone' ? container.zoneId : container.position.zoneId;
        if (!this.match.state.zones[zoneId] || container.kind === 'group' && !identity(this.match, container.position)?.startsWith('group:')) throw new ApiError('INVALID_CHOICE_RESOLUTION', '执行结果的容器不存在');
        state.choiceResolution = { ...resolution, ...(container.kind === 'group' ? { groupIdentity: identity(this.match, container.position)! } : {}) };
      } else state.choiceResolution = resolution;
    } else delete state.choiceResolution;
    return { id: uid(), kind: request.kind, title: request.title, options, minimum: request.minimum, maximum: request.maximum };
  }
  #effectStep(source: string | undefined, quote: string | undefined): EffectStep | null {
    if (!quote) return null;
    if (!source || !this.#state!.effectTexts.includes(source)) throw new ApiError('UNBOUND_EFFECT_STEP', '效果步骤必须引用本次实际卡文，并提供完整effectText');
    // 身份只依据原文边界；不解析中文数字、条件、操作或卡牌规则。
    const normalized = quote.trim().replace(/^[，,。；;！？!?\n]+|[，,。；;！？!?\n]+$/g, '').trim();
    const matches = [...source.matchAll(/[^，,。；;！？!?\n]+/g)].flatMap(match => {
      const value = match[0], trimmed = value.trim();
      if (trimmed !== normalized) return [];
      const start = match.index! + value.indexOf(trimmed);
      return [{ effectText: source, start, end: start + trimmed.length }];
    });
    if (matches.length !== 1) throw new ApiError('INVALID_EFFECT_STEP', 'effectStep必须逐字引用完整卡文中唯一的原文分句，不能自造标识、截短分句或使用歧义引用');
    return matches[0]!;
  }
  #quantityUseScope(answer: AnswerRecord, scope: string, step: EffectStep | null): string | null {
    const bindings = answer.quantityBindings?.filter(binding => binding.scope === scope);
    if (!bindings?.length) return scope;
    const binding = bindings.find(binding => !step || canonical(binding.step) === canonical(step));
    return binding ? canonical({ scope, step: binding.step }) : null;
  }
  #selectionKeys(answer: AnswerRecord): string[] {
    return answer.selectionKeys ?? (answer.identities.length ? answer.identities : answer.selected.flatMap(id => { const position = answer.choice.options.find(option => option.id === id)?.position; return position ? [`slot:${location(position)}`] : []; }));
  }
  #choiceUses(request: ExecuteRequest, game = this.match.state): ChoiceUse[] {
    const command = request.command;
    return this.#state!.answers.filter(answer => (answer.choice.kind === 'select' || answer.choice.kind === 'order' && answer.resolution?.kind === 'state') && !answer.invalidated && request.choiceIds.includes(answer.choice.id)).flatMap(answer => {
      const resolution = answer.resolution;
      if (resolution?.kind === 'keep') return [];
      let keys: string[] = [];
      if (command.kind === 'move' && (!resolution || resolution.kind === 'move')) {
        const destination = command.destination.container;
        const targetKey = resolution?.kind === 'move' ? resolution.container.kind === 'group' && resolution.groupIdentity ? `${resolution.groupIdentity}:${resolution.container.relation}` : this.#containerKey(resolution.container, game) : null;
        const placedInZone = resolution?.kind === 'move' && resolution.container.kind === 'zone' && destination.kind === 'group' && destination.relation === 'stack' && destination.position.zoneId === resolution.container.zoneId && ['bench', 'active'].includes(game.zones[destination.position.zoneId]?.kind ?? '');
        if (targetKey && targetKey !== this.#containerKey(destination, game) && !placedInZone) return [];
        keys = resolveSelection(game, command.source).map(ref => `${ref.kind}:${ref.id}`);
        if (destination.kind === 'group') { const id = identityInState(game, destination.position); if (id) keys.push(id); }
        else if (typeof command.destination.index === 'number') keys.push(`slot:${destination.zoneId}/${command.destination.index}`);
      } else if ((command.kind === 'show' && (!resolution || resolution.kind === 'show')) || command.kind === 'look' && resolution?.kind === 'look') keys = resolveSelection(game, command.selection).map(ref => `${ref.kind}:${ref.id}`);
      else if (command.kind === 'set_state' && (!resolution || resolution.kind === 'state') && (resolution || command.field.key !== 'marker') && (command.target.kind === 'card' || command.target.kind === 'group')) {
        const id = identityInState(game, command.target.position); if (id) keys = [id];
      } else if (command.kind === 'create_group' && !resolution && command.destination.container.kind === 'zone') keys = [`slot:${command.destination.container.zoneId}/${command.destination.index}`];
      const expected = this.#selectionKeys(answer), used = keys.filter(key => expected.includes(key));
      return used.length ? [{ choiceId: answer.choice.id, keys: used }] : [];
    });
  }
  #recordChoiceUses(uses: ChoiceUse[]): void {
    for (const use of uses) {
      const answer = this.#state!.answers.find(answer => answer.choice.id === use.choiceId);
      if (answer) for (const key of use.keys) if (!answer.executed?.includes(key)) (answer.executed ??= []).push(key);
    }
  }
  #validateChoices(): void {
    for (const answer of this.#state!.answers) {
      if (answer.invalidated || answer.choice.kind === 'order') continue;
      if (answer.choice.kind === 'number') {
        if (answer.number! > 0 && !answer.quantityUses?.length) throw new ApiError('UNFINISHED_HUMAN_CHOICE', '人类确认的非零数量尚无对应的成功执行');
        if (answer.quantityUses?.some(use => use.count !== answer.number)) throw new ApiError('CHOICE_QUANTITY_MISMATCH', '已提交步骤的实际数量与人类选择不一致，需要恢复到错误步骤前重新处理');
        continue;
      }
      const keys = this.#selectionKeys(answer);
      if (answer.resolution?.kind === 'keep') {
        const ids = this.#containerIds(answer.resolution.container, answer.resolution.groupIdentity);
        if (keys.every(key => ids.includes(key))) continue;
      } else if (keys.every(key => answer.executed?.includes(key))) continue;
      throw new ApiError('UNFINISHED_HUMAN_CHOICE', '人类选定的卡牌或目标尚未按本次choiceId实际执行；此前的look、宣告和标记不能代替执行');
    }
  }
  #explicitlySkipped(): boolean {
    return this.#state!.answers.some(answer => answer.choice.kind === 'number' ? answer.number === 0 : answer.selected.length === 0 && answer.choice.minimum === 0 || answer.choice.options.some(option => answer.selected.includes(option.id) && !option.position && /跳过|不执行|不使用|不发动|^否$/.test(option.label)));
  }
  #keptSelection(): boolean {
    return this.#state!.answers.some(answer => {
      const resolution = answer.resolution;
      if (resolution?.kind !== 'keep') return false;
      const keys = this.#selectionKeys(answer), ids = this.#containerIds(resolution.container, resolution.groupIdentity);
      return keys.length > 0 && keys.every(key => ids.includes(key));
    });
  }
  #containerKey(container: Container, game = this.match.state): string {
    return container.kind === 'zone' ? `zone:${container.zoneId}` : `${identityInState(game, container.position)}:${container.relation}`;
  }
  #containerIds(container: Container, groupIdentity?: string): string[] {
    if (container.kind === 'zone') return this.match.state.zones[container.zoneId]?.contents.items.map(ref => ref ? `${ref.kind}:${ref.id}` : '') ?? [];
    const id = groupIdentity ?? identity(this.match, container.position);
    const group = id?.startsWith('group:') ? this.match.state.groups[id.slice(6)] : null;
    return group?.[container.relation].map(id => `card:${id}`) ?? [];
  }
  #bindOrderDestination(destination: MoveDestination): OrderDestination {
    const container = destination.container, zone = this.match.state.zones[container.kind === 'zone' ? container.zoneId : container.position.zoneId];
    const id = container.kind === 'group' ? identity(this.match, container.position) : null;
    if (!zone || container.kind === 'zone' && zone.contents.layout !== 'sequence' || container.kind === 'group' && !id?.startsWith('group:')) throw new ApiError('INVALID_ORDER_DESTINATION', '顺序目的地必须是实际存在的有序容器');
    if (destination.index !== 'end' && destination.index > this.#containerIds(container).length) throw new ApiError('INVALID_ORDER_DESTINATION', '顺序目的地起点超出容器');
    return { ...clone(destination), ...(id ? { groupIdentity: id } : {}) };
  }
  #inferOrderDestination(options: HumanChoiceOption[]): OrderDestination | undefined {
    const positions = options.flatMap(option => option.position ? [option.position] : []);
    if (!positions.length) return undefined;
    const containerOf = (position: Position): Container => position.member ? { kind: 'group', position: { zoneId: position.zoneId, index: position.index }, relation: position.member.relation } : { kind: 'zone', zoneId: position.zoneId };
    const first = containerOf(positions[0]!);
    if (positions.some(position => this.#containerKey(containerOf(position)) !== this.#containerKey(first))) return undefined;
    const indices = positions.map(position => position.member?.index ?? position.index).sort((a, b) => a - b);
    if (indices.some((index, offset) => index !== indices[0]! + offset)) return undefined;
    return { ...this.#bindOrderDestination({ container: first, index: indices[0]! }), inferred: true };
  }
  #validateOrders(): void {
    for (const answer of this.#state!.answers) {
      if (answer.choice.kind !== 'order' || answer.invalidated || !answer.identities.length) continue;
      if (answer.resolution?.kind === 'state') {
        if (canonical(answer.executed ?? []) !== canonical(answer.identities)) throw new ApiError('UNFINISHED_HUMAN_ORDER', '状态效果尚未按玩家确认的目标顺序实际执行；不可为此移动卡牌');
        continue;
      }
      const destination = answer.orderDestination ?? this.#inferOrderDestination(answer.selected.map(id => answer.choice.options.find(option => option.id === id)!));
      const ids = destination ? this.#containerIds(destination.container, destination.groupIdentity) : [];
      const start = destination?.index === 'end' ? ids.length - answer.identities.length : destination?.index;
      if (start === undefined || start < 0 || canonical(ids.slice(start, start + answer.identities.length)) !== canonical(answer.identities)) throw new ApiError('UNFINISHED_HUMAN_ORDER', '目标容器中的实际牌序尚未符合人类确认的顺序；已选牌暂存和回插仍可沿用原choiceId，无须重新确认');
    }
  }
  #quantity(request: ExecuteRequest, scope: string, count: number | undefined, required: boolean, authorization: AuthorizationCommit): void {
    const numbers = this.#state!.answers.filter(answer => !answer.invalidated && answer.choice.kind === 'number');
    const referenced = numbers.filter(answer => request.choiceIds.includes(answer.choice.id));
    const step = this.#effectStep(request.effectText, effectQuote(request));
    const scoped = (answer: AnswerRecord) => this.#quantityUseScope(answer, scope, step);
    const applicable = numbers.some(answer => {
      const bound = scoped(answer);
      return bound !== null && (answer.quantityScopes?.includes(scope) || answer.quantityUses?.some(use => use.scope === bound) || !answer.quantityScopes?.length && !answer.quantityUses?.length && required);
    });
    if (!referenced.length && applicable) throw new ApiError('UNCONFIRMED_CHOICE', '此步骤必须引用人类已确认的数量选择');
    for (const answer of referenced) {
      const bound = scoped(answer);
      if (bound === null || answer.quantityScopes?.length && !answer.quantityScopes.includes(scope)) throw new ApiError('UNBOUND_QUANTITY_CHOICE', '该数量选择不适用于此效果分句、来源去向或随机模式');
      if (answer.number !== count) throw new ApiError('CHOICE_QUANTITY_MISMATCH', '执行数量必须与人类确认的数量一致');
      if (answer.quantityUses?.some(use => use.scope === bound)) throw new ApiError('CHOICE_QUANTITY_ALREADY_APPLIED', '此效果步骤的数量已经执行，不能重复消费同一选择');
      authorization.quantities.push({ choiceId: answer.choice.id, scope: bound, count: count! });
    }
    if (step) {
      const use = canonical({ scope, step });
      if (this.#state!.effectStepUses?.includes(use)) throw new ApiError('EFFECT_STEP_ALREADY_APPLIED', '该原文分句的机械步骤已经成功执行，不能重复执行');
      (authorization.steps ??= []).push(use);
    }
  }
  #quantityScope(command: GameCommand, game = this.match.state): string | null {
    if (command.kind === 'set_state' && command.target.kind === 'group' && command.field.key === 'damageCounters') {
      const target = identityInState(game, command.target.position);
      return target ? canonical({ kind: command.kind, target, field: command.field.key }) : null;
    }
    if (command.kind === 'random') return canonical({ kind: command.kind, mode: command.mode, ...(command.selection ? { source: this.#containerKey(command.selection.container, game) } : {}) });
    if (command.kind !== 'move' && command.kind !== 'show') return null;
    return canonical({ kind: command.kind, source: this.#containerKey(command.kind === 'move' ? command.source.container : command.selection.container, game), ...(command.kind === 'move' ? { destination: this.#containerKey(command.destination.container, game) } : {}) });
  }
  #quantityCount(command: GameCommand, game = this.match.state): number | undefined {
    if (command.kind === 'random') return command.count;
    if (command.kind === 'move' || command.kind === 'show') return resolveSelection(game, command.kind === 'move' ? command.source : command.selection).length;
    if (command.kind === 'set_state' && command.target.kind === 'group' && command.field.key === 'damageCounters') {
      const ref = game.zones[command.target.position.zoneId]?.contents.items[command.target.position.index];
      const group = ref?.kind === 'group' ? game.groups[ref.id] : null;
      return group ? Math.abs(command.field.value - group.state.damageCounters) : undefined;
    }
    return undefined;
  }
  #restoreQuantityUses(): void {
    const state = this.#state!;
    for (const answer of state.answers) { answer.quantityUses = []; answer.executed = []; answer.consumed = []; }
    state.effectStepUses = [];
    const evidence = state.sequence ? [...state.messages, { type: 'function_call_output', call_id: state.sequence.callId, output: JSON.stringify({ receipts: state.sequence.receipts }) }] : state.messages;
    for (const executed of committedHumanSteps(this.match, state.view.id, evidence)) {
      try {
        const request = executed, before = executed.before, scope = this.#quantityScope(request.command, before);
        this.#recordChoiceUses(this.#choiceUses(request, before));
        if (request.command.kind === 'move') {
          const ids = resolveSelection(before, request.command.source).map(ref => `${ref.kind}:${ref.id}`);
          for (const answer of state.answers) for (const id of ids) if (answer.identities.includes(id) && !answer.consumed.includes(id)) answer.consumed.push(id);
        }
        if (!scope) continue;
        const count = this.#quantityCount(request.command, before);
        if (count === undefined) continue;
        const step = this.#effectStep(request.effectText, effectQuote(request));
        if (step) {
          const use = canonical({ scope, step });
          if (!state.effectStepUses?.includes(use)) (state.effectStepUses ??= []).push(use);
        }
        for (const answer of state.answers.filter(answer => answer.choice.kind === 'number' && request.choiceIds.includes(answer.choice.id))) {
          const bound = this.#quantityUseScope(answer, scope, step);
          if (!bound || answer.quantityScopes?.length && !answer.quantityScopes.includes(scope)) continue;
          const previous = answer.quantityUses!.find(use => use.scope === bound);
          if (previous) previous.count += count;
          else answer.quantityUses!.push({ choiceId: answer.choice.id, scope: bound, count });
        }
      } catch { /* 无法核实的记录保持未执行；由修正流程审查，不补造结果。 */ }
    }
  }
  #authorized(choiceIds: string[]): Set<string> {
    const state = this.#state!;
    if (choiceIds.some(id => !state.answers.some(answer => answer.choice.id === id && !answer.invalidated))) throw new ApiError('UNCONFIRMED_CHOICE', '必须先由人确认此选择；洗牌后旧选择不能沿用');
    return new Set([...state.initialIdentities, ...state.answers.filter(answer => choiceIds.includes(answer.choice.id)).flatMap(answer => answer.identities)]);
  }
  #actionRecords() {
    const id = this.#state!.view.id;
    return this.match.records.flatMap((record, index) => record.event?.A.action?.id === id && record.request && !this.match.meta.revoked[record.event.A.id]
      ? [{ record, command: record.request.command as GameCommand, before: this.match.records[Math.max(0, index - 1)]!.state }] : []);
  }
  #movements() {
    return this.#actionRecords().flatMap(item => {
      if (item.command.kind !== 'move') return [];
      const command = item.command, selected = resolveSelection(item.before, command.source).map(ref => `${ref.kind}:${ref.id}`);
      const destination = command.destination.container;
      return [{ ...item, command, selected, destination, targetIdentity: destination.kind === 'group' ? identityInState(item.before, destination.position) : null }];
    });
  }
  #meaningfulEffect(): boolean {
    const state = this.#state!, source = state.sourceCard;
    const abilityName = state.input.intent.kind === 'ability' && source?.kind === 'pokemon' ? source.abilities[state.input.intent.abilityIndex]?.name : null;
    return this.#actionRecords().some(({ record, command, before }) => {
      if (['look', 'show', 'random'].includes(command.kind)) return true;
      if (command.kind !== 'set_state') return false;
      if (command.target.kind !== 'group' && command.target.kind !== 'card') return false;
      const id = identityInState(before, command.target.position);
      if (!id || !state.initialIdentities.includes(id) && !state.answers.some(answer => answer.identities.includes(id))) return false;
      if (command.field.key === 'marker' && (!abilityName?.trim() || !command.field.name.includes(abilityName))) return false;
      const position = command.target.position;
      const oldRef = before.zones[position.zoneId]?.contents.items[position.index];
      const nextRef = record.state.zones[position.zoneId]?.contents.items[position.index];
      if (oldRef?.kind === 'group' && nextRef?.kind === 'group' && oldRef.id === nextRef.id) return canonical(before.groups[oldRef.id]?.state) !== canonical(record.state.groups[nextRef.id]?.state);
      return command.field.key === 'visibility';
    }) || this.#movements().some(item => item.selected.length > 0 && canonical(item.before.zones) !== canonical(item.record.state.zones)) || this.#delegatedWork();
  }
  #delegatedWork(): boolean {
    const state = this.#state!;
    return this.#actionRecords().some(({ command, record }) => {
      if (command.kind !== 'handoff' || command.returning) return false;
      return this.match.records.some(later => later.sequence > record.sequence && later.actor?.kind === 'player' && later.actor.playerId === command.to && later.request?.command.kind === 'handoff' && (later.request.command as Extract<GameCommand, { kind: 'handoff' }>).returning === true && (later.request.command as Extract<GameCommand, { kind: 'handoff' }>).to === state.view.playerId && later.state.flow.operator === state.view.playerId && !later.state.flow.handoffReturnTo);
    });
  }
  /** 按本行动已提交的整组弃置事实放行结算交权；具体奖赏与替补仍由接收方处理。 */
  #cleanupAllowsHandoff(recipient: PlayerId): boolean {
    const records = this.#actionRecords(), moves = this.#movements();
    const delegatedThrough = records.findLast(({ command }) => command.kind === 'handoff' && !command.returning && command.to === recipient)?.record.sequence ?? -1;
    return records.some(({ command, before, record }) => {
      if (command.kind !== 'remove_group') return false;
      const zone = before.zones[command.position.zoneId], ref = zone?.contents.items[command.position.index];
      if (!zone?.playerId || !['active', 'bench'].includes(zone.kind) || ref?.kind !== 'group') return false;
      const owner = zone.playerId;
      const cleanup = moves.find(item => item.record.sequence < record.sequence
        && item.command.source.container.kind === 'group'
        && item.command.source.container.position.zoneId === command.position.zoneId
        && item.command.source.container.position.index === command.position.index
        && item.before.zones[command.position.zoneId]?.contents.items[command.position.index]?.id === ref.id
        && item.destination.kind === 'zone' && item.destination.zoneId === `${owner}:discard`);
      if (!cleanup) return false;
      const group = cleanup.before.groups[ref.id];
      if (!group?.stack.length) return false;
      const top = cleanup.before.cards[group.stack.at(-1)!];
      if (!top || cleanup.before.definitions[top.definitionId]?.kind !== 'pokemon') return false;
      const discarded = new Set(record.state.zones[`${owner}:discard`]!.contents.items.flatMap(item => item?.kind === 'card' ? [item.id] : []));
      if (![...group.stack, ...group.attached].every(id => discarded.has(id))) return false;
      if (owner !== recipient) return record.sequence > delegatedThrough;
      return zone.kind === 'active' && !this.match.state.zones[`${recipient}:active`]?.contents.items[0]
        && Boolean(this.match.state.zones[`${recipient}:bench`]?.contents.items.some(Boolean));
    });
  }
  #attackStarted(): boolean {
    const state = this.#state!, intent = state.input.intent, source = state.sourceCard;
    if (intent.kind !== 'attack' || source?.kind !== 'pokemon') return false;
    const name = source.attacks[intent.attackIndex]?.name.trim();
    return this.#meaningfulEffect() || Boolean(name && this.#actionRecords().some(item => item.command.kind === 'declare' && item.command.text.includes(name)));
  }
  #returned(): boolean {
    const state = this.#state!;
    return Boolean(state.initialHandoffReturnTo && this.#actionRecords().some(({ command, record }) => command.kind === 'handoff' && command.returning === true && command.to === state.initialHandoffReturnTo && record.state.flow.operator === state.initialHandoffReturnTo && record.state.flow.handoffReturnTo === null));
  }
  #handoffWorkDone(): boolean {
    const state = this.#state!, intent = state.input.intent;
    if (intent.kind !== 'resolve_handoff') return false;
    if (intent.source) {
      const sourceId = state.initialIdentities[0];
      return this.#movements().some(item => item.selected.includes(sourceId!) && item.destination.kind === 'zone' && item.destination.zoneId === (intent.target?.zoneId ?? `${this.playerId}:active`) && item.command.destination.index === (intent.target?.index ?? 0));
    }
    return this.#meaningfulEffect() || this.#explicitlySkipped() || this.#keptSelection();
  }
  #turnEnded(): boolean {
    const state = this.#state!;
    if (this.match.state.flow.phase === 'finished') return true;
    const next = state.view.playerId === 'A' ? 'B' : 'A';
    return this.#actionRecords().some(({ command, before }) => command.kind === 'set_turn' && command.phase === 'turn' && before.flow.phase === 'check' && (command.playerId === next || state.extraTurnGranted && command.playerId === state.view.playerId));
  }
  #validateCompletion(): void {
    const touched = new Set(this.#movements().flatMap(move => move.command.source.container.kind === 'group' ? [identityInState(move.before, move.command.source.container.position)] : []));
    for (const zone of Object.values(this.match.state.zones).filter(zone => ['active', 'bench'].includes(zone.kind))) for (const ref of zone.contents.items) if (ref?.kind === 'group' && touched.has(`group:${ref.id}`) && !this.match.state.groups[ref.id]?.stack.length) throw new ApiError('UNFINISHED_GROUP_CLEANUP', '场上空卡牌组尚未移除或放置完成，不能只完成一部分后结束行动');
    for (const binding of this.#state!.mechanicalPlacements ?? []) {
      const group = binding.groupId?.startsWith('group:') ? this.match.state.groups[binding.groupId.slice(6)] : null;
      if (!group || identity(this.match, binding.target) !== binding.groupId || canonical(group.stack.map(id => `card:${id}`)) !== canonical([binding.cardId])) throw new ApiError('UNFINISHED_MECHANICAL_PLACEMENT', '已选基础宝可梦尚未实际放到唯一备战槽，不能只创建空组或放入其他卡牌');
    }
    for (const binding of this.#state!.mechanicalSwitches ?? []) {
      if (identity(this.match, binding.active) !== binding.benchId || identity(this.match, binding.bench) !== binding.activeId) throw new ApiError('UNFINISHED_MECHANICAL_SWITCH', '已选定的交换尚未完成，不能只移动其中一只宝可梦');
    }
    const state = this.#state!, intent = state.input.intent, sourceId = state.initialIdentities[0], targetId = state.initialIdentities[1];
    this.#validateChoices();
    this.#validateOrders();
    const moves = this.#movements();
    let completed = false;
    if (intent.kind === 'attach' || intent.kind === 'evolve') {
      completed = moves.some(item => item.selected.includes(sourceId!) && item.destination.kind === 'group' && item.destination.relation === (intent.kind === 'attach' ? 'attached' : 'stack') && item.targetIdentity === targetId);
    } else if (intent.kind === 'play') {
      completed = moves.some(item => item.selected.includes(sourceId!) && item.command.source.container.kind === 'zone' && item.command.source.container.zoneId === `${state.view.playerId}:hand`
        && (state.sourceCard?.kind === 'pokemon' ? item.destination.kind === 'group' && item.destination.relation === 'stack' && ['active', 'bench'].includes(item.record.state.zones[item.destination.position.zoneId]?.kind ?? '')
          : state.sourceCard?.kind === 'energy' ? item.destination.kind === 'group' && item.destination.relation === 'attached'
            : item.destination.kind === 'group' ? item.destination.relation === 'attached' : ['discard', 'staging', 'stadium'].includes(item.record.state.zones[item.destination.zoneId]?.kind ?? '')));
    } else if (intent.kind === 'draw' || intent.kind === 'turn_start') {
      completed = moves.some(item => item.command.source.container.kind === 'zone' && item.command.source.container.zoneId === `${state.view.playerId}:deck` && item.selected.length === 1 && item.destination.kind === 'zone' && item.destination.zoneId === `${state.view.playerId}:hand`);
      if (intent.kind === 'turn_start') {
        completed ||= moves.some(item => item.command.source.container.kind === 'zone' && item.command.source.container.zoneId === `${state.view.playerId}:deck` && item.selected.length === 1 && item.destination.kind === 'zone' && item.destination.zoneId === `${state.view.playerId}:staging`
          && item.selected.every(id => moves.some(later => later.record.sequence > item.record.sequence && later.selected.includes(id) && (later.destination.kind !== 'zone' || later.destination.zoneId !== `${state.view.playerId}:staging`))));
        completed ||= this.match.state.zones[`${state.view.playerId}:deck`]!.contents.items.length === 0 && this.match.state.flow.phase === 'result_pending' && this.match.state.flow.proposedResult?.kind === 'win' && this.match.state.flow.proposedResult.winner !== state.view.playerId;
      }
    } else if (intent.kind === 'retreat') {
      const sourceMoved = moves.some(item => item.selected.includes(sourceId!) && item.destination.kind === 'zone' && item.destination.zoneId === intent.target.zoneId && item.command.destination.index === intent.target.index);
      const targetMoved = moves.some(item => item.selected.includes(targetId!) && item.destination.kind === 'zone' && item.destination.zoneId === intent.source.zoneId && item.command.destination.index === intent.source.index);
      completed = sourceMoved && targetMoved;
    } else if (intent.kind === 'attack' || intent.kind === 'end_turn') {
      completed = this.#turnEnded() && (intent.kind !== 'attack' || this.#attackStarted());
    } else if (intent.kind === 'resolve_handoff') {
      completed = this.#returned() && this.#handoffWorkDone();
    } else if (intent.kind === 'ability') {
      completed = this.#meaningfulEffect() || this.#explicitlySkipped() || this.#keptSelection();
    }
    if (!completed) throw new ApiError('HUMAN_ACTION_INCOMPLETE', '当前意图尚无对应的实际执行结果；请核对记录并完成缺失步骤，不能仅凭宣告或无关标记结束');
  }
  #checkTarget(position: Position): boolean {
    const state = this.#state!, intent = state.input.intent;
    if (!['attack', 'end_turn'].includes(intent.kind) || this.match.state.flow.phase !== 'check' || position.member || position.index !== 0) return false;
    const zone = this.match.state.zones[position.zoneId];
    return zone?.kind === 'active' && zone.contents.items[position.index]?.kind === 'group';
  }
  /** 昏厥清理按同一组身份查找清理前牌面，不依赖先移叠牌还是附着卡。 */
  #knockedOut(position: Position): boolean {
    const id = identity(this.match, position);
    if (!id?.startsWith('group:')) return false;
    const state = this.#state!, intent = state.input.intent;
    const ownAbility = intent.kind === 'ability' && state.sourceCard?.kind === 'pokemon' && state.initialIdentities[0] === id ? state.sourceCard.abilities[intent.abilityIndex]?.text : undefined;
    if (ownAbility?.split(/[，,。；;！？!?\n]/u).some(clause => /^(?:然后|接着|之后|则)?(?:使|令|让|将)?(?:这只宝可梦|此宝可梦|自身)(?:也)?昏厥$/u.test(clause.trim().replace(/[【】\[\]「」『』]/gu, '')))) return true;
    const groupId = id.slice(6), current = this.match.state.groups[groupId];
    if (!current) return false;
    const candidates = [this.match.state, ...this.#actionRecords().map(record => record.before).reverse()];
    for (const game of candidates) {
      const group = game.groups[groupId], top = group?.stack.at(-1);
      const card = top && game.cards[top] ? game.definitions[game.cards[top]!.definitionId] : null;
      if (card?.kind === 'pokemon') return current.state.damageCounters * 10 >= card.hp;
    }
    return false;
  }
  /** 仅扩大既有人类抉择的机械闭包；声明本身不授予新的目标、数量或牌序抉择。 */
  #mechanical(request: ExecuteRequest, authorized: Set<string>, locations: Set<string>): { draw?: boolean; switch?: boolean; remainder?: boolean } {
    const state = this.#state!, scope = request.mechanical, command = request.command;
    if (!scope) return {};
    const effect = request.effectText;
    if (!effect || !state.effectTexts.includes(effect)) throw new ApiError('UNBOUND_MECHANICAL_EFFECT', '机械步骤必须绑定本次真实完整卡文');
    if (scope.kind === 'place') {
      const answer = state.answers.find(item => item.choice.id === scope.choiceId && !item.invalidated && item.choice.kind === 'select');
      if (!answer || !request.choiceIds.includes(answer.choice.id) || answer.identities.length !== 1 || answer.selected.length !== 1 || scope.target.member || scope.target.zoneId !== `${state.view.playerId}:bench` || !/备战/.test(effect)) throw new ApiError('INVALID_MECHANICAL_PLACEMENT', '机械放置只适用于玩家已选的单张基础宝可梦和本人唯一备战空槽');
      const cardId = answer.identities[0]!, option = answer.choice.options.find(option => option.id === answer.selected[0]);
      const card = option?.card;
      if (!cardId.startsWith('card:') || this.match.state.cards[cardId.slice(5)]?.ownerId !== state.view.playerId || card?.kind !== 'pokemon' || card.stage !== '基础') throw new ApiError('INVALID_MECHANICAL_PLACEMENT', '放置卡牌必须是玩家已选且可读的本人基础宝可梦');
      let binding = state.mechanicalPlacements?.find(item => item.choiceId === answer.choice.id && item.effectText === effect && key(item.target) === key(scope.target));
      if (!binding) {
        const empty = this.match.state.zones[scope.target.zoneId]!.contents.items.flatMap((ref, index) => ref ? [] : [index]);
        if (empty.length !== 1 || empty[0] !== scope.target.index || command.kind !== 'create_group') throw new ApiError('UNCONFIRMED_TARGET', '存在多个备战空槽时仍须玩家指定；机械放置只能创建当前唯一空槽');
        binding = { choiceId: answer.choice.id, effectText: effect, target: clone(scope.target), cardId };
        (state.mechanicalPlacements ??= []).push(binding);
      }
      if (binding.cardId !== cardId) throw new ApiError('INVALID_MECHANICAL_PLACEMENT', '原放置卡牌身份已变化，不能沿用旧授权');
      if (command.kind === 'create_group') {
        if (binding.groupId || identity(this.match, binding.target) || command.destination.container.kind !== 'zone' || command.destination.container.zoneId !== binding.target.zoneId || command.destination.index !== binding.target.index) throw new ApiError('INVALID_MECHANICAL_PLACEMENT', '只能在原唯一空槽创建一次卡牌组');
      } else if (command.kind === 'move') {
        const selected = resolveSelection(this.match.state, command.source).map(ref => `${ref.kind}:${ref.id}`);
        const destination = command.destination.container, group = binding.groupId?.startsWith('group:') ? this.match.state.groups[binding.groupId.slice(6)] : null;
        if (canonical(selected) !== canonical([binding.cardId]) || !group || group.stack.length || destination.kind !== 'group' || destination.relation !== 'stack' || identity(this.match, destination.position) !== binding.groupId || key(destination.position) !== key(binding.target) || command.destination.index !== 0 && command.destination.index !== 'end') throw new ApiError('INVALID_MECHANICAL_PLACEMENT', '只能将原选卡牌放入刚创建的固定卡牌组叠牌');
      } else throw new ApiError('INVALID_MECHANICAL_PLACEMENT', '该命令不属于基础宝可梦的固定放置');
      locations.add(location(binding.target));
      return {};
    }
    if (scope.kind === 'switch') {
      if (!/互换|交换|替换/.test(effect) || scope.target.member) throw new ApiError('INVALID_MECHANICAL_SWITCH', '交换范围须绑定实际交换效果和已确认的备战目标');
      const target = key(scope.target);
      let binding = state.mechanicalSwitches?.find(item => item.target === target && item.effectText === effect);
      if (!binding) {
        const bench = this.match.state.zones[scope.target.zoneId], benchId = identity(this.match, scope.target);
        const active = { zoneId: `${bench?.playerId}:active`, index: 0 }, activeId = identity(this.match, active);
        if (bench?.kind !== 'bench' || !bench.playerId || !benchId?.startsWith('group:') || !activeId?.startsWith('group:') || !authorized.has(benchId)) throw new ApiError('UNCONFIRMED_TARGET', '交换的备战宝可梦必须已经由玩家选定');
        binding = { target, effectText: effect, active, bench: clone(scope.target), activeId, benchId };
        (state.mechanicalSwitches ??= []).push(binding);
      }
      if (!authorized.has(binding.benchId)) throw new ApiError('UNCONFIRMED_CHOICE', '交换仍须引用原目标的有效choiceId');
      if (command.kind === 'move') {
        if (command.source.container.kind !== 'zone' || command.destination.container.kind !== 'zone') throw new ApiError('INVALID_MECHANICAL_SWITCH', '交换只允许移动已绑定的两个完整卡牌组');
        const selected = resolveSelection(this.match.state, command.source).map(ref => `${ref.kind}:${ref.id}`);
        const destination = command.destination.container.zoneId, source = this.match.state.zones[command.source.container.zoneId];
        const owner = this.match.state.zones[binding.bench.zoneId]!.playerId;
        const final = selected[0] === binding.activeId ? binding.bench : binding.active;
        if (selected.length !== 1 || ![binding.activeId, binding.benchId].includes(selected[0]!) || source?.playerId !== owner || !['active', 'bench', 'staging'].includes(source.kind)
          || !(destination === `${owner}:staging` || destination === final.zoneId && command.destination.index === final.index)) throw new ApiError('INVALID_MECHANICAL_SWITCH', '机械交换只能经本席位暂存区送达两个固定槽位');
      } else if (command.kind === 'set_state' && command.target.kind === 'group' && command.field.key === 'specialConditions' && identity(this.match, command.target.position) === binding.activeId && command.field.value.length === 0) {
        // 原战斗宝可梦离开战斗场后的特殊状态清理，没有额外目标抉择。
        if (positionOfIdentity(this.match.state, binding.activeId)?.zoneId === binding.active.zoneId) throw new ApiError('INVALID_MECHANICAL_SWITCH', '尚未离开战斗场，不能借交换提前清除特殊状态');
      } else throw new ApiError('INVALID_MECHANICAL_SWITCH', '该命令不属于固定交换步骤');
      authorized.add(binding.activeId); authorized.add(binding.benchId);
      locations.add(location(binding.active)); locations.add(location(binding.bench));
      return { switch: true };
    }
    if (command.kind !== 'move' || command.source.container.kind !== 'zone' || command.destination.container.kind !== 'zone') throw new ApiError('INVALID_MECHANICAL_MOVE', '该机械授权仅适用于限定区域间移动');
    const from = this.match.state.zones[command.source.container.zoneId], to = this.match.state.zones[command.destination.container.zoneId];
    if (scope.kind === 'draw') {
      const step = this.#effectStep(effect, scope.effectStep ?? request.effectStep);
      if (request.effectStep && canonical(this.#effectStep(effect, request.effectStep)) !== canonical(step)) throw new ApiError('CONFLICTING_EFFECT_STEP', '内外effectStep必须指向同一完整原文分句');
      const quote = step ? effect.slice(step.start, step.end) : '';
      if (!step || !/抽|补充手牌/.test(quote) || /最多|至多|任意|可以|可抽|选择|至[0-9]+/.test(quote) || from?.kind !== 'deck' || !from.playerId || to?.kind !== 'hand' || to.playerId !== from.playerId || command.destination.index !== 'end' || command.source.range.mode !== 'range' || command.source.range.start !== 0) throw new ApiError('INVALID_MECHANICAL_DRAW', '固定盲抽须绑定无可选数量的完整抽牌分句，牌库顶进入同席位手牌');
      if (from.playerId !== state.view.playerId && !/双方|对手|对方/.test(effect)) throw new ApiError('UNBOUND_MECHANICAL_EFFECT', '本效果未授权对手固定盲抽');
      const literal = [...quote.matchAll(/(?:抽(?:出|取)?|补充手牌(?:至)?)([0-9]+)张/g)].map(match => Number(match[1]));
      const count = scope.basis === 'prizes' && /奖赏卡/.test(quote) && /相同|数量|张数/.test(quote)
        ? this.match.state.zones[`${from.playerId}:prizes`]!.contents.items.filter(Boolean).length
        : scope.basis === 'fixed' && literal.length === 1 ? literal[0] : undefined;
      if (count === undefined || command.source.range.count !== Math.min(count, from.contents.items.length)) throw new ApiError('INVALID_MECHANICAL_QUANTITY', '固定盲抽张数须与原文固定数量或该席位剩余奖赏数一致');
      return { draw: true };
    }
    const answer = state.answers.find(item => item.choice.id === scope.choiceId && !item.invalidated && item.choice.kind === 'select');
    const remaining = answer?.candidateIdentities?.filter(id => !answer.identities.includes(id));
    const selected = resolveSelection(this.match.state, command.source).map(ref => `${ref.kind}:${ref.id}`);
    const options = answer?.choice.options.flatMap(option => option.position ? [option.position] : []) ?? [];
    const intervening = this.#actionRecords().filter(item => item.record.state.revision > (answer?.candidateRevision ?? -1));
    const shuffled = intervening.some(item => item.command.kind === 'shuffle' && item.command.selection.container.kind === 'zone' && item.command.selection.container.zoneId === from?.id);
    const alreadyMoved = remaining?.some(id => this.#movements().some(item => item.record.state.revision > (answer?.candidateRevision ?? -1) && item.selected.includes(id)));
    if (!answer || shuffled || alreadyMoved || !request.choiceIds.includes(answer.choice.id) || !/剩下|剩余|其余/.test(effect) || !/最下方|下方|底部|牌库底/.test(effect)
      || remaining?.length !== 1 || selected.length !== 1 || selected[0] !== remaining[0] || from?.kind !== 'deck' || to?.id !== from.id || command.destination.index !== 'end'
      || options.length !== answer.choice.options.length || options.some(position => position.member || position.zoneId !== from.id)) throw new ApiError('INVALID_MECHANICAL_REMAINDER', '机械补集仅限同一已确认候选集合的唯一剩余卡牌归回原牌库底；多张牌的顺序仍须玩家决定');
    authorized.add(remaining[0]!);
    return { remainder: true };
  }
  /** 已选招式的纯数字主伤害属于原意图；追加说明文中的可选分配不改变该固定部分。 */
  #fixedPrimaryDamage(command: GameCommand): boolean {
    const state = this.#state!, intent = state.input.intent;
    if (intent.kind !== 'attack' || state.sourceCard?.kind !== 'pokemon' || command.kind !== 'set_state' || command.target.kind !== 'group' || command.field.key !== 'damageCounters') return false;
    const printed = state.sourceCard.attacks[intent.attackIndex]?.damageText.trim() ?? '';
    if (!/^[0-9]+$/u.test(printed)) return false;
    const damage = Number(printed), targetId = state.initialIdentities[1];
    const zone = this.match.state.zones[command.target.position.zoneId], originalZone = this.match.state.zones[intent.target.zoneId];
    if (!Number.isSafeInteger(damage) || damage <= 0 || zone?.kind !== 'active' || originalZone?.kind !== 'active' || zone.playerId === state.view.playerId || !targetId?.startsWith('group:') || identity(this.match, command.target.position) !== targetId) return false;
    const groupId = targetId.slice(6), current = this.match.state.groups[groupId];
    if (!current || (command.field.value - current.state.damageCounters) * 10 !== damage) return false;
    return !this.#actionRecords().some(({ command: applied, before }) => applied.kind === 'set_state' && applied.target.kind === 'group' && applied.field.key === 'damageCounters' && identityInState(before, applied.target.position) === targetId && applied.field.value > (before.groups[groupId]?.state.damageCounters ?? applied.field.value));
  }
  /** 选择范围的表示法不改变授权：只认可实际可读选项绑定的稳定实例及本次引用的有效选择。 */
  #chosenReadableCards(choiceIds: string[], ids: string[], zoneId: string): boolean {
    if (!ids.length || !choiceIds.length) return false;
    const readable = new Set<string>();
    for (const answer of this.#state!.answers) {
      if (answer.invalidated || answer.choice.kind === 'number' || !choiceIds.includes(answer.choice.id)) continue;
      const options = answer.selected.flatMap(id => { const option = answer.choice.options.find(option => option.id === id); return option?.position ? [option] : []; });
      const keys = answer.selectionKeys ?? (options.every(option => option.card) && options.length === answer.identities.length ? answer.identities : []);
      if (keys.length !== options.length) continue;
      let confirmedRevision: unknown;
      try { confirmedRevision = JSON.parse(answer.fingerprint).revision; } catch { continue; }
      if (typeof confirmedRevision !== 'number' || !Number.isSafeInteger(confirmedRevision)) continue;
      const shuffled = this.match.records.some(record => {
        const command = record.request?.command as GameCommand | undefined;
        return record.event && record.receipt?.status === 'committed' && !this.match.meta.revoked[record.event.A.id] && record.state.revision > confirmedRevision && command?.kind === 'shuffle' && command.selection.container.kind === 'zone' && command.selection.container.zoneId === zoneId;
      });
      if (shuffled) continue;
      options.forEach((option, index) => { if (option.card && answer.identities.includes(keys[index]!)) readable.add(keys[index]!); });
    }
    return ids.every(id => readable.has(id));
  }
  #guard(request: ExecuteRequest): AuthorizationCommit {
    const state = this.#state!, command = request.command, playerId = state.view.playerId;
    const authorization: AuthorizationCommit = { quantities: [], orders: [] };
    const authorized = this.#authorized(request.choiceIds);
    const authorizedAt = (position: Position) => { const id = identity(this.match, position); return Boolean(id && authorized.has(id)); };
    const chosenLocations = state.answers.filter(answer => request.choiceIds.includes(answer.choice.id)).flatMap(answer => answer.selected.flatMap(id => { const option = answer.choice.options.find(candidate => candidate.id === id); return option?.position ? [location(option.position)] : []; }));
    const locations = new Set([...state.initialLocations, ...chosenLocations]);
    const effect = request.effectText && state.effectTexts.includes(request.effectText) ? request.effectText : null;
    if (request.effectText && !effect) throw new ApiError('UNBOUND_CARD_EFFECT', '额外效果必须来自本次行动实际来源卡的说明文');
    this.#effectStep(request.effectText, effectQuote(request));
    const mechanical = this.#mechanical(request, authorized, locations);
    if (effect && command.kind !== 'look' && command.kind !== 'declare' && /可选择|最多|至多|任意|选择是否|可以抽|可抽|可以从|可以将/.test(effect) && !request.choiceIds.length && !state.answers.length && !this.#fixedPrimaryDamage(command)) throw new ApiError('UNCONFIRMED_OPTIONAL_EFFECT', '可选效果或数量必须先由人决定');
    if (['object', 'respond', 'concede', 'choose_first', 'initial_placement', 'mulligan_draw', 'additional_bench'].includes(command.kind)) throw new ApiError('OUTSIDE_HUMAN_INTENT', '该步骤不属于当前人类行动');
    if (state.input.intent.kind === 'turn_start' && command.kind === 'report_result' && (this.match.state.zones[`${playerId}:deck`]!.contents.items.length || this.#movements().some(item => item.command.source.container.kind === 'zone' && item.command.source.container.zoneId === `${playerId}:deck`) || command.result.kind !== 'win' || command.result.winner === playerId)) throw new ApiError('INVALID_TURN_START_RESULT', '只有开局抽牌前牌库已空时才能按无法抽牌申报对手获胜');
    if (command.kind === 'handoff' && state.input.intent.kind === 'resolve_handoff') {
      if (!command.returning || command.to !== state.initialHandoffReturnTo) throw new ApiError('INVALID_HANDOFF', '受托操作只能归还给已记录的原操作方');
      this.#validateChoices();
      if (!this.#handoffWorkDone()) throw new ApiError('HUMAN_ACTION_INCOMPLETE', '受托操作尚无实际处理结果，不能直接归还');
    } else if (command.kind === 'handoff') {
      const recipient = this.match.state.zones[`${command.to}:active`], bench = this.match.state.zones[`${command.to}:bench`];
      const replacement = ['attack', 'end_turn'].includes(state.input.intent.kind) && recipient?.contents.items[0] === null && Boolean(bench?.contents.items.some(Boolean));
      if (command.returning || !replacement && !this.#cleanupAllowsHandoff(command.to) && (!effect || !/对手|对方|双方/.test(effect))) throw new ApiError('OUTSIDE_HUMAN_INTENT', '当前行动没有需要交给该席位处理的卡文或结算记录');
    }
    if (command.kind === 'set_turn' && !['attack', 'end_turn'].includes(state.input.intent.kind)) throw new ApiError('OUTSIDE_HUMAN_INTENT', '当前行动不能自行结束回合');
    if (command.kind === 'set_turn' && command.phase === 'turn') {
      this.#validateChoices();
      if (this.match.state.flow.phase !== 'check') throw new ApiError('CHECK_REQUIRED', '交给下一回合前必须先进入并完成宝可梦检查');
      if (command.playerId === playerId) {
        if (!effect || !/额外.{0,8}回合|再(?:进行|开始).{0,8}回合/.test(effect)) throw new ApiError('INVALID_NEXT_TURN', '完成检查后必须交给对手；额外回合须有本次实际卡文明确授权');
        authorization.extraTurn = true;
      }
      if (state.input.intent.kind === 'attack' && !this.#attackStarted()) throw new ApiError('HUMAN_ACTION_INCOMPLETE', '尚未执行本次指定招式，不能直接跳到下一回合');
    }
    if (command.kind === 'set_state' && (command.target.kind === 'group' || command.target.kind === 'card') && !authorizedAt(command.target.position)) {
      const item = at(this.match.view(playerId), command.target.position);
      const ownEffects = item?.kind === 'group' ? [...item.stack.slice(-1), ...item.attached].flatMap(member => member.kind === 'card' ? turnStartTexts(member.card) : []) : item?.kind === 'card' ? turnStartTexts(item.card) : [];
      const forcedStart = state.input.intent.kind === 'turn_start' && Boolean(effect && ownEffects.includes(effect) && /这只宝可梦|此宝可梦|自身|附有此卡的宝可梦/u.test(effect) && !/选择|任意|最多|至多|可以|可选择/u.test(effect));
      const mandatory = forcedStart || this.#checkTarget(command.target.position) && item?.kind === 'group' && (command.field.key === 'damageCounters' && item.state.specialConditions.some(condition => ['poisoned', 'burned'].includes(condition)) && command.field.value >= item.state.damageCounters
        || command.field.key === 'specialConditions' && command.field.value.every(condition => item.state.specialConditions.includes(condition)));
      if (!mandatory) throw new ApiError('UNCONFIRMED_TARGET', '状态目标尚未由人选择；检查授权仅限双方战斗宝可梦的必要伤害和已有特殊状态处理');
    }
    if (command.kind === 'set_state' && (command.target.kind === 'group' || command.target.kind === 'card')) {
      const scope = this.#quantityScope(command);
      const referencedNumber = request.choiceIds.some(id => state.answers.some(answer => answer.choice.id === id && answer.choice.kind === 'number'));
      if (scope && (referencedNumber || !this.#checkTarget(command.target.position))) this.#quantity(request, scope, this.#quantityCount(command), false, authorization);
      const targetId = identity(this.match, command.target.position);
      for (const answer of state.answers.filter(answer => answer.choice.kind === 'order' && answer.resolution?.kind === 'state' && !answer.invalidated && targetId && answer.identities.includes(targetId))) {
        if (!request.choiceIds.includes(answer.choice.id)) throw new ApiError('UNCONFIRMED_CHOICE', '状态处理顺序必须引用玩家已确认的choiceId');
        const executed = answer.executed ?? [];
        if (answer.identities[executed.length] !== targetId && executed.at(-1) !== targetId) throw new ApiError('HUMAN_ORDER_NEXT_REQUIRED', '只能继续当前目标或进入玩家已确认的下一目标，不能返回已经离开的目标');
      }
    }
    if (command.kind === 'set_state' && command.target.kind === 'zone' && (!command.target.zoneId.startsWith(`${playerId}:`) || command.field.key === 'visibility') && !effect) throw new ApiError('UNBOUND_CARD_EFFECT', '区域状态变化必须由本次卡文明确授权');
    if (command.kind === 'set_state' && command.target.kind === 'player' && command.target.playerId !== playerId && !effect) throw new ApiError('UNCONFIRMED_TARGET', '玩家状态目标尚未由人选择');
    if (command.kind === 'random') {
      const intent = state.input.intent;
      const source = 'source' in intent && intent.source ? at(this.match.view(playerId), intent.source) : null;
      const checking = ['attack', 'end_turn'].includes(intent.kind) && this.match.state.flow.phase === 'check' && this.match.view(playerId).zones.some(zone => zone.kind === 'active' && zone.items.some(item => item?.kind === 'group' && item.state.specialConditions.some(condition => ['asleep', 'burned'].includes(condition))));
      const inherent = command.mode === 'coins' && command.count === 1 && (intent.kind === 'attack' && this.match.state.flow.phase === 'turn' && source?.kind === 'group' && source.state.specialConditions.includes('confused') || checking);
      if (!inherent && (!effect || !/硬币|随机|正面|反面/.test(effect))) throw new ApiError('UNBOUND_CARD_EFFECT', '随机操作必须属于当前卡文或必要检查');
      if (!inherent || request.effectStep || request.choiceIds.some(id => state.answers.some(answer => answer.choice.id === id && answer.choice.kind === 'number'))) this.#quantity(request, this.#quantityScope(command)!, command.count, !inherent, authorization);
    }
    if (command.kind === 'create_group' && (command.destination.container.kind !== 'zone' || !locations.has(`${command.destination.container.zoneId}/${command.destination.index}`))) throw new ApiError('UNCONFIRMED_TARGET', '放置位置尚未由人选择');
    if (command.kind === 'remove_group' && !authorizedAt(command.position) && !locations.has(location(command.position)) && !this.#checkTarget(command.position)) throw new ApiError('UNCONFIRMED_TARGET', '移除目标不属于当前行动');
    if (command.kind === 'move' || command.kind === 'look' || command.kind === 'show' || command.kind === 'shuffle') {
      const selection: Selection = command.kind === 'move' ? command.source : command.selection;
      const container = selection.container;
      const zoneId = container.kind === 'zone' ? container.zoneId : container.position.zoneId;
      const zone = this.match.state.zones[zoneId];
      if (!zone) throw new ApiError('INVALID_ZONE', '操作区域不存在');
      if ((command.kind === 'look' || command.kind === 'show') && zone.playerId && zone.playerId !== playerId && (!effect || !/对手|对方|双方/.test(effect))) throw new ApiError('HIDDEN_INFORMATION', '本次卡文没有授权查看或展示对方隐藏区域', 403);
      if (command.kind === 'look' && (!effect || !(/查看|看|翻开|翻出/.test(effect) || /牌库|手牌|奖赏卡/.test(effect) && /选择|检索|找出|搜寻/.test(effect)))) throw new ApiError('UNBOUND_CARD_EFFECT', '查看隐藏牌必须由当前卡文明确授权');
      const selected = resolveSelection(this.match.state, selection);
      if (command.kind === 'shuffle' && (!effect || !/洗|打乱/.test(effect))) throw new ApiError('UNBOUND_CARD_EFFECT', '洗牌必须属于本次卡文的必要处理');
      if (command.kind === 'move' || command.kind === 'show') {
        const starting = state.input.intent.kind === 'turn_start';
        const ids = selected.map(ref => `${ref.kind}:${ref.id}`);
        const chosenCards = this.#chosenReadableCards(request.choiceIds, ids, zoneId);
        const blindDraw = command.kind === 'move' && (zoneId === `${playerId}:deck` || mechanical.draw) && command.destination.container.kind === 'zone' && (command.destination.container.zoneId === `${zone.playerId}:hand` || starting && command.destination.container.zoneId === `${playerId}:staging`) && selection.range.mode === 'range' && selection.range.start === 0 && !chosenCards;
        if (blindDraw && (state.input.intent.kind === 'draw' || starting) && this.#movements().some(item => item.command.source.container.kind === 'zone' && item.command.source.container.zoneId === `${playerId}:deck`)) throw new ApiError('HUMAN_ACTION_ALREADY_APPLIED', '本次抽牌已经执行，不能重复抽取');
        const mechanicalDraw = mechanical.draw || blindDraw && ((state.input.intent.kind === 'draw' || starting) && selected.length === 1 || Boolean(effect && /抽|补充手牌/.test(effect)));
        const knockoutCleanup = command.kind === 'move' && container.kind === 'group' && (authorizedAt(container.position) || this.#checkTarget(container.position)) && this.#knockedOut(container.position) && command.destination.container.kind === 'zone' && command.destination.container.zoneId === `${zone.playerId}:discard`;
        const wholeContainer = selection.range.mode === 'all' && (knockoutCleanup || Boolean(effect && /所有|全部|整副|整叠|整手/.test(effect)));
        if (blindDraw && !mechanicalDraw) throw new ApiError('OUTSIDE_HUMAN_INTENT', '当前行动没有授权额外抽牌');
        const subsetChoices = state.answers.filter(answer => !answer.invalidated && answer.choice.kind !== 'number' && answer.identities.length && (request.choiceIds.includes(answer.choice.id)
          || answer.choice.options.some(option => option.position && (option.position.member ? this.#containerKey({ kind: 'group', position: { zoneId: option.position.zoneId, index: option.position.index }, relation: option.position.member.relation }) : `zone:${option.position.zoneId}`) === this.#containerKey(container)) && answer.identities.some(id => ids.includes(id) && (answer.choice.kind === 'order' || !answer.consumed.includes(id)))));
        if (!knockoutCleanup && !mechanical.remainder && subsetChoices.length && ids.some(id => !authorized.has(id))) throw new ApiError('UNCONFIRMED_SELECTION', '整区或盲抽快捷不能覆盖本来源已由人确认的卡牌子集');
        this.#quantity(request, this.#quantityScope(command)!, selected.length, mechanicalDraw && !['draw', 'turn_start'].includes(state.input.intent.kind) || wholeContainer && !knockoutCleanup, authorization);
        if (command.kind === 'move') for (const answer of state.answers.filter(answer => request.choiceIds.includes(answer.choice.id) && answer.choice.kind === 'order' && answer.identities.some(id => ids.includes(id)))) {
          const destination = command.destination.container;
          const targetZone = this.match.state.zones[destination.kind === 'zone' ? destination.zoneId : destination.position.zoneId];
          // 暂存只是机械步骤，不消耗选牌授权，也不改变最终排序目标。
          if (targetZone?.kind !== 'staging' && (!answer.orderDestination || answer.orderDestination.inferred && this.#containerKey(answer.orderDestination.container) !== this.#containerKey(destination))) {
            authorization.orders.push({ choiceId: answer.choice.id, destination: this.#bindOrderDestination(command.destination) });
          }
        }
        if (!mechanicalDraw && !wholeContainer && selected.some(ref => !authorized.has(`${ref.kind}:${ref.id}`))) throw new ApiError('UNCONFIRMED_SELECTION', '必须先由人选择这些卡牌');
        if (state.input.intent.kind === 'draw' && (!blindDraw || selected.length !== 1)) throw new ApiError('OUTSIDE_HUMAN_INTENT', '本次抽牌只允许从牌库顶部抽取一张');
      }
      if (command.kind === 'move') {
        const destination = command.destination.container;
        if (state.input.intent.kind === 'turn_start' && zone.kind === 'staging' && (destination.kind !== 'zone' || destination.zoneId !== `${playerId}:hand`) && !effect) throw new ApiError('UNBOUND_CARD_EFFECT', '开局顶牌只能加入手牌，其他去向须有本次实际卡文授权');
        if (destination.kind === 'group' && !authorizedAt(destination.position) && !locations.has(location(destination.position))) throw new ApiError('UNCONFIRMED_TARGET', '附着或进化目标尚未由人选择');
        if (destination.kind === 'zone') {
          const target = this.match.state.zones[destination.zoneId];
          if (!target || target.contents.layout === 'slots' && (command.destination.index === 'end' || !locations.has(`${destination.zoneId}/${command.destination.index}`))) throw new ApiError('UNCONFIRMED_TARGET', '放置目标尚未由人选择');
          if (zone.kind === 'bench' && target.kind === 'active' && state.input.intent.kind !== 'retreat' && !mechanical.switch) {
            const humanChosen = new Set(state.answers.filter(answer => request.choiceIds.includes(answer.choice.id)).flatMap(answer => answer.identities));
            const explicitPromotion = state.input.intent.kind === 'resolve_handoff' && state.input.intent.source ? state.initialIdentities[0] : null;
            if (selected.some(ref => !humanChosen.has(`${ref.kind}:${ref.id}`) && `${ref.kind}:${ref.id}` !== explicitPromotion)) throw new ApiError('UNCONFIRMED_TARGET', '新战斗宝可梦必须由其玩家选择');
          }
        }
      }
    }
    authorization.choices = this.#choiceUses(request);
    return authorization;
  }
  async #executePending(): Promise<void> {
    const state = this.#state!, pending = state.pending!;
    const consumed = pending.consumedIdentities;
    const receipt = await this.match.command(state.view.playerId, { requestId: pending.requestId, revision: pending.revision, command: pending.command }, { id: state.view.id, label: state.view.label });
    if (pending.sequenceIndex === undefined) state.messages.push({ type: 'function_call_output', call_id: pending.callId, output: JSON.stringify(receipt) });
    else if (state.sequence?.callId === pending.callId) {
      state.sequence.receipts.push(receipt); state.sequence.next = pending.sequenceIndex + 1;
      if (receipt.status !== 'committed' || ['look', 'random', 'shuffle', 'handoff'].includes(pending.command.kind)) state.sequence.stopped = true;
    }
    if (receipt.status === 'committed') {
      state.failures = 0;
      const visit = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        const item = field(value);
        if (item.position && item.card && typeof field(item.card).name === 'string') {
          const position = item.position as Position, id = identity(this.match, position);
          if (id) state.revealed.push({ position, card: item.card as CardData, identity: id, stamp: zoneStamp(this.match, position.zoneId) });
        }
        for (const [name, child] of Object.entries(item)) if (name !== 'card') visit(child);
      };
      visit(receipt.result);
      if (pending.command.kind === 'shuffle') {
        const container = pending.command.selection.container;
        const zoneId = container.kind === 'zone' ? container.zoneId : container.position.zoneId;
        state.revealed = state.revealed.filter(item => item.position.zoneId !== zoneId);
        for (const answer of state.answers) if (answer.choice.options.some(option => answer.selected.includes(option.id) && option.position?.zoneId === zoneId && answer.identities.some(id => !answer.consumed.includes(id)))) answer.invalidated = true;
      }
      for (const answer of state.answers) for (const id of consumed) if (answer.identities.includes(id) && !answer.consumed.includes(id)) answer.consumed.push(id);
      for (const use of pending.authorization?.quantities ?? []) {
        const answer = state.answers.find(answer => answer.choice.id === use.choiceId);
        if (answer && !answer.quantityUses?.some(previous => previous.scope === use.scope)) (answer.quantityUses ??= []).push(use);
      }
      for (const binding of pending.authorization?.orders ?? []) {
        const answer = state.answers.find(answer => answer.choice.id === binding.choiceId);
        if (answer) answer.orderDestination = binding.destination;
      }
      if (pending.authorization?.extraTurn) state.extraTurnGranted = true;
      for (const use of pending.authorization?.steps ?? []) if (!state.effectStepUses?.includes(use)) (state.effectStepUses ??= []).push(use);
      this.#recordChoiceUses(pending.authorization?.choices ?? []);
      this.#restoreQuantityUses();
      if (state.view.recovery) state.view.recovery.phase = 'continuing';
      // 新建卡牌组的身份由执行端绑定，模型不能自行创造授权对象。
      if (pending.command.kind === 'create_group' && pending.command.destination.container.kind === 'zone') {
        const position = { zoneId: pending.command.destination.container.zoneId, index: pending.command.destination.index };
        const id = identity(this.match, position); if (id) { state.initialIdentities.push(id); for (const binding of state.mechanicalPlacements ?? []) if (key(binding.target) === key(position) && !binding.groupId) binding.groupId = id; }
      }
      if (state.input.intent.kind === 'turn_start' && pending.command.kind === 'move' && pending.command.source.container.kind === 'zone' && pending.command.source.container.zoneId === `${state.view.playerId}:deck`) {
        state.initialIdentities.push(...consumed.filter(id => !state.initialIdentities.includes(id)));
        if (pending.command.destination.container.kind === 'zone') {
          const destinationId = pending.command.destination.container.zoneId;
          for (const item of this.match.view(state.view.playerId).zones.find(zone => zone.id === destinationId)?.items ?? []) {
            if (item?.kind === 'card' && consumed.includes(identity(this.match, item.position)!)) for (const effect of turnStartTexts(item.card)) if (!state.effectTexts.includes(effect)) state.effectTexts.push(effect);
          }
        }
      }
    } else state.failures++;
    state.pending = null; await this.#save();
  }
  async #executeSequence(signal: AbortSignal): Promise<void> {
    const state = this.#state!, sequence = state.sequence!;
    while (!signal.aborted && !sequence.stopped && sequence.next < sequence.steps.length) {
      if (this.match.state.flow.operator !== state.view.playerId || this.match.state.flow.phase === 'finished') { sequence.stopped = true; break; }
      const request = sequence.steps[sequence.next]!;
      try {
        const authorization = this.#guard(request);
        if (signal.aborted) return;
        state.pending = { requestId: `human:${state.view.id}:${uid()}`, revision: this.match.state.revision, command: request.command, callId: sequence.callId, sequenceIndex: sequence.next,
          consumedIdentities: request.command.kind === 'move' ? resolveSelection(this.match.state, request.command.source).map(ref => `${ref.kind}:${ref.id}`) : [], authorization };
        await this.#save(); await this.#executePending();
      } catch (error) {
        if (this.match.storageFaulted || state.pending) throw error;
        sequence.receipts.push({ status: 'rejected', reason: error instanceof Error ? error.message : '工具参数无效' }); sequence.stopped = true; state.failures++;
      }
    }
    if (signal.aborted) { await this.#save(); return; }
    let completed = false;
    const lastReceipt = field(sequence.receipts.at(-1));
    // 末尾洗牌只关闭本次牌序知识，且后面已无步骤；完成校验无需再作一次模型往返。
    const terminalShuffle = sequence.next === sequence.steps.length && sequence.steps.at(-1)?.command.kind === 'shuffle' && lastReceipt.status === 'committed';
    if (sequence.finish && (!sequence.stopped || terminalShuffle) && sequence.next === sequence.steps.length) {
      try { this.#validateCompletion(); completed = true; }
      catch (error) { sequence.receipts.push({ status: 'rejected', reason: error instanceof Error ? error.message : '行动尚未完成' }); state.failures++; }
    }
    state.messages.push({ type: 'function_call_output', call_id: sequence.callId, output: JSON.stringify({ status: completed ? 'completed' : sequence.stopped ? 'stopped' : 'executed', executedSteps: sequence.next, receipts: sequence.receipts }) });
    delete state.sequence;
    if (completed) { state.view.status = 'completed'; this.#unlock(); }
    await this.#save(); if (completed) this.options.wake();
  }
  async #drive(signal: AbortSignal): Promise<void> {
    const state = this.#state!;
    const trace = new JsonlTrace(join(this.match.directory, 'human-agent-trace.jsonl'), new SecretRedactor());
    const model = this.options.modelFactory(this.match.meta.model, trace);
    try {
      for (let turn = 0; turn < 64; turn++) {
        if (signal.aborted) return;
        if (state.pendingRecovery) await this.#executeRecovery();
        if (state.pending) await this.#executePending();
        if (state.sequence) await this.#executeSequence(signal);
        if (signal.aborted) return;
        if (state.view.status !== 'running') return;
        if (state.input.intent.kind === 'turn_start' && state.turnStart && !state.turnStart.requiresReview) {
          if (!humanTurnStart(this.match, state.view.playerId)?.drew) {
            const deck = this.match.state.zones[`${state.view.playerId}:deck`]!;
            const command: GameCommand = deck.contents.items.length ? { kind: 'move', source: { container: { kind: 'zone', zoneId: deck.id }, range: { mode: 'range', start: 0, count: 1 } }, destination: { container: { kind: 'zone', zoneId: `${state.view.playerId}:hand` }, index: 'end' } }
              : { kind: 'report_result', result: { kind: 'win', winner: state.view.playerId === 'A' ? 'B' : 'A', reason: '回合开始时牌库无卡，无法抽牌' } };
            const authorization = this.#guard({ command, choiceIds: [] });
            state.pending = { requestId: `human:${state.view.id}:mandatory-draw`, revision: this.match.state.revision, command, callId: `host:${state.view.id}:mandatory-draw`, consumedIdentities: command.kind === 'move' ? resolveSelection(this.match.state, command.source).map(ref => `${ref.kind}:${ref.id}`) : [], authorization };
            await this.#save(); await this.#executePending();
          }
          this.#validateCompletion(); state.view.status = 'completed'; this.#unlock(); await this.#save(); this.options.wake(); return;
        }
        if (state.failures >= 3) {
          if (await this.#continueRecovery('连续执行被拒绝，需要重新审查整段结算及恢复点')) continue;
          throw new ApiError('CONSECUTIVE_FAILURE_LIMIT', '连续三次执行失败，已保留现场；可重试修正或手动调整');
        }
        if (this.match.state.flow.phase === 'finished' || state.input.intent.kind === 'resolve_handoff' && this.#returned() || ['attack', 'end_turn'].includes(state.input.intent.kind) && this.#turnEnded()) {
          this.#validateCompletion();
          state.view.status = 'completed'; this.#unlock(); await this.#save(); this.options.wake(); return;
        }
        if (this.match.state.flow.operator !== state.view.playerId) { this.#waitingForControl = true; await this.#save(); this.options.wake(); return; }
        if (state.recovery) {
          if ((state.recovery.modelCalls ?? 0) >= 32) throw new ApiError('RECOVERY_MODEL_LIMIT', '本次修正已达到调用上限，已保留现场和具体冲突');
          state.recovery.modelCalls = (state.recovery.modelCalls ?? 0) + 1;
        } else if (state.modelCalls >= 128) throw new ApiError('ACTION_MODEL_LIMIT', '本次行动超过模型调用上限，已保留现场');
        state.modelCalls++;
        const frame = await this.match.observe(this.match.state.id, state.view.playerId, state.cursor);
        state.cursor = frame.cursor;
        const snapshot = field(frame.snapshot);
        const context = { stage: 'human_action', intent: state.input.intent, actionId: state.view.id, revision: frame.revision, snapshot, observations: frame.observations,
          sourceCard: state.sourceCard ?? null, choices: state.answers.map(answer => ({ choiceId: answer.choice.id, kind: answer.choice.kind, selected: answer.selected, invalidated: Boolean(answer.invalidated), ...(answer.number === undefined ? {} : { number: answer.number }) })),
          availableCommands: this.match.tools(state.view.playerId).filter(tool => tool.effect === 'command').map(tool => tool.name),
          ...(state.turnStart ? { turnStart: { ...state.turnStart, drawCompleted: humanTurnStart(this.match, state.view.playerId)?.drew ?? false, instruction: '先处理本回合开始时点。存在加入手牌前效果或不确定待抽牌卡文时，可先将唯一顶牌移入本人staging查看，按卡文完成后入手；固定抽1无需人确认，任何额外可选效果/顺序/目标仍由人选择。' } } : {}) };
        state.messages.push(user(context)); await this.#save();
        await trace.append({ kind: 'human_executor_started', actionId: state.view.id, playerId: state.view.playerId, revision: frame.revision, modelCalls: state.modelCalls });
        const reply = await model.generate({ role: 'player', sessionId: `human:${this.match.state.id}:${state.view.playerId}`, instructions: state.recovery ? `${state.instructions}\n\n${state.recovery.instructions}` : state.instructions,
          input: this.#modelInput(), tools: this.#tools(), signal });
        if (signal.aborted) return;
        state.messages.push(...reply.output);
        if (reply.calls.length !== 1) {
          state.failures++; for (const call of reply.calls) state.messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ status: 'rejected', reason: '每次只能提交一个工具；禁止并行结算或代替人类选择' }) });
          if (!reply.calls.length) state.messages.push(user({ status: 'rejected', reason: '必须调用工具执行、请求选择、完成或停止当前行动。' }));
          await this.#save(); continue;
        }
        const call = reply.calls[0]!, tool = this.#tools().find(candidate => candidate.name === call.name);
        try {
          const args: unknown = JSON.parse(call.arguments);
          if (!tool) throw new ApiError('TOOL_UNAVAILABLE', '当前工具不可用');
          const malformed = validationError(tool.inputSchema, args); if (malformed) throw new ApiError('INVALID_TOOL_ARGUMENTS', malformed);
          if (call.name === 'request_choice') {
            state.view.choice = this.#choice(args as ChoiceRequest); state.choiceCallId = call.callId; state.view.status = 'awaiting_choice'; state.failures = 0; await this.#save(); return;
          }
          if (call.name === 'finish_action') {
            this.#validateCompletion();
            const receipt = { status: 'completed', eventIds: clone(state.view.eventIds) };
            state.messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify(receipt) });
            await trace.append({ kind: 'human_executor_tool_finished', actionId: state.view.id, tool: call.name, callId: call.callId, receipt });
            state.view.status = 'completed'; this.#unlock(); await this.#save(); this.options.wake(); return;
          }
          if (call.name === 'fail_action') {
            const reason = (args as { reason: string }).reason, receipt = { status: 'failed', reason };
            state.messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify(receipt) });
            await trace.append({ kind: 'human_executor_tool_finished', actionId: state.view.id, tool: call.name, callId: call.callId, receipt });
            if (await this.#continueRecovery(reason)) continue;
            throw new ApiError('ACTION_CANNOT_CONTINUE', reason);
          }
          if (call.name === 'restore_action') {
            if (!state.recovery || state.recovery.rollbackCount >= 2) throw new ApiError('RECOVERY_LIMIT', '本次修正的恢复次数已达上限，须核对具体冲突');
            const restore = args as Static<typeof RestoreSchema>;
            if (!humanActionRecoveryPoints(this.match, state.view.playerId, state.view.id).some(point => point.eventId === restore.beforeEventId)) throw new ApiError('RECOVERY_SCOPE_CONFLICT', '恢复点不在当前允许的结算范围内');
            state.pendingRecovery = { ...restore, requestId: `human-recovery:${state.view.id}:${uid()}`, revision: this.match.state.revision, callId: call.callId };
            state.view.recovery = { phase: 'rolling_back', attempt: state.view.recovery?.attempt ?? 1 };
            await this.#save(); await this.#executeRecovery();
          } else
          if (call.name === 'execute_atomic') {
            const request = args as ExecuteRequest, authorization = this.#guard(request);
            if (signal.aborted) return;
            state.pending = { requestId: `human:${state.view.id}:${uid()}`, revision: this.match.state.revision, command: request.command, callId: call.callId,
              consumedIdentities: request.command.kind === 'move' ? resolveSelection(this.match.state, request.command.source).map(ref => `${ref.kind}:${ref.id}`) : [], authorization };
            await this.#save(); await this.#executePending();
          } else if (call.name === 'execute_sequence') {
            const request = args as Static<typeof SequenceSchema>;
            state.sequence = { callId: call.callId, steps: request.steps, finish: request.finish, next: 0, receipts: [] };
            await this.#save(); await this.#executeSequence(signal);
            if (state.view.status !== 'running') return;
          } else {
            const receipt = await this.match.execute({ matchId: this.match.state.id, playerId: state.view.playerId, requestId: uid(), revision: this.match.state.revision, tool: call.name, arguments: asJson(args) });
            state.messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify(receipt) }); await this.#save();
          }
        } catch (error) {
          if (error instanceof ApiError && error.code === 'ACTION_CANNOT_CONTINUE') throw error;
          if (this.match.storageFaulted || state.pending || state.pendingRecovery) throw error;
          state.failures++;
          state.messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ status: 'rejected', reason: error instanceof Error ? error.message : '工具参数无效' }) }); await this.#save();
        }
      }
      throw new ApiError('ACTION_STEP_LIMIT', '本次行动超过执行步数上限，已保留现场');
    } finally { await trace.flush(); }
  }
  cancel(): void { this.#driver?.controller.abort(); }
  async close(): Promise<void> { this.#closed = true; this.match.changes.off('change', this.#changed); this.cancel(); await this.#driver?.promise; await this.#preparingTurn?.catch(() => {}); await this.#queue.catch(() => {}); }
}
