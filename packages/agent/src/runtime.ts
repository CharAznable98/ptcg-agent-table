import { createHash, randomUUID } from 'node:crypto';
import { Type, type TSchema } from '@sinclair/typebox';
import { DEFAULT_LIMITS, type AgentLimits, type Json, type MatchPort, type ModelGateway, type ModelItem, type ModelRequest, type ModelReply, type PlayerFrame, type PlayerSession, type SessionStore, type StrategySnapshot, type ToolDefinition, type ToolReceipt, type TraceSink } from './types.ts';
import { JudgeDecisionSchema, StrategyInitializationSchema, parseStructured, validationError, type Compression, type JudgeDecision, type StrategyInitialization, type StrategyUpdate } from './schema.ts';
import type { PromptBundle } from './prompts.ts';
import { activeContextBytes, compactionContextBytes, compressionBudget, contextBytes as bytes, linkToolObservations, migrateContext, playerInput, reviewTools, startContextSegment, userMessage as user } from './context.ts';
import { migrateLegacyStrategy, reviewStrategy, type ReviewStructured, type ReviewStage } from './strategy-review.ts';
import { sharedCardContext } from './card-context.ts';
import { sharedEventContext } from './event-context.ts';
import { independentAfterHiddenShuffle, independentAfterNamedSelection, preselectedNamedSelection } from './sequence.ts';
import { decodeActionArguments, modelToolDefinition } from './action-codec.ts';
import { strategyScope, renderPolicy } from './policy.ts';

const sequenceTool = 'execute_sequence';

export interface CreateSession {
  matchId: string;
  playerId: string;
  deck: Json;
  strategy: StrategySnapshot;
  rules: string;
}

export interface JudgeCase {
  matchId: string;
  disputeId: string;
  facts: Json;
  evidenceIds: string[];
  ruleRefs: string[];
  validRestoreTargets: string[];
  /** 只有这些当前有效的结果报告可被裁判明确确认；缺省禁止确认报告。 */
  validReportedResults?: string[];
  /** 本局有权处置的区域，避免裁判输出不存在的对象引用。 */
  zones: { zoneId: string; size: number }[];
  rules: string;
}

export interface ActivationResult {
  status: 'waiting' | 'finished' | 'aborted';
  reason?: string;
  decisions: number;
}

