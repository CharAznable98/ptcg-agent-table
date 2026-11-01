import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentRuntime, FileSessionStore, JsonlTrace, SecretRedactor, createModel, loadModelConfig, loadPrompts, parsePrompts, validationError, ModelConfigSchema, renderPolicy, strategyScope, validatePolicy } from '../../../packages/agent/src/index.ts';
import type { ModelConfig, ModelGateway, PromptBundle } from '../../../packages/agent/src/index.ts';
import type { Static, TSchema } from '@sinclair/typebox';
import { DeckSchema, CreateMatchInputSchema, CreateOpponentInputSchema, UpdateOpponentInputSchema, OpponentRecordSchema } from '../../../packages/protocol/src/index.ts';
import type { CreateMatchInput, CreateMatchResponse, DeckData, DeckRecord, OpponentRecord, PlayerId, PlayerSpec, PromptConfig, StrategyVersion } from '../../../packages/protocol/src/index.ts';
import { ApiError, atomicJson, clone, JsonRepository, now, readJson, uid } from './storage.ts';
import { asJson, MatchRuntime } from './match.ts';
import { Evaluations } from './evaluations.ts';
import { runtimeFingerprint } from './runtime-fingerprint.ts';
import { HumanActionController } from './human-actions.ts';

function checked<T>(schema: TSchema, value: unknown, code: string): T { const error = validationError(schema, value); if (error) throw new ApiError(code, error); return clone(value as T); }