/** 工具循环、上下文、压缩和专用角色在同一模块内封装，模型连接可以替换。 */
export class AgentRuntime {
  readonly model: ModelGateway;
  readonly match: MatchPort;
  readonly store: SessionStore;
  readonly trace: TraceSink;
  readonly prompts: PromptBundle;
  readonly limits: AgentLimits;
  #active = new Set<string>();
  constructor(options: { model: ModelGateway; match: MatchPort; store: SessionStore; trace: TraceSink; prompts: PromptBundle; limits?: Partial<AgentLimits> }) {
    this.model = options.model; this.match = options.match; this.store = options.store; this.trace = options.trace; this.prompts = structuredClone(options.prompts);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('LIMITS_INVALID');
  }
  async create(input: CreateSession): Promise<PlayerSession> {
    if (await this.store.load(input.matchId, input.playerId)) throw new Error('CONTEXT_EXISTS: 继续已有对局请直接 activate');
    const session: PlayerSession = {
      schemaVersion: 1, sessionId: randomUUID(), matchId: input.matchId, playerId: input.playerId,
      instructions: `${this.prompts.player}${this.prompts.feedback.positionEncoding ? `\n\n${this.prompts.feedback.positionEncoding}` : ''}\n\n${this.prompts.feedback.playerRulesHeading}\n${input.rules}`,
      deck: input.deck, strategy: structuredClone(input.strategy), messages: [], observations: [], pendingObservations: [], toolHistory: [], cursor: null, summary: null, pending: null,
      rulesText: input.rules, policyScope: strategyScope(input.deck, input.rules),
      modelCalls: 0, toolCalls: 0, compactions: 0,
      context: { version: 2, observationOffset: 0, toolOffset: 0 }, sequence: null,
    };
    await this.store.save(session);
    await this.trace.append({ kind: 'context_created', sessionId: session.sessionId, matchId: session.matchId, playerId: session.playerId, promptVersion: this.prompts.version, strategyVersion: session.strategy.version });
    return structuredClone(session);
  }
  async #session(matchId: string, playerId: string): Promise<PlayerSession> {
    const session = await this.store.load(matchId, playerId);
    if (!session) throw new Error('CONTEXT_NOT_FOUND');
    // 兼容旧模块上下文：旧版没有投递队列，保守保留所有本人已知观察供下一次推理。
    if (!Array.isArray(session.pendingObservations)) session.pendingObservations = structuredClone(session.observations);
    if (migrateContext(session)) await this.store.save(session);
    return session;
  }
  async #generateForSession(session: PlayerSession, request: ModelRequest): Promise<ModelReply> {
    if (session.modelCalls >= this.limits.maxTotalModelCalls) throw new Error('TOTAL_MODEL_BUDGET_EXHAUSTED');
    // 先占用并保存逻辑调用额度；失败尝试及压缩重试同样消耗额度。
    session.modelCalls++;
    await this.store.save(session);
    return this.model.generate(request);
  }
  async #frame(session: PlayerSession): Promise<PlayerFrame> {
    const frame = await this.match.observe(session.matchId, session.playerId, session.cursor);
    if (frame.matchId !== session.matchId || frame.playerId !== session.playerId) throw new Error('OBSERVATION_SCOPE_MISMATCH');
    const known = new Set(session.observations.map(o => o.id));
    for (const observation of frame.observations) {
      if (!known.has(observation.id)) { session.observations.push(observation); session.pendingObservations.push(observation); known.add(observation.id); }
    }
    session.cursor = frame.cursor;
    await this.store.save(session);
    return frame;
  }
  async #executePending(session: PlayerSession): Promise<ToolReceipt | null> {
    const pending = session.pending;
    if (!pending) return null;
    await this.trace.append({ kind: 'tool_started', sessionId: session.sessionId, request: pending.request });
    // 失败／中断时保留 pending。下一次激活按原 ID、原版本重试，而非生成新意图。
    const receipt = await this.match.execute(pending.request);
    await this.trace.append({ kind: 'tool_finished', sessionId: session.sessionId, requestId: pending.request.requestId, receipt });
    if (pending.sequenceIndex === undefined) session.messages.push({ type: 'function_call_output', call_id: pending.callId, output: JSON.stringify(receipt) });
    else {
      const sequence = session.sequence;
      if (!sequence || sequence.next !== pending.sequenceIndex) throw new Error('CONTEXT_SEQUENCE_MISMATCH');
      sequence.results.push({ index: pending.sequenceIndex, tool: pending.request.tool, receipt });
      sequence.next++; sequence.expectedRevision = receipt.revision;
    }
    session.toolHistory.push({ request: pending.request, receipt });
    session.pending = null;
    session.toolCalls++;
    await this.store.save(session);
    return receipt;
  }
  #playerTools(frame: PlayerFrame): ToolDefinition[] {
    const description = this.prompts.toolDescriptions[sequenceTool];
    if (!description || !frame.tools.length) return frame.tools;
    if (frame.tools.some(tool => tool.name === sequenceTool)) throw new Error('RESERVED_TOOL_NAME');
    if (this.limits.maxActionsPerDecision <= 1) return frame.tools;
    const catalog = frame.toolCatalog ?? frame.tools;
    const action = Type.Union(catalog.map(original => {
      const tool = modelToolDefinition(original);
      return Type.Object({ tool: Type.Literal(tool.name), arguments: tool.inputSchema }, { additionalProperties: false, description: tool.description });
    }));
    return [{ name: sequenceTool, description, effect: 'command', inputSchema: Type.Object({ actions: Type.Array(action, { minItems: 1, maxItems: this.limits.maxActionsPerDecision }) }, { additionalProperties: false }) }];
  }
  async #finishSequence(session: PlayerSession, reason: string, revision: number): Promise<boolean> {
    const sequence = session.sequence!;
    const skipped = sequence.actions.slice(sequence.next).map((action, offset) => ({ index: sequence.next + offset, ...action, status: 'not_executed', reason }));
    const failed = sequence.results.some(result => result.receipt.status === 'rejected');
    const feedback = { status: failed ? 'rejected' : 'committed', revision, results: sequence.results, skipped, stoppedReason: reason };
    session.messages.push({ type: 'function_call_output', call_id: sequence.callId, output: JSON.stringify(feedback) });
    for (const action of skipped) session.toolHistory.push({ sequenceCallId: sequence.callId, ...action });
    await this.trace.append({ kind: 'sequence_finished', sessionId: session.sessionId, callId: sequence.callId, ...feedback });
    session.sequence = null;
    await this.store.save(session);
    return failed;
  }
  async #executeSequence(session: PlayerSession, signal: AbortSignal | undefined, beforeAction: () => void): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) throw new Error('CANCELLED');
      const sequence = session.sequence!;
      if (session.pending) { beforeAction(); await this.#executePending(session); }
      const frame = await this.#frame(session);
      const previous = sequence.results.at(-1)?.receipt;
      if (previous?.status === 'rejected') return this.#finishSequence(session, 'TOOL_REJECTED', frame.revision);
      if (sequence.next === sequence.actions.length) return this.#finishSequence(session, 'COMPLETED', frame.revision);
      if (previous && (previous.status !== 'committed' || previous.continuation !== 'continue')) return this.#finishSequence(session, 'OBSERVATION_REQUIRED', frame.revision);
      if (frame.status !== 'active') return this.#finishSequence(session, 'CONTROL_CHANGED', frame.revision);
      if (frame.revision !== sequence.expectedRevision) return this.#finishSequence(session, 'REVISION_CHANGED', frame.revision);
      const action = sequence.actions[sequence.next]!;
      if (previous?.continuationGuard?.kind === 'named_selection' && !preselectedNamedSelection(action, previous.continuationGuard.zoneIds)) return this.#finishSequence(session, 'OBSERVATION_REQUIRED', frame.revision);
      const shuffledZones = [...new Set(sequence.results.flatMap(result => result.receipt.continuationGuard?.kind === 'hidden_shuffle' ? result.receipt.continuationGuard.zoneIds : []))];
      if (shuffledZones.length && !independentAfterHiddenShuffle(action, shuffledZones, session.playerId)) return this.#finishSequence(session, 'SHUFFLE_DEPENDENCY', frame.revision);
      const namedZones = [...new Set(sequence.results.flatMap(result => result.receipt.continuationGuard?.kind === 'named_selection' ? result.receipt.continuationGuard.zoneIds : []))];
      if (namedZones.length && !independentAfterNamedSelection(action, namedZones, session.playerId)) return this.#finishSequence(session, 'NAMED_SELECTION_DEPENDENCY', frame.revision);
      const tool = frame.tools.find(candidate => candidate.name === action.tool);
      if (!tool || validationError(tool.inputSchema, action.arguments)) return this.#finishSequence(session, 'TOOL_UNAVAILABLE', frame.revision);
      beforeAction();
      session.pending = { callId: sequence.callId, sequenceIndex: sequence.next, request: { matchId: session.matchId, playerId: session.playerId, requestId: randomUUID(), revision: sequence.expectedRevision, tool: action.tool, arguments: action.arguments } };
      await this.store.save(session);
      if (signal?.aborted) throw new Error('CANCELLED');
      await this.#executePending(session);
    }
  }
  async activate(matchId: string, playerId: string, signal?: AbortSignal): Promise<ActivationResult> {
    const key = JSON.stringify([matchId, playerId]);
    if (this.#active.has(key)) throw new Error('ACTIVATION_IN_PROGRESS');
    this.#active.add(key);
    let decisions = 0;
    let failures = 0;
    try {
      const session = await this.#session(matchId, playerId);
      const initialToolCalls = session.toolCalls;
      const beforeAction = () => { if (session.toolCalls - initialToolCalls >= this.limits.maxToolCallsPerActivation) throw new Error('ACTION_BUDGET_EXHAUSTED'); };
      for (;;) {
        if (signal?.aborted) throw new Error('CANCELLED');
        if (session.sequence) await this.#executeSequence(session, signal, beforeAction);
        else if (session.pending) { beforeAction(); await this.#executePending(session); }
        const frame = await this.#frame(session);
        if (frame.status !== 'active') return { status: frame.status, decisions };
        beforeAction();
        if (decisions >= this.limits.maxDecisionsPerActivation) throw new Error('DECISION_BUDGET_EXHAUSTED');
        if (session.modelCalls >= this.limits.maxTotalModelCalls) throw new Error('TOTAL_MODEL_BUDGET_EXHAUSTED');
        // 消息与清空待投递队列在同一次保存中提交；等待／恢复不会吞掉短暂展示信息。
        session.messages.push(user({ revision: frame.revision, observations: session.pendingObservations }));
        session.pendingObservations = [];
        await this.store.save(session);
        if (session.context?.legacySnapshots?.length || compactionContextBytes(session).compressibleBytes > this.limits.compactAfterBytes) await this.#compact(session, signal, true);
        const tools = this.#playerTools(frame);
        const startsSegment = session.context?.wire?.revision == null;
        const input = playerInput(session, frame, this.limits.maxActionsPerDecision, [...frame.tools.map(tool => tool.name), ...(tools.some(tool => tool.name === sequenceTool) ? [sequenceTool] : [])]);
        if (startsSegment) await this.trace.append({ kind: 'context_segment_started', sessionId: session.sessionId, epoch: session.context!.wire!.epoch,
          activeBytes: activeContextBytes(session), wireItems: session.context!.wire!.items.length, rawMessagesRetained: session.messages.length,
          observationOffset: session.context!.observationOffset, toolOffset: session.context!.toolOffset });
        const reply = await this.#generateForSession(session, { role: 'player', sessionId: session.sessionId, instructions: session.instructions,
          input, tools, ...(tools.length === 1 ? { toolChoice: tools[0]!.name } : {}), ...(signal ? { signal } : {}) });
        session.context!.deliveredMessages = session.messages.length;
        session.context!.deliveredObservations = session.observations.length;
        session.context!.deliveredTools = session.toolHistory.length;
        session.context!.deliveredWireItems = session.context!.wire!.items.length;
        decisions++;
        session.messages.push(...reply.output);
        if (reply.calls.length !== 1) {
          for (const call of reply.calls) session.messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ status: 'rejected', error: this.prompts.feedback.playerToolCountInvalid }) });
          if (!reply.calls.length) session.messages.push(user({ error: this.prompts.feedback.playerToolRequired }));
          failures++;
          session.toolHistory.push({ calls: reply.calls, error: 'TOOL_COUNT_INVALID' });
          await this.trace.append({ kind: 'decision_rejected', sessionId: session.sessionId, code: 'TOOL_COUNT_INVALID', count: reply.calls.length });
          await this.store.save(session);
        } else {
          const call = reply.calls[0]!;
          // 稳定定义只供模型读取；普通工具仍受本轮可用集授权，序列逐项再次检查。
          const tool = (call.name === sequenceTool ? tools : frame.tools).find(t => t.name === call.name);
          let args: unknown;
          let error: string | null = null;
          try { args = JSON.parse(call.arguments); } catch { error = this.prompts.feedback.invalidArgumentsJson!; }
          if (!tool) error = this.prompts.feedback.toolUnavailable!;
          else if (!error) error = validationError(tool.inputSchema, args);
          if (!error && call.name === sequenceTool) {
            try {
              const catalog = frame.toolCatalog ?? frame.tools;
              const actions = (args as { actions: { tool: string; arguments: Json }[] }).actions.map(action => {
                const original = catalog.find(candidate => candidate.name === action.tool);
                if (!original) throw new Error('TOOL_UNAVAILABLE');
                const canonical = decodeActionArguments(original, action.arguments);
                const invalid = validationError(original.inputSchema, canonical);
                if (invalid) throw new Error(invalid);
                return { tool: action.tool, arguments: canonical };
              });
              args = { actions };
            } catch (failure) { error = failure instanceof Error ? failure.message : 'INVALID_ACTION_ENCODING'; }
          }
          if (error) {
            session.messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ status: 'rejected', revision: frame.revision, error }) });
            await this.trace.append({ kind: 'tool_rejected', sessionId: session.sessionId, tool: call.name, arguments: call.arguments, error });
            session.toolHistory.push({ tool: call.name, arguments: call.arguments, error });
            failures++;
            await this.store.save(session);
          } else if (call.name === sequenceTool) {
            const actions = (args as { actions: { tool: string; arguments: Json }[] }).actions;
            session.sequence = { callId: call.callId, actions, next: 0, expectedRevision: frame.revision, results: [] };
            await this.store.save(session);
            if (signal?.aborted) throw new Error('CANCELLED');
            failures = await this.#executeSequence(session, signal, beforeAction) ? failures + 1 : 0;
          } else {
            session.pending = { callId: call.callId, request: { matchId, playerId, revision: frame.revision, requestId: randomUUID(), tool: call.name, arguments: args as Json } };
            await this.store.save(session);
            // 用户在模型返回后取消时，不再开始新的牌桌副作用；保留原意图供显式恢复。
            if (signal?.aborted) throw new Error('CANCELLED');
            await this.#executePending(session);
            const feedback = session.messages.at(-1)?.output;
            const rejected = typeof feedback === 'string' && (JSON.parse(feedback) as { status: string }).status === 'rejected';
            failures = rejected ? failures + 1 : 0;
          }
        }
        if (failures >= this.limits.maxConsecutiveFailures) throw new Error('CONSECUTIVE_FAILURE_LIMIT');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      await this.trace.append({ kind: 'runtime_aborted', matchId, playerId, reason, decisions });
      return { status: 'aborted', reason, decisions };
    } finally { this.#active.delete(key); }
  }

  async #structured<T>(role: 'judge' | 'summary' | 'compactor', sessionId: string, instructions: string, input: unknown, schema: TSchema, signal?: AbortSignal, session?: PlayerSession, validate?: (value: T) => void | Promise<void>, maxInputBytes?: number): Promise<T> {
    const messages: ModelItem[] = [user(input)];
    let lastError = '';
    for (let attempt = 0; attempt < this.limits.maxConsecutiveFailures; attempt++) {
      if (maxInputBytes && bytes(messages) > maxInputBytes) throw new Error('REVIEW_INPUT_EXCEEDS_BUDGET');
      const request: ModelRequest = { role, sessionId, instructions, input: messages,
        tools: [{ name: 'submit_result', description: this.prompts.toolDescriptions.submit_result!, inputSchema: schema, effect: 'read' }], toolChoice: 'submit_result', ...(signal ? { signal } : {}) };
      const reply = session ? await this.#generateForSession(session, request) : await this.model.generate(request);
      messages.push(...reply.output);
      try {
        if (reply.calls.length !== 1 || reply.calls[0]!.name !== 'submit_result') throw new Error(this.prompts.feedback.structuredToolRequired);
        const value = parseStructured<T>(schema, JSON.parse(reply.calls[0]!.arguments));
        const catalogs = input as { knownCards?: Record<string, unknown>; eventFlows?: Record<string, unknown> } | null;
        if ([...Object.keys(catalogs?.knownCards ?? {}), ...Object.keys(catalogs?.eventFlows ?? {})].some(id => JSON.stringify(value).includes(id))) throw new Error('CONTEXT_REFERENCE_IN_MEMORY: 使用牌名和实际回合，不保留内部引用');
        await validate?.(value);
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'INVALID_OUTPUT';
        lastError = message;
        const supplied = (input as { allowedEvidenceRefs?: unknown } | null)?.allowedEvidenceRefs;
        const allowed = (schema.properties?.evidenceRefs?.items?.enum as string[] | undefined) ?? (Array.isArray(supplied) && supplied.every(x => typeof x === 'string') ? supplied as string[] : undefined);
        let details: { invalidEvidenceRefs: string[]; allowedEvidenceRefs: string[] } | undefined;
        if (allowed) {
          try {
            const raw = JSON.parse(reply.calls[0]?.arguments ?? '{}') as { evidenceRefs?: unknown };
            if (Array.isArray(raw.evidenceRefs)) details = { invalidEvidenceRefs: raw.evidenceRefs.filter((ref): ref is string => typeof ref === 'string' && !allowed.includes(ref)).slice(0, 32).map(ref => ref.slice(0, 80)), allowedEvidenceRefs: allowed };
          } catch { /* 参数不是 JSON 时保留原校验错误。 */ }
        }
        await this.trace.append({ kind: 'structured_rejected', role, sessionId, attempt, error: message, ...details });
        for (const call of reply.calls) messages.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ error: message, ...details }) });
        if (!reply.calls.length) messages.push(user({ error: message }));
      }
    }
    throw new Error(`STRUCTURED_OUTPUT_RETRIES_EXHAUSTED: ${lastError}`);
  }
  #evidence(refs: string[], session: PlayerSession): void {
    const ids = new Set(session.observations.map(o => o.id));
    if (refs.some(ref => !ids.has(ref))) throw new Error('EVIDENCE_OUT_OF_SCOPE');
  }
  async #compact(session: PlayerSession, signal?: AbortSignal, onlyDelivered = false): Promise<void> {
    if (session.pending || session.sequence) throw new Error('CANNOT_COMPACT_PENDING_TOOL');
    const progress = session.context!;
    const beforeActiveBytes = activeContextBytes(session), trigger = compactionContextBytes(session);
    const observationEnd = Math.min(session.observations.length, progress.deliveredObservations ?? (onlyDelivered ? 0 : session.observations.length));
    const toolEnd = Math.min(session.toolHistory.length, progress.deliveredTools ?? (onlyDelivered ? 0 : session.toolHistory.length));
    if (progress.observationOffset >= observationEnd && progress.toolOffset >= toolEnd && !progress.legacySnapshots?.length) return;
    const observations = session.observations.slice(progress.observationOffset, observationEnd);
    const toolHistory = reviewTools(session, progress.toolOffset).slice(0, Math.max(0, toolEnd - progress.toolOffset));
    const retrievedIds = new Set(toolHistory.flatMap(item => {
      const data = (item.receipt as { data?: { source?: string; evidenceRefs?: string[] } } | undefined)?.data;
      return data?.source === 'observations' ? data.evidenceRefs ?? [] : [];
    }));
    const retrievedObservations = session.observations.slice(0, progress.observationOffset).filter(event => retrievedIds.has(event.id));
    const needed = new Set([...(session.summary?.evidenceRefs ?? []), ...observations.map(event => event.id)]);
    // read_history 等只读反馈可能重新带回旧证据；只加入本席位已知且在本批资料中出现的来源。
    const historyText = JSON.stringify(toolHistory);
    for (const event of session.observations) if (historyText.includes(event.id)) needed.add(event.id);
    // 短引用按本席位观察的固定序号生成，跨压缩保持稳定；原件及落盘摘要继续使用原 ID。
    const evidenceSources = Object.fromEntries(session.observations.flatMap((event, index) => needed.has(event.id) ? [[`e${index + 1}`, event.id]] : []));
    const aliases = new Map(Object.entries(evidenceSources).map(([ref, id]) => [id, ref]));
    const budget = compressionBudget(this.limits.maxSummaryBytes, Object.values(evidenceSources), Object.keys(evidenceSources));
    const restoreRefs = (value: Compression): Compression => ({ ...value, evidenceRefs: value.evidenceRefs.map(ref => evidenceSources[ref]!) });
    const compacted = await this.#structured<Compression>('compactor', session.sessionId, this.prompts.compactor,
      sharedEventContext(sharedCardContext({ previousSummary: session.summary ? { ...session.summary, evidenceRefs: session.summary.evidenceRefs.map(id => aliases.get(id)!) } : null,
        coverage: { fromObservation: progress.observationOffset, observationsThrough: observationEnd, fromTool: progress.toolOffset, toolsThrough: toolEnd, lastRevision: session.observations[observationEnd - 1]?.revision ?? null },
        evidenceSources, observations: observations.map(event => ({ ...event, id: aliases.get(event.id)! })), retrievedObservations: retrievedObservations.map(event => ({ ...event, id: aliases.get(event.id)! })), toolHistory: linkToolObservations(toolHistory, [...observations, ...retrievedObservations], aliases), toolHistoryFormat: 'observation-links-v1', ...(progress.legacySnapshots?.length ? { legacySnapshots: progress.legacySnapshots } : {}), maxSummaryBytes: budget.maxSummaryBytes, maxTextCharacters: budget.maxTextCharacters, maxEvidenceRefs: budget.maxEvidenceRefs, allowedEvidenceRefs: budget.allowedEvidenceRefs })), budget.schema, signal, session,
      value => {
        if (value.text.length > budget.maxTextCharacters || value.evidenceRefs.length > budget.maxEvidenceRefs) throw new Error('SUMMARY_EXCEEDS_DYNAMIC_BUDGET');
        if (value.evidenceRefs.some(ref => !Object.hasOwn(evidenceSources, ref))) throw new Error('EVIDENCE_OUT_OF_COMPACTION_SCOPE');
        const restored = restoreRefs(value); this.#evidence(restored.evidenceRefs, session);
        if (bytes(restored) > this.limits.maxSummaryBytes) throw new Error(`SUMMARY_TOO_LARGE: ${bytes(restored)} > ${this.limits.maxSummaryBytes}`);
      });
    const summary = restoreRefs(compacted);
    const beforeBytes = bytes(session.messages);
    const delivered = Math.min(progress.deliveredMessages ?? 0, session.messages.length);
    // 摘要只覆盖已消费前缀；不再把同一前缀作为近期原文重放，避免把一次动作数成两次。
    progress.observationOffset = observationEnd; progress.toolOffset = toolEnd;
    delete progress.legacySnapshots;
    session.summary = summary; session.compactions++;
    startContextSegment(session, delivered);
    await this.store.save(session);
    await this.trace.append({ kind: 'context_compacted', sessionId: session.sessionId, summary, observationsRetained: session.observations.length, beforeBytes, afterBytes: bytes(session.messages.slice(delivered)),
      beforeActiveBytes, ...trigger, coveredObservations: observations.length, coveredTools: toolHistory.length,
      rawMessagesRetained: session.messages.length, protectedMessages: session.messages.length - delivered, protectedBytes: bytes(session.messages.slice(delivered)), observationOffset: progress.observationOffset, toolOffset: progress.toolOffset });
  }
  async compact(matchId: string, playerId: string): Promise<void> {
    const key = JSON.stringify([matchId, playerId]);
    if (this.#active.has(key)) throw new Error('ACTIVATION_IN_PROGRESS');
    this.#active.add(key);
    try { await this.#compact(await this.#session(matchId, playerId)); } finally { this.#active.delete(key); }
  }
  async judge(input: JudgeCase, validate?: (decision: JudgeDecision) => void | Promise<void>): Promise<JudgeDecision> {
    if (!input.disputeId || !input.evidenceIds.length) throw new Error('JUDGE_REQUIRES_DISPUTE');
    const decision = await this.#structured<JudgeDecision>('judge', `judge:${input.matchId}:${input.disputeId}`, `${this.prompts.judge}\n\n${this.prompts.feedback.judgeRulesHeading}\n${input.rules}`, input, JudgeDecisionSchema, undefined, undefined, async value => {
      if (value.evidenceRefs.some(ref => !input.evidenceIds.includes(ref)) || value.ruleRefs.some(ref => !input.ruleRefs.includes(ref))) throw new Error('JUDGE_REFERENCE_OUT_OF_SCOPE');
      if (value.verdict === 'dismiss' && value.steps.length) throw new Error('DISMISSED_DISPUTE_HAS_EFFECTS');
      for (let i = 0; i < value.steps.length; i++) {
        const step = value.steps[i]!;
        if (step.kind === 'restore' && (i !== 0 || !input.validRestoreTargets.includes(step.targetEventId))) throw new Error('INVALID_RESTORE_TARGET');
        if (step.kind === 'end_match' && i !== value.steps.length - 1) throw new Error('END_MATCH_MUST_BE_LAST');
        if (step.kind === 'end_match' && step.result.kind === 'confirm_reported_result' && !input.validReportedResults?.includes(step.result.reportEventId)) throw new Error('INVALID_REPORTED_RESULT');
        if (step.kind === 'shuffle') {
          const zone = input.zones.find(z => z.zoneId === step.zoneId);
          if (!zone || (!validate && step.indices.some(n => n >= zone.size))) throw new Error('INVALID_SHUFFLE_RANGE');
        }
      }
      await validate?.(value);
    });
    await this.trace.append({ kind: 'judge_decision', disputeId: input.disputeId, decision });
    return decision;
  }
  #reviewStructured(key: string): ReviewStructured {
    return <T>(stage: ReviewStage, input: unknown, schema: TSchema, validate?: (value: T) => void | Promise<void>) => this.#structured<T>('summary', `summary:${key}:${stage}`, this.prompts.summary,
      input, schema, undefined, undefined, validate, this.limits.maxReviewInputBytes);
  }
  async initializeStrategy(input: { deck: Json; rules: string; sessionId: string; previous?: StrategySnapshot }): Promise<StrategyUpdate> {
    const scope = strategyScope(input.deck, input.rules);
    const request = sharedCardContext({ stage: 'strategy_initialize', ownDeck: input.deck, ruleContext: input.rules, scope,
      ...(input.previous ? { previous: { ...input.previous, factStatus: 'unverified_legacy' } } : {}) });
    const initialized = await this.#reviewStructured(input.sessionId)<StrategyInitialization>('strategy_initialize', request, StrategyInitializationSchema,
      value => { if (!value.plan.trim()) throw new Error('COMPLETE_STRATEGY_PLAN_REQUIRED'); });
    const policy = { schemaVersion: 1 as const, scope, plan: initialized.plan, entries: [] };
    const update: StrategyUpdate = { strategy: renderPolicy(policy), policy, changeSummary: initialized.changeSummary, evidenceRefs: [] };
    await this.trace.append({ kind: 'strategy_initialized', sessionId: input.sessionId, scope, ...(input.previous ? { previousVersion: input.previous.version } : {}), update });
    return update;
  }
  async migrateStrategy(latest: StrategySnapshot, deck: Json, rules: string): Promise<StrategyUpdate> {
    return migrateLegacyStrategy({ latest, scope: strategyScope(deck, rules),
      structured: this.#reviewStructured(`migration:${createHash('sha256').update(JSON.stringify([deck, latest.version])).digest('hex')}`), trace: this.trace, limits: this.limits });
  }
  async summarize(matchId: string, playerId: string, latest: StrategySnapshot): Promise<StrategyUpdate> {
    const key = JSON.stringify([matchId, playerId]);
    if (this.#active.has(key)) throw new Error('ACTIVATION_IN_PROGRESS');
    this.#active.add(key);
    try {
      const session = await this.#session(matchId, playerId);
      if (session.pending || session.sequence) throw new Error('SUMMARY_REQUIRES_SETTLED_TOOLS');
      const frame = await this.#frame(session);
      if (frame.status !== 'finished') throw new Error('SUMMARY_REQUIRES_FINISHED_MATCH');
      return reviewStrategy({ session, latest, frame, limits: this.limits, trace: this.trace, ...(session.rulesText ? { rules: session.rulesText } : {}),
        structured: this.#reviewStructured(session.sessionId) });
    } finally { this.#active.delete(key); }
  }
}