export interface ServiceOptions { dataDir?: string; systemDir?: string; rulesDir?: string; modelFactory?: (config: ModelConfig, trace: JsonlTrace) => ModelGateway }
export class GameService {
  readonly evaluations: Evaluations;
  runtimeHash = '';
  readonly dataDir: string; readonly systemDir: string; readonly rulesDir: string;
  readonly decks: JsonRepository<DeckRecord>; readonly opponents: JsonRepository<OpponentRecord>; readonly matches = new Map<string, MatchRuntime>();
  readonly modelFactory: NonNullable<ServiceOptions['modelFactory']>;
  readonly drivers = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly humanControllers = new Map<string, HumanActionController>();
  #humanSubscriptions = new Map<MatchRuntime, () => void>();
  #humanTasks = new Set<Promise<void>>();
  #closing = false;
  rules: { id: string; title: string; text: string }[] = [];
  #opponentQueue: Promise<unknown> = Promise.resolve();
  constructor(options: ServiceOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? 'data'); this.systemDir = resolve(options.systemDir ?? 'system'); this.rulesDir = resolve(options.rulesDir ?? 'rules');
    this.decks = new JsonRepository(join(this.dataDir, 'decks')); this.opponents = new JsonRepository(join(this.dataDir, 'opponents'));
    this.modelFactory = options.modelFactory ?? ((config, trace) => createModel(config, trace, trace.redactor));
    this.evaluations = new Evaluations(this);
  }
  async init(): Promise<void> {
    this.runtimeHash = await runtimeFingerprint();
    await mkdir(join(this.dataDir, 'matches'), { recursive: true }); await mkdir(this.systemDir, { recursive: true });
    this.rules = await Promise.all(['规则基准','卡牌说明文语义','赛场规则摘要'].map(async name => ({ id: name, title: name, text: await readFile(join(this.rulesDir, `${name}.md`), 'utf8') })));
    for (const id of await readdir(join(this.dataDir, 'matches'))) {
      const match = new MatchRuntime({ directory: join(this.dataDir, 'matches', id) });
      try { await match.recover(); match.rulesText = match.meta.rules; this.matches.set(id, match); for (const player of match.state.players) if (player.kind === 'human') await this.humanController(match, player.id).recover(); this.#watchHumanTurns(match, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; }
    }
  }
  rulesText(): string { return this.rules.map(rule => `# ${rule.title}\n${rule.text}`).join('\n\n'); }
  match(id: string): MatchRuntime { const match = this.matches.get(id); if (!match) throw new ApiError('NOT_FOUND', '对局不存在', 404); return match; }
  humanController(match: MatchRuntime, playerId = match.humanPlayer(match.defaultViewer())): HumanActionController {
    const key = `${match.state.id}:${playerId}`;
    let controller = this.humanControllers.get(key);
    if (!controller) {
      controller = new HumanActionController({ match, playerId, modelFactory: this.modelFactory, prompts: () => this.prompts(), wake: () => this.wake(match) });
      this.humanControllers.set(key, controller);
    }
    return controller;
  }
  #watchHumanTurns(match: MatchRuntime, prepareInitially = true): void {
    if (this.#humanSubscriptions.has(match) || !match.state.players.some(player => player.kind === 'human')) return;
    let queued = false;
    const changed = () => {
      if (queued || this.#closing) return; queued = true;
      queueMicrotask(() => {
        queued = false;
        if (this.#closing) return;
        const task = this.prepareHumanTurn(match).catch(async error => {
          if (!this.#closing && !match.storageFaulted) {
            try { await match.updateRuntime({ status: 'aborted', error: error instanceof Error ? error.message : '回合开始处理失败' }); }
            catch { /* 日志写入故障已由 MatchRuntime 锁停，不能再产生未收敛的后台写入。 */ }
          }
        });
        this.#humanTasks.add(task); void task.finally(() => this.#humanTasks.delete(task));
      });
    };
    this.#humanSubscriptions.set(match, changed); match.changes.on('change', changed);
    // 恢复历史只注册后续变化监听；启动、列表和只读回放不能推进闲置对局。
    if (prepareInitially) changed();
  }
  async prepareHumanTurn(match: MatchRuntime): Promise<void> {
    if (this.#closing) return;
    await match.serial(async () => {});
    if (this.#closing) return;
    const player = match.state.players.find(player => player.kind === 'human' && player.id === match.state.flow.operator && player.id === match.state.flow.turnOwner);
    if (player) await this.humanController(match, player.id).ensureTurnStart();
  }
  validateDeck(deck: unknown): DeckData { const error = validationError(DeckSchema, deck); if (error) throw new ApiError('INVALID_DECK', error); return clone(deck as DeckData); }
  async saveDeck(deck: unknown, id?: string): Promise<DeckRecord> { const data = this.validateDeck(deck); const previous = id ? await this.decks.get(id) : null; return this.decks.save({ id: id ?? uid(), deck: data, createdAt: previous?.createdAt ?? now(), updatedAt: now() }); }
  async #resolveDeck(input: { deck?: DeckData; deckId?: string; opponentId?: string }): Promise<DeckData> {
    if (input.opponentId) return this.validateDeck((await this.opponents.get(input.opponentId)).deck);
    if (input.deck) return this.validateDeck(input.deck);
    if (input.deckId) return this.validateDeck((await this.decks.get(input.deckId)).deck);
    throw new ApiError('DECK_REQUIRED', '请提供卡组或 AI 对手');
  }
  async createOpponent(raw: unknown): Promise<OpponentRecord> {
    const input = checked<Static<typeof CreateOpponentInputSchema>>(CreateOpponentInputSchema, raw, 'INVALID_OPPONENT');
    const deck = await this.#resolveDeck(input);
    if (input.strategy !== undefined && typeof input.strategy !== 'string') throw new ApiError('INVALID_STRATEGY', '策略必须是文本');
    const id = uid();
    const runtime = await this.#initializationRuntime(id);
    const update = await runtime.initializeStrategy({ deck: asJson(deck), rules: this.rulesText(), sessionId: `opponent:${id}:initialize:1`,
      ...(input.strategy?.trim() ? { previous: { version: 1, content: input.strategy } } : {}) });
    return this.opponents.save({ schemaVersion: 1, id, ...(input.name === undefined ? {} : { name: input.name }), deck,
      strategies: [{ version: 1, content: update.strategy, policy: update.policy!, changeSummary: update.changeSummary, evidenceRefs: [], createdAt: now(), source: { kind: 'initial' } }] });
  }
  async #initializationRuntime(id: string): Promise<AgentRuntime> {
    const directory = join(this.dataDir, 'strategy-initializations', id), trace = new JsonlTrace(join(directory, 'agent-trace.jsonl'));
    const config = await this.modelConfig(), prompts = await this.prompts();
    return new AgentRuntime({ model: this.modelFactory(config, trace), trace, store: new FileSessionStore(join(directory, 'contexts')),
      match: new MatchRuntime({ directory: join(directory, 'unused-match') }), prompts: { ...prompts, version: prompts.version! } });
  }
  async updateOpponent(id: string, raw: unknown): Promise<OpponentRecord> {
    const input = checked<Static<typeof UpdateOpponentInputSchema>>(UpdateOpponentInputSchema, raw, 'INVALID_OPPONENT');
    return this.opponentSerial(async () => {
      const opponent = await this.opponents.get(id); if (input.name !== undefined) { if (typeof input.name !== 'string') throw new ApiError('INVALID_NAME', '名称必须是文本'); opponent.name = input.name; }
      if (input.deck !== undefined) opponent.deck = this.validateDeck(input.deck);
      if (input.strategy !== undefined) { if (typeof input.strategy !== 'string') throw new ApiError('INVALID_STRATEGY', '策略必须是文本'); const latest = opponent.strategies.at(-1)!; opponent.strategies.push({ version: latest.version + 1, content: input.strategy, createdAt: now(), source: { kind: 'user_edit' }, previousVersion: latest.version }); }
      return this.opponents.save(opponent);
    });
  }
  async importOpponent(input: unknown): Promise<OpponentRecord> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('INVALID_OPPONENT', 'AI 对手必须是 JSON 对象');
    if (!Object.hasOwn(input, 'strategies')) return this.createOpponent(input);
    const value = checked<OpponentRecord>(OpponentRecordSchema, input, 'INVALID_OPPONENT');
    if (value.strategies.some((version, index) => version.version !== index + 1 || version.previousVersion !== undefined && version.previousVersion !== index)) throw new ApiError('INVALID_STRATEGY_HISTORY', '策略版本必须从 1 连续排列，previousVersion 必须引用前一版本');
    for (const version of value.strategies) if (version.policy) validatePolicy(version.policy);
    const updateIds = value.strategies.flatMap(version => version.updateId ? [version.updateId] : []);
    if (new Set(updateIds).size !== updateIds.length) throw new ApiError('INVALID_STRATEGY_HISTORY', '策略更新标识不得重复');
    return this.opponents.save({ schemaVersion: 1, id: uid(), ...(value.name === undefined ? {} : { name: value.name }), deck: value.deck, strategies: value.strategies, origin: { opponentId: value.id } });
  }

  opponentSerial<T>(action: () => Promise<T>): Promise<T> { const next = this.#opponentQueue.then(action); this.#opponentQueue = next.catch(() => {}); return next; }
  async prompts(): Promise<PromptConfig> {
    const configured = await readJson<PromptConfig>(join(this.systemDir, 'prompts.json'));
    if (configured) return parsePrompts(configured);
    const bundle = await loadPrompts(); const enhanced = bundle as PromptBundle & { toolDescriptions?: Record<string,string>; feedback?: Record<string,string> };
    return { schemaVersion: 1, player: bundle.player, judge: bundle.judge, summary: bundle.summary, compactor: bundle.compactor, ...(bundle.humanExecutor ? { humanExecutor: bundle.humanExecutor } : {}), toolDescriptions: enhanced.toolDescriptions ?? {}, feedback: enhanced.feedback ?? {}, version: bundle.version };
  }
  async savePrompts(input: unknown): Promise<PromptConfig> {
    let result: PromptBundle; try { result = parsePrompts(input); } catch (error) { throw new ApiError('INVALID_PROMPTS', error instanceof Error ? error.message : '提示词配置格式错误'); }
    await atomicJson(join(this.systemDir, 'prompts.json'), result); return result;
  }
  async modelConfig(): Promise<ModelConfig> {
    const configured = await readJson<ModelConfig>(join(this.systemDir, 'agent.json'));
    if (configured) return configured;
    try { return await loadModelConfig(join(this.systemDir, 'agent.example.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { schemaVersion: 1, model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, connection: { kind: 'local_codex_credentials' } }; }
  }
  async saveModel(input: unknown): Promise<ModelConfig> { const error = validationError(ModelConfigSchema, input); if (error) throw new ApiError('INVALID_MODEL_CONFIG', error); const value = input as ModelConfig; await atomicJson(join(this.systemDir, 'agent.json'), value); return clone(value); }
  async testModel(): Promise<Record<string, unknown>> {
    const start = Date.now();
    try { const config = await this.modelConfig(); const trace = new JsonlTrace(join(this.dataDir, 'model-tests.jsonl')); const model = this.modelFactory(config, trace); const reply = await model.generate({ role: 'player', sessionId: `connection-test:${uid()}`, instructions: (await this.prompts()).feedback.modelTestInstructions!, input: [{ role: 'user', content: (await this.prompts()).feedback.modelTestUser! }], tools: [] }); return { ok: true, model: reply.model, effort: config.reasoningEffort, serviceTier: 'default', elapsedMs: Date.now() - start }; }
    catch (error) { return { ok: false, elapsedMs: Date.now() - start, error: error instanceof Error ? error.message : '连接失败' }; }
  }
  #uniqueOpponents(players: PlayerSpec[]): void {
    const ids = players.filter(player => player.kind === 'ai').map(player => player.opponentId);
    if (new Set(ids).size !== ids.length) throw new ApiError('DUPLICATE_AI_OPPONENT', '同一 AI 对手不能同时占用两个席位；请导入为两名独立 AI 对手');
  }
  async createMatch(raw: unknown): Promise<CreateMatchResponse> {
    const input = checked<CreateMatchInput>(CreateMatchInputSchema, raw, 'INVALID_MATCH');
    const kinds = input.players.map(player => player.kind);
    if (input.mode === 'ai_ai' && kinds.some(kind => kind !== 'ai') || input.mode === 'local' && kinds.some(kind => kind !== 'human') || input.mode === 'human_ai' && kinds.filter(kind => kind === 'human').length !== 1) throw new ApiError('INVALID_MATCH_MODE', '玩家类型与对局模式不符');
    const suppliedDecks = await Promise.all(input.players.map(player => this.#resolveDeck(player)));
    for (let index = 0; index < suppliedDecks.length; index++) if (!suppliedDecks[index]!.cards.some(entry => entry.card.kind === 'pokemon' && entry.card.stage === '基础')) throw new ApiError('NO_BASIC_POKEMON', `${index === 0 ? 'A' : 'B'} 卡组至少需要一张基础宝可梦`);
    const configuredOpponents = input.players.filter(player => player.kind === 'ai' && player.opponentId).map(player => player.opponentId);
    if (new Set(configuredOpponents).size !== configuredOpponents.length) throw new ApiError('DUPLICATE_AI_OPPONENT', '同一 AI 对手不能同时占用两个席位；请导入为两名独立 AI 对手');
    const config = await this.prompts(), model = await this.modelConfig();
    const resolved: PlayerSpec[] = []; const strategies: MatchRuntime['meta']['strategies'] = {};
    for (let i = 0; i < 2; i++) {
      const player = input.players[i]!; const id = i === 0 ? 'A' : 'B'; const deck = suppliedDecks[i]!;
      if (!deck.cards.some(entry => entry.card.kind === 'pokemon' && entry.card.stage === '基础')) throw new ApiError('NO_BASIC_POKEMON', `${id} 卡组至少需要一张基础宝可梦`);
      let opponentId = player.opponentId;
      if (player.kind === 'ai') {
        if (!opponentId) opponentId = (await this.createOpponent({ name: player.name, deck })).id;
        const opponent = await this.opponents.get(opponentId); const latest = opponent.strategies.at(-1)!; strategies[id] = { version: latest.version, content: latest.content, ...(latest.policy ? { policy: clone(latest.policy) } : {}) };
      }
      resolved.push({ id, name: typeof player.name === 'string' && player.name.trim() ? player.name : id, kind: player.kind, deck, ...(opponentId ? { opponentId } : {}) });
    }
    this.#uniqueOpponents(resolved);
    const id = uid(); const match = new MatchRuntime({ directory: join(this.dataDir, 'matches', id) });
    const prompts: PromptBundle = { ...config, version: config.version ?? createHash('sha256').update(JSON.stringify(config)).digest('hex') };
    await match.create({ id, players: resolved as [PlayerSpec,PlayerSpec], mode: input.mode, prompts, model, strategies, rules: this.rulesText() }); match.rulesText = match.meta.rules; this.matches.set(id, match); this.#watchHumanTurns(match);
    if (input.autoRun) this.start(match, false);
    return { match: match.summary() };
  }
  async agent(match: MatchRuntime, oneStep = false, signal?: AbortSignal): Promise<AgentRuntime> {
    this.#uniqueOpponents(match.state.players);
    const redactor = new SecretRedactor(); const trace = new JsonlTrace(join(match.directory, 'agent-trace.jsonl'), redactor); const store = new FileSessionStore(join(match.directory, 'contexts'));
    const gateway = this.modelFactory(match.meta.model, trace);
    const model: ModelGateway = signal ? { generate: request => gateway.generate({ ...request, signal: request.signal ?? signal }) } : gateway;
    const runtime = new AgentRuntime({ model, match, store, trace, prompts: match.meta.prompts, ...(oneStep ? { limits: { maxDecisionsPerActivation: 1, maxActionsPerDecision: 1, maxToolCallsPerActivation: 1 } } : {}) });
    for (const player of match.state.players) if (player.kind === 'ai') {
      const existing = await store.load(match.state.id, player.id);
      if (existing) {
        if (!existing.policyScope || existing.rulesText === undefined) {
          existing.rulesText = match.meta.rules;
          existing.policyScope = strategyScope(existing.deck, match.meta.rules);
          await store.save(existing);
        }
        continue;
      }
      const frozen = match.meta.strategies[player.id]!;
      const expectedScope = strategyScope(player.deck, match.meta.rules);
      const scopeChanged = frozen.policy && (frozen.policy.scope.deckHash !== expectedScope.deckHash || frozen.policy.scope.rulesHash !== expectedScope.rulesHash);
      if (!frozen.policy?.plan?.trim() || scopeChanged) {
        const opponent = await this.opponents.get(player.opponentId!);
        const currentScope = strategyScope(opponent.deck, this.rulesText());
        const isCurrent = currentScope.deckHash === expectedScope.deckHash && currentScope.rulesHash === expectedScope.rulesHash;
        const initialized = isCurrent ? await this.#ensurePolicy(player.opponentId!, runtime, match.meta.rules, player.deck)
          : await runtime.initializeStrategy({ deck: asJson(player.deck), rules: match.meta.rules, previous: frozen, sessionId: `frozen:${match.state.id}:${player.id}` });
        const snapshot = 'version' in initialized ? { version: initialized.version, content: initialized.content, policy: clone(initialized.policy!) }
          : { version: frozen.version, content: initialized.strategy, policy: clone(initialized.policy!) };
        await match.serial(async () => { match.meta.strategies[player.id] = snapshot; await match.saveRuntime(); });
      }
      await runtime.create({ matchId: match.state.id, playerId: player.id, deck: asJson(player.deck), strategy: match.meta.strategies[player.id]!, rules: match.meta.rules });
    }
    return runtime;
  }
  start(match: MatchRuntime, oneStep: boolean): void {
    if (this.drivers.has(match.state.id)) return;
    const controller = new AbortController();
    const promise = this.#drive(match, controller, oneStep).catch(async error => { if (!controller.signal.aborted && !match.storageFaulted) await match.updateRuntime({ status: 'aborted', error: error instanceof Error ? error.message : '运行失败' }); }).finally(() => { this.drivers.delete(match.state.id); });
    this.drivers.set(match.state.id, { controller, promise });
  }
  async control(match: MatchRuntime, action: string): Promise<MatchRuntime['meta']['runtime']> {
    if (!['run','pause','resume','step'].includes(action)) throw new ApiError('INVALID_CONTROL', '无效运行操作');
    if (action === 'pause') { this.drivers.get(match.state.id)?.controller.abort(); await match.updateRuntime({ status: 'paused' }); return clone(match.meta.runtime); }
    if (!this.drivers.has(match.state.id)) { await match.updateRuntime({ status: 'running' }); this.start(match, action === 'step'); }
    return clone(match.meta.runtime);
  }
  wake(match: MatchRuntime): void { if (!this.#closing) { this.#watchHumanTurns(match); if (match.meta.runtime.status === 'waiting' || match.meta.dispute?.status === 'awaiting_judge' || match.state.flow.phase === 'finished' && match.state.players.some(player => player.kind === 'ai')) this.start(match, false); } }
  async #drive(match: MatchRuntime, controller: AbortController, oneStep: boolean): Promise<void> {
    await match.resumeAutomatic();
    if (controller.signal.aborted) return;
    const runtime = await this.agent(match, oneStep, controller.signal);
    for (let cycle = 0; cycle < 4096; cycle++) {
      if (controller.signal.aborted) return;
      if (match.meta.dispute?.status === 'awaiting_judge') {
        await match.updateRuntime({ status: 'running' });
        const decision = await runtime.judge({ matchId: match.state.id, disputeId: match.meta.dispute.id, ...match.judgeInput(), ruleRefs: this.rules.map(rule => rule.id), rules: match.meta.rules }, decision => match.validateJudge(decision));
        if (controller.signal.aborted) return; await match.applyJudge(decision); if (oneStep) { await match.updateRuntime({ status: 'paused' }); return; } continue;
      }
      if (match.state.flow.phase === 'finished') {
        for (const player of match.state.players) if (player.kind === 'ai') {
          const settled = await runtime.activate(match.state.id, player.id, controller.signal);
          if (controller.signal.aborted) return;
          if (settled.status === 'aborted') throw new Error(settled.reason ?? '终局待定请求未结算');
        }
        await match.updateRuntime({ status: 'completed' }); if (!match.meta.evaluation) await this.#summaries(match, runtime); return;
      }
      const active = match.state.players.find(player => player.kind === 'ai' && match.tools(player.id).length);
      if (!active) { await match.updateRuntime({ status: 'waiting' }); return; }
      await match.updateRuntime({ status: 'running', activePlayer: active.id });
      const result = await runtime.activate(match.state.id, active.id, controller.signal);
      if (controller.signal.aborted) return;
      if (oneStep) { await match.updateRuntime({ status: 'paused', ...(result.status === 'aborted' && !['DECISION_BUDGET_EXHAUSTED','ACTION_BUDGET_EXHAUSTED'].includes(result.reason ?? '') ? { error: result.reason ?? '单步失败' } : {}) }); return; }
      if (result.status === 'aborted') { await match.updateRuntime({ status: 'aborted', error: result.reason ?? 'AI 运行中止' }); return; }
    }
    await match.updateRuntime({ status: 'aborted', error: '单局调度预算耗尽' });
  }
  async #ensurePolicy(opponentId: string, runtime: AgentRuntime, rules: string, expectedDeck: DeckData): Promise<StrategyVersion> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const opponent = await this.opponents.get(opponentId), latest = opponent.strategies.at(-1)!;
      if (JSON.stringify(opponent.deck) !== JSON.stringify(expectedDeck) || rules !== this.rulesText()) throw new Error('STRATEGY_SCOPE_CONFLICT');
      const scope = strategyScope(opponent.deck, rules);
      if (latest.policy?.plan?.trim() && latest.policy.scope.deckHash === scope.deckHash && latest.policy.scope.rulesHash === scope.rulesHash) return latest;
      const update = await runtime.initializeStrategy({ deck: asJson(opponent.deck), rules, previous: latest, sessionId: `opponent:${opponent.id}:initialize:${latest.version}` });
      const published = await this.opponentSerial(async () => {
        const current = await this.opponents.get(opponentId);
        if (JSON.stringify(current.deck) !== JSON.stringify(expectedDeck) || rules !== this.rulesText()) throw new Error('STRATEGY_SCOPE_CONFLICT');
        if (current.strategies.at(-1)!.version !== latest.version) return null;
        const version: StrategyVersion = { version: latest.version + 1, previousVersion: latest.version, createdAt: now(),
          source: { kind: 'migration', fromVersion: latest.version }, updateId: `initialization:${opponent.id}:${latest.version}`,
          content: update.strategy, policy: clone(update.policy!), changeSummary: update.changeSummary, evidenceRefs: update.evidenceRefs };
        current.strategies.push(version); await this.opponents.save(current); return version;
      });
      if (published) return published;
    }
    throw new Error('STRATEGY_VERSION_CONFLICT');
  }
  async #summaries(match: MatchRuntime, runtime: AgentRuntime): Promise<void> {
    if (match.meta.evaluation) return;
    await Promise.all(match.state.players.filter(player => player.kind === 'ai' && match.meta.summaries[player.id]?.status !== 'completed').map(async player => {
      await match.serial(async () => { match.meta.summaries[player.id] = { status: 'pending' }; await match.saveRuntime(); });
      try {
        const current = await this.opponents.get(player.opponentId!);
        const frozenScope = strategyScope(player.deck, match.meta.rules), liveScope = strategyScope(current.deck, this.rulesText());
        if (frozenScope.deckHash !== liveScope.deckHash || frozenScope.rulesHash !== liveScope.rulesHash) throw new Error('STRATEGY_SCOPE_CONFLICT');
        const currentPolicy = current.strategies.at(-1)!.policy;
        if (currentPolicy && (currentPolicy.scope.deckHash !== frozenScope.deckHash || currentPolicy.scope.rulesHash !== frozenScope.rulesHash)) throw new Error('STRATEGY_SCOPE_CONFLICT');
        await this.#ensurePolicy(player.opponentId!, runtime, match.meta.rules, player.deck);
        const updateId = `${match.state.id}:${player.id}:${player.opponentId}`;
        let published: StrategyVersion | undefined;
        for (let attempt = 0; attempt < 3 && !published; attempt++) {
          const snapshot = await this.opponents.get(player.opponentId!);
          published = snapshot.strategies.find(strategy => strategy.updateId === updateId);
          if (published) break;
          const latest = snapshot.strategies.at(-1)!;
          // 模型请求在发布锁之外；两名独立 AI 可并行复盘，提交使用版本检查。
          const update = await runtime.summarize(match.state.id, player.id, latest);
          published = await this.opponentSerial(async () => {
            const current = await this.opponents.get(player.opponentId!);
            const existing = current.strategies.find(strategy => strategy.updateId === updateId); if (existing) return existing;
            if (JSON.stringify(current.deck) !== JSON.stringify(player.deck) || this.rulesText() !== match.meta.rules) throw new Error('STRATEGY_SCOPE_CONFLICT');
            if (current.strategies.at(-1)!.version !== latest.version) return undefined;
            const version: StrategyVersion = { version: latest.version + 1, content: update.strategy, ...(update.policy ? { policy: clone(update.policy) } : {}), createdAt: now(), source: { kind: 'match', matchId: match.state.id, playerId: player.id }, updateId, previousVersion: latest.version, changeSummary: update.changeSummary, evidenceRefs: update.evidenceRefs };
            current.strategies.push(version); await this.opponents.save(current); return version;
          });
        }
        if (!published) throw new Error('STRATEGY_VERSION_CONFLICT');
        await match.serial(async () => { match.meta.summaries[player.id] = { status: 'completed', version: published!.version }; await match.saveRuntime(); });
      } catch (error) { await match.serial(async () => { match.meta.summaries[player.id] = { status: 'failed', error: error instanceof Error ? error.message : '总结失败' }; await match.saveRuntime(); }); }
    }));
  }
  cancel(): void { for (const driver of this.drivers.values()) driver.controller.abort(); for (const controller of this.humanControllers.values()) controller.cancel(); }
  async close(): Promise<void> {
    this.#closing = true;
    for (const [match, changed] of this.#humanSubscriptions) match.changes.off('change', changed);
    this.#humanSubscriptions.clear(); this.cancel();
    await Promise.allSettled([...this.drivers.values()].map(driver => driver.promise));
    await Promise.allSettled([...this.humanControllers.values()].map(controller => controller.close()));
    await Promise.allSettled([...this.#humanTasks]);
    await Promise.allSettled([...this.matches.values()].map(match => match.serial(async () => {})));
  }
}
