import { createHash } from 'node:crypto';
import type { TSchema } from '@sinclair/typebox';
import type { StrategyPatch, StrategyPolicy } from '../../protocol/src/strategy.ts';
import { contextBytes, reviewTools, userMessage } from './context.ts';
import { reviewPages } from './review.ts';
import { sharedCardContext } from './card-context.ts';
import { sharedEventContext } from './event-context.ts';
import { applyStrategyPatch, policyReadingProjection, renderPolicy, strategyScope, validatePolicy } from './policy.ts';
import { FactExtractionSchema, FactReviewSchema, StrategyPatchSchema, type FactAssessment, type FactExtraction, type FactReview, type ReviewFact, type StrategyUpdate } from './schema.ts';
import { DEFAULT_LIMITS, type AgentLimits, type Json, type Observation, type PlayerFrame, type PlayerSession, type StrategySnapshot, type TraceSink } from './types.ts';

export type ReviewStage = 'strategy_initialize' | 'facts_extract' | 'facts_review' | 'policy_patch' | 'legacy_candidates';
export type ReviewStructured = <T>(stage: ReviewStage, input: unknown, schema: TSchema, validate?: (value: T) => void | Promise<void>) => Promise<T>;
export interface ReviewStrategyInput {
  session: PlayerSession;
  latest: StrategySnapshot;
  frame: PlayerFrame;
  limits: AgentLimits;
  structured: ReviewStructured;
  trace: TraceSink;
  rules?: string;
}
export type FactVerificationScope = 'observed_events' | 'rules_and_events' | 'evidence_without_rules';
export interface ReviewedFact extends ReviewFact { assessment: FactAssessment; verificationScope: FactVerificationScope }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 白名单结果投影：不把异议理由、终局牌桌或closed状态复制成获证事实。 */
export function normalizeReviewResult(snapshot: Json, observations: Observation[] = []) {
  const root = object(snapshot), flow = object(root.flow), reported = object(flow.result ?? root.result);
  const kind = ['win', 'draw', 'abnormal'].includes(String(reported.kind)) ? String(reported.kind) : null;
  const outcome = kind ? { kind, ...(kind === 'win' && typeof reported.winner === 'string' ? { winner: reported.winner } : {}) } : null;
  const dispositions = observations.flatMap(observation => {
    const envelope = object(observation.data), data = object(envelope.data ?? envelope), command = object(data.command), result = object(data.result);
    const commandKind = string(envelope.commandKind ?? command.kind);
    if (!['system_restore', 'close_dispute'].includes(commandKind ?? '')) return [];
    return [{ eventId: observation.id, kind: commandKind!, ...(typeof result.restoredBefore === 'string' ? { restoredBefore: result.restoredBefore } : {}),
      ...(Array.isArray(result.revokedEvents) ? { revokedEvents: result.revokedEvents.filter(id => typeof id === 'string') } : {}) }];
  });
  return { outcome, dispositions };
}

function snapshotClaims(snapshot: Json) {
  const dispute = object(object(snapshot).dispute);
  if (typeof dispute.reason !== 'string') return [];
  return [{ kind: 'claim', truthStatus: 'unresolved', source: 'snapshot.dispute', id: string(dispute.id) ?? 'terminal-dispute',
    targetEventId: string(dispute.targetEventId), statement: dispute.reason, dispositionStatus: string(dispute.status),
    ...(Object.keys(object(dispute.ruling)).length ? { reportedRuling: dispute.ruling } : {}) }];
}
function publicFacts(snapshot: Json) { return array(object(snapshot).inPlayFacts).map(fact => structuredClone(object(fact))); }
function publicRefs(facts: Record<string, unknown>[]) { return facts.flatMap(fact => typeof fact.lineageRef === 'string' ? [fact.lineageRef] : []); }
function scopeFor(input: ReviewStrategyInput) {
  if (input.session.policyScope) return input.session.policyScope;
  if (input.session.rulesText === undefined && input.latest.policy) throw new Error('STRATEGY_SCOPE_UNVERIFIABLE');
  return strategyScope(input.session.deck, input.session.rulesText ?? input.session.instructions);
}
function within(input: unknown, maxBytes: number): boolean { return contextBytes([userMessage(input)]) <= maxBytes; }
function checkRefs(facts: ReviewFact[], observations: Observation[], publicIds: string[], entryIds: string[]) {
  const observationIds = new Set(observations.map(event => event.id)), ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.id)) throw new Error('REVIEW_FACT_ID_DUPLICATE');
    ids.add(fact.id);
    if (fact.evidenceRefs.some(id => !observationIds.has(id))) throw new Error('EVIDENCE_OUT_OF_SCOPE');
    if (fact.publicRefs.some(id => !publicIds.includes(id))) throw new Error('PUBLIC_FACT_OUT_OF_SCOPE');
    if (fact.relatedEntryIds.some(id => !entryIds.includes(id))) throw new Error('STRATEGY_ENTRY_NOT_REVIEWED');
  }
}
function claimOnly(observation: Observation) {
  const envelope = object(observation.data), data = object(envelope.data ?? envelope), command = object(data.command);
  return ['object', 'respond', 'declare', 'close_dispute', 'system_restore', 'judge_ruling', 'report_result', 'confirm_result'].includes(String(envelope.commandKind ?? command.kind));
}

/** 与玩家/压缩共用无损编码；原始观察和正式事件引用不改写。 */
function encodedReview<T extends Record<string, unknown>>(input: T): T {
  if (Array.isArray(input.relatedObservations)) {
    const { relatedObservations, ...rest } = input;
    const encoded = sharedEventContext(sharedCardContext({ ...rest, observations: relatedObservations }));
    const { observations, ...payload } = encoded;
    return { ...payload, relatedObservations: observations } as unknown as T;
  }
  return sharedEventContext(sharedCardContext(input));
}

/** 原始观察只用于复盘；经过独立语义核验的事实才可支撑启用条目。 */
export async function reviewStrategy(input: ReviewStrategyInput): Promise<StrategyUpdate> {
  const { session, latest, frame, structured, trace, limits } = input;
  if (session.pending || session.sequence) throw new Error('SUMMARY_REQUIRES_SETTLED_TOOLS');
  if (frame.status !== 'finished') throw new Error('SUMMARY_REQUIRES_FINISHED_MATCH');
  if (!latest.policy && latest.content.trim()) throw new Error('LEGACY_STRATEGY_REQUIRES_MIGRATION');
  const previous: StrategyPolicy = latest.policy ?? { schemaVersion: 1, scope: scopeFor(input), entries: [] };
  validatePolicy(previous);
  if (previous.scope.deckHash !== scopeFor(input).deckHash || previous.scope.rulesHash !== scopeFor(input).rulesHash) throw new Error('STRATEGY_SCOPE_CONFLICT');
  const budget = limits.maxReviewInputBytes, requestBudget = Math.floor(budget * 0.72);
  const reading = policyReadingProjection(previous, Math.min(30_000, Math.floor(requestBudget / 3)));
  const currentPublicInPlayFacts = publicFacts(frame.snapshot), publicIds = publicRefs(currentPublicInPlayFacts);
  const fixed = { matchId: session.matchId, playerId: session.playerId, result: normalizeReviewResult(frame.snapshot, session.observations), scope: previous.scope };
  const extractBase = { ...fixed, latestPolicy: reading, currentPublicInPlayFacts };
  if (!within({ ...extractBase, claims: snapshotClaims(frame.snapshot), observations: [], toolHistory: [] }, requestBudget)) throw new Error('REVIEW_FIXED_INPUT_EXCEEDS_BUDGET');
  const encoded = encodedReview({ observations: session.observations, toolHistory: reviewTools(session) });
  const { observations: encodedObservations, toolHistory: encodedTools, ...catalogs } = encoded;
  const pages = reviewPages(encodedObservations, encodedTools, { ...extractBase, claims: snapshotClaims(frame.snapshot), ...catalogs }, requestBudget);
  if (!pages.length) pages.push({ observations: [], toolHistory: [] });
  if (pages.length > 64) throw new Error('REVIEW_PAGE_LIMIT_EXCEEDED');
  let facts: ReviewFact[] = [];
  for (const [index, page] of pages.entries()) {
    // 固定结果不包含异议；终局主张只给第一页一次，并显式标成未核实主张。
    const extractInput = { ...extractBase, ...catalogs, stage: 'facts_extract', page: index + 1, pages: pages.length,
      ...(index === 0 ? { claims: snapshotClaims(frame.snapshot) } : {}), ...page };
    const note = await structured<FactExtraction>('facts_extract', extractInput, FactExtractionSchema, value => {
      checkRefs(value.facts, page.observations, publicIds, reading.entries.map(entry => entry.id));
    });
    checkRefs(note.facts, page.observations, publicIds, reading.entries.map(entry => entry.id));
    facts.push(...note.facts.map(fact => ({ ...fact, id: `${hash([session.matchId, session.playerId]).slice(0, 8)}.p${index + 1}.${fact.id}` })));
  }
  if (facts.length > 256) throw new Error('REVIEW_FACT_LIMIT_EXCEEDED');
  await trace.append({ kind: 'strategy_fact_notes', matchId: session.matchId, playerId: session.playerId, facts });
  const reviewed = await reviewFactGroups({ facts, observations: session.observations, currentPublicInPlayFacts, fixed, structured, trace, budget: requestBudget, maxGroupBudget: limits.maxReviewInputBytes, ...(input.rules ? { rules: input.rules } : {}) });
  const patchInput = { ...fixed, stage: 'policy_patch', baseVersion: latest.version, latestPolicy: reading, ownDeck: session.deck, reviewedFacts: reviewed,
    constraints: { maxChanges: 16, untouchedEntries: 'preserve', newBenefit: 'untested', activeRequires: 'facts_review_supported', recordOnlyIsNotLegalityOrBenefit: true } };
  if (!within(patchInput, requestBudget)) throw new Error('REVIEW_PATCH_INPUT_EXCEEDS_BUDGET');
  let policy: StrategyPolicy | undefined;
  const validate = (patch: StrategyPatch) => {
    if (previous.plan && !patch.plan?.trim()) throw new Error('COMPLETE_STRATEGY_PLAN_REQUIRED');
    if (previous.plan && patch.plan !== previous.plan && !reviewed.some(fact => fact.assessment.status !== 'unresolved')) throw new Error('STRATEGY_PLAN_CHANGE_REQUIRES_VERIFIED_FACTS');
    for (const fact of reviewed.filter(fact => fact.assessment.status === 'refuted')) for (const entryId of fact.relatedEntryIds) {
      if (reading.entries.find(entry => entry.id === entryId)?.status !== 'active') continue;
      const change = patch.changes.find(change => (change.kind === 'add' ? change.entry.id : change.id) === entryId);
      if (!change || change.kind === 'add' || change.kind === 'revise' && change.entry.status === 'active') throw new Error('COUNTEREVIDENCE_REQUIRES_SUSPEND');
    }
    policy = applyStrategyPatch(previous, patch, { baseVersion: latest.version, matchId: session.matchId,
      facts: reviewed.map(fact => ({ id: fact.id, status: fact.assessment.status, evidenceRefs: fact.assessment.evidenceRefs })), visibleEntryIds: reading.entries.map(entry => entry.id) });
    for (const change of patch.changes) if ((change.kind === 'add' || change.kind === 'revise') && change.entry.benefit !== 'untested' && previous.entries.find(entry => entry.id === change.entry.id)?.benefit !== change.entry.benefit) throw new Error('STRATEGY_BENEFIT_ESCALATION');
  };
  const patch = await structured<StrategyPatch>('policy_patch', patchInput, StrategyPatchSchema, validate);
  validate(patch);
  const planSources = patch.plan !== undefined && patch.plan !== previous.plan
    ? reviewed.filter(fact => fact.assessment.status !== 'unresolved') : [];
  const evidenceRefs = [...new Set([...planSources.flatMap(fact => fact.assessment.evidenceRefs), ...patch.changes.flatMap(change => change.kind === 'add' || change.kind === 'revise'
    ? change.entry.evidence.filter(evidence => evidence.matchId === session.matchId).flatMap(evidence => evidence.eventIds)
    : change.factIds.flatMap(id => reviewed.find(fact => fact.id === id)?.assessment.evidenceRefs ?? []))])];
  const update: StrategyUpdate = { strategy: renderPolicy(policy!, { includeInactive: true }), policy: policy!, changeSummary: patch.changeSummary, evidenceRefs };
  await trace.append({ kind: 'strategy_candidate', matchId: session.matchId, playerId: session.playerId, baseVersion: latest.version, patch, update,
    ...(planSources.length ? { planReviewSources: { scope: 'all_verified_facts_available_for_revision', factIds: planSources.map(fact => fact.id), evidenceRefs: [...new Set(planSources.flatMap(fact => fact.assessment.evidenceRefs))], verificationScopes: Object.fromEntries(planSources.map(fact => [fact.id, fact.verificationScope])) } } : {}) });
  return update;
}

export interface HistoricalReviewFact extends Record<string, unknown> { observedAtEventIds: string[] }
export interface ReviewEvidenceInput {
  facts: ReviewFact[]; observations: Observation[]; currentPublicInPlayFacts?: Record<string, unknown>[];
}

const canonicalValue = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalValue).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}` : JSON.stringify(value);
const payload = (observation: Observation) => { const envelope = object(observation.data); return object(envelope.data ?? envelope); };
const timingRefs = (fact: Record<string, unknown>) => ['firstInPlay', 'lastEvolution', 'lastStackChange']
  .flatMap(key => typeof object(fact[key]).eventId === 'string' ? [object(fact[key]).eventId as string] : []);

/** 只读赛后投影：从本席位已有增量临时还原引用事件的公开事实，不写入运行记忆或独立账本。 */
export function reviewEvidenceContext(input: ReviewEvidenceInput) {
  const current = input.currentPublicInPlayFacts ?? [], subjects = [...new Set(input.facts.flatMap(fact => [...fact.subjectRefs, ...fact.publicRefs]))];
  const raw = input.observations.map((observation, index) => {
    const envelope = object(observation.data), data = payload(observation);
    // 可见牌面与公开实例快照不能充当“该事件操作了这个对象”的文本索引。
    const { table: _table, flow: _flow, observedCards: _cards, observedGroups: _groups,
      inPlayFacts: _facts, departedInPlayRefs: _departed, ...eventData } = data;
    const turn = object(data.flow).turnNumber ?? data.turn;
    const sequence = typeof envelope.sequence === 'number' ? envelope.sequence : observation.revision;
    return { observation, data, index, sequence, turn: typeof turn === 'number' ? turn : null,
      text: JSON.stringify({ ...eventData, revokedBy: envelope.revokedBy }) };
  }).sort((a, b) => a.sequence - b.sequence || a.index - b.index);
  const byId = new Map(raw.map(row => [row.observation.id, row]));
  const refs = new Set(input.facts.flatMap(fact => fact.evidenceRefs)), missing = new Set<string>();
  for (const subject of subjects) if (byId.has(subject)) refs.add(subject);
  for (const row of raw) if (subjects.some(subject => row.text.includes(JSON.stringify(subject)))) refs.add(row.observation.id);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of refs) {
      const row = byId.get(id);
      if (!row) { missing.add(id); continue; }
      const command = object(row.data.command);
      for (const target of [command.targetEventId, row.data.targetEventId]) if (typeof target === 'string' && !refs.has(target)) { refs.add(target); changed = true; }
    }
  }
  // 当前公开事实只为明确引用该lineage的命题提供来源，不能反向填充历史同槽对象。
  const supplemental = new Set<string>();
  for (const fact of current) if (subjects.includes(String(fact.lineageRef))) for (const id of timingRefs(fact)) supplemental.add(id);
  const primaryIds = new Set(refs);
  const turns = new Set(raw.filter(row => primaryIds.has(row.observation.id)).flatMap(row => row.turn === null ? [] : [row.turn]));
  const historical = new Map<string, HistoricalReviewFact>(), state = new Map<string, Record<string, unknown>>();
  const lineageBounds = new Map<string, number>();
  const unknown: string[] = [];
  let sawDelta = false;
  const lastAnchor = Math.max(-1, ...raw.flatMap((row, index) => primaryIds.has(row.observation.id) ? [index] : []));
  // 只在本次引用锚点还原状态；不会将新补入的时点再次递归扩为整场取证闭包。
  for (const [index, row] of raw.entries()) {
    const departures = array(row.data.departedInPlayRefs), changes = array(row.data.inPlayFacts);
    if (Array.isArray(row.data.inPlayFacts) || Array.isArray(row.data.departedInPlayRefs)) sawDelta = true;
    for (const ref of departures) if (typeof ref === 'string') state.delete(ref);
    for (const item of changes) {
      const fact = object(item);
      if (typeof fact.lineageRef === 'string') state.set(fact.lineageRef, structuredClone(fact));
    }
    if (!primaryIds.has(row.observation.id)) continue;
    if (!sawDelta) unknown.push(row.observation.id);
    for (const [lineage, fact] of state) {
      const key = canonicalValue(fact), entry = historical.get(key);
      if (entry) entry.observedAtEventIds.push(row.observation.id);
      else historical.set(key, { ...structuredClone(fact), observedAtEventIds: [row.observation.id] });
      lineageBounds.set(lineage, index);
      for (const id of timingRefs(fact)) supplemental.add(id);
    }
  }
  // 补回已公开的堆叠/换位来源，包括连续进化的中间一步；不追踪隐藏身份。
  for (const subject of subjects) if (!lineageBounds.has(subject)) lineageBounds.set(subject, lastAnchor);
  for (const [index, row] of raw.entries()) for (const item of array(row.data.inPlayFacts)) {
    const lineage = object(item).lineageRef;
    if (typeof lineage === 'string' && index <= (lineageBounds.get(lineage) ?? -1)) supplemental.add(row.observation.id);
  }
  for (const id of supplemental) if (!byId.has(id)) missing.add(id);
  const relatedObservations = raw.filter(row => primaryIds.has(row.observation.id) || supplemental.has(row.observation.id)
    || row.turn !== null && turns.has(row.turn)
    || ['system_restore', 'judge_ruling'].includes(String(object(row.observation.data).commandKind ?? object(row.data.command).kind))).map(row => row.observation);
  return { relatedObservations, historicalPublicInPlayFacts: [...historical.values()], evidenceCoverage: {
    anchorEventIds: [...primaryIds].filter(id => byId.has(id)), completeObservedTurns: [...turns].sort((a, b) => a - b),
    timingSourceEventIds: [...supplemental].filter(id => byId.has(id)), missingSourceEventIds: [...missing],
    // 现有观察协议没有声明可信的完整历史基准；已见增量只能证明正面条目，不能用缺席作否定。
    historicalStateMode: 'observed_deltas' as const, historicalStateComplete: false as const,
    partialHistoricalStateAtEventIds: [...primaryIds].filter(id => byId.has(id)),
    historicalStateUnavailableAtEventIds: unknown,
  } };
}

export interface FactGroupsInput {
  facts: ReviewFact[]; observations: Observation[]; currentPublicInPlayFacts: Record<string, unknown>[];
  fixed: Record<string, unknown>; structured: ReviewStructured; trace: TraceSink; budget: number; rules?: string;
  /** 单个不可拆命题组可独占硬预算；常规批次仍按budget装配。缺省维持旧行为。 */
  maxGroupBudget?: number;
}
export async function reviewFactGroups(input: FactGroupsInput): Promise<ReviewedFact[]> {
  const { observations, facts, currentPublicInPlayFacts, fixed, structured, trace, budget } = input;
  const maxGroupBudget = input.maxGroupBudget ?? budget;
  if (!Number.isSafeInteger(budget) || budget <= 0 || !Number.isSafeInteger(maxGroupBudget) || maxGroupBudget < budget) throw new Error('REVIEW_BUDGET_INVALID');
  if (!facts.length) return [];
  const groups: ReviewFact[][] = [];
  // 同一命题一起核对；共享对象/来源不等于命题相同，避免经回合起点等公共来源传递合并整场。
  const connected = (a: ReviewFact, b: ReviewFact) => a.conflictKey === b.conflictKey;
  for (const fact of facts) {
    const matches = groups.filter(group => group.some(item => connected(item, fact)));
    if (!matches.length) groups.push([fact]);
    else {
      const group = matches[0]!; group.push(fact);
      for (const other of matches.slice(1)) { group.push(...other); groups.splice(groups.indexOf(other), 1); }
    }
  }
  const scope = (batch: ReviewFact[]): FactVerificationScope => batch.every(fact => fact.kind === 'event')
    ? 'observed_events' : input.rules ? 'rules_and_events' : 'evidence_without_rules';
  const reviewInput = (batch: ReviewFact[]) => encodedReview({ ...fixed, stage: 'facts_review', facts: batch, verificationScope: scope(batch),
    ...reviewEvidenceContext({ facts: batch, observations, currentPublicInPlayFacts }), currentPublicInPlayFacts,
    ...(scope(batch) === 'rules_and_events' ? { ruleContext: input.rules } : {}) });
  const batches: ReviewFact[][] = []; let batch: ReviewFact[] = [];
  const unresolved: ReviewedFact[] = [];
  for (const group of groups) {
    if (!within(reviewInput(group), budget)) {
      const oversized = reviewInput(group);
      if (within(oversized, maxGroupBudget)) {
        if (batch.length) { batches.push(batch); batch = []; }
        // 不可拆命题保持完整，并且不能与其前后的常规组混包。
        batches.push(group);
        continue;
      }
      const gap = oversized.evidenceCoverage;
      const explanation = `完整核验资料 ${contextBytes([userMessage(oversized)])} 字节超过 ${maxGroupBudget} 字节硬上限（常规批次 ${budget} 字节）；覆盖 ${oversized.relatedObservations.length} 条观察、回合 ${gap.completeObservedTurns.join(',') || '未知'}，历史公开状态 ${oversized.historicalPublicInPlayFacts.length} 种，缺失来源 ${gap.missingSourceEventIds.length} 条；未截断证据作结论。`;
      for (const fact of group) unresolved.push({ ...fact, status: 'unresolved', verificationScope: oversized.verificationScope, assessment: { factId: fact.id, status: 'unresolved', evidenceRefs: [], publicRefs: [], explanation } });
      continue;
    }
    if (batch.length && !within(reviewInput([...batch, ...group]), budget)) { batches.push(batch); batch = []; }
    batch.push(...group);
  }
  if (batch.length) batches.push(batch);
  if (batches.length > 32) throw new Error('REVIEW_FACT_CHECK_LIMIT_EXCEEDED');
  const reviewed = [...unresolved];
  for (const candidates of batches) {
    const request = reviewInput(candidates), allowedIds = new Set(request.relatedObservations.map(event => event.id)), publicIds = [...publicRefs(currentPublicInPlayFacts), ...publicRefs(request.historicalPublicInPlayFacts)];
    const validate = (value: FactReview) => {
      if (value.assessments.length !== candidates.length || new Set(value.assessments.map(item => item.factId)).size !== candidates.length) throw new Error('FACT_REVIEW_INCOMPLETE');
      for (const assessment of value.assessments) {
        if (!candidates.some(fact => fact.id === assessment.factId) || assessment.evidenceRefs.some(ref => !allowedIds.has(ref)) || assessment.publicRefs.some(ref => !publicIds.includes(ref))) throw new Error('EVIDENCE_OUT_OF_REVIEW');
        if (assessment.status !== 'unresolved' && !assessment.evidenceRefs.length && !assessment.publicRefs.length) throw new Error('FACT_VERDICT_REQUIRES_SOURCE');
      }
    };
    const result = await structured<FactReview>('facts_review', request, FactReviewSchema, validate); validate(result);
    for (const fact of candidates) {
      let assessment = result.assessments.find(item => item.factId === fact.id)!;
      // 单纯异议/宣告只能证明说过这句话；确认内容需要独立观察或公开状态。
      if (fact.kind !== 'event' && assessment.status !== 'unresolved' && !assessment.publicRefs.length
        && assessment.evidenceRefs.every(ref => claimOnly(observations.find(event => event.id === ref)!))) assessment = { ...assessment, status: 'unresolved', explanation: '只有主张来源，尚无独立事实核对。' };
      reviewed.push({ ...fact, status: assessment.status, assessment, verificationScope: request.verificationScope });
    }
  }
  await trace.append({ kind: 'strategy_facts_reviewed', ...fixed, facts: reviewed });
  return reviewed;
}

export interface MigrateLegacyStrategyInput {
  latest: StrategySnapshot;
  scope: StrategyPolicy['scope'];
  structured: ReviewStructured;
  trace: TraceSink;
  limits?: Pick<AgentLimits, 'maxReviewInputBytes'>;
  /** 可选授权原件；缺省时遗留陈述全部保持未核实。 */
  session?: PlayerSession;
  frame?: PlayerFrame;
  rules?: string;
}
/** 发布由调用方完成并标记source:migration；永不改写旧版正文或直接启用旧主张。 */
export async function migrateLegacyStrategy(input: MigrateLegacyStrategyInput): Promise<StrategyUpdate> {
  const { latest, scope, structured, trace } = input;
  if (latest.policy) throw new Error('STRATEGY_ALREADY_STRUCTURED');
  const previous: StrategyPolicy = { schemaVersion: 1, scope, entries: [] };
  const budget = Math.floor((input.limits?.maxReviewInputBytes ?? DEFAULT_LIMITS.maxReviewInputBytes) * 0.72);
  const legacy = { version: latest.version, content: latest.content, factStatus: 'unresolved', sourceKind: 'unverified_legacy' };
  if (!within({ stage: 'legacy_candidates', legacy, scope }, budget)) throw new Error('LEGACY_INPUT_EXCEEDS_BUDGET');
  // 若提供原件，沿用与赛后完全相同的抽取/核验契约；没有原件则不能产生已获证事实。
  let reviewedFacts: ReviewedFact[] = [];
  if (input.session && input.frame) {
    const observations = input.session.observations, currentPublicInPlayFacts = publicFacts(input.frame.snapshot);
    const request = { stage: 'facts_extract', legacy, observations, currentPublicInPlayFacts, claims: snapshotClaims(input.frame.snapshot), result: normalizeReviewResult(input.frame.snapshot, observations) };
    if (!within(request, budget)) throw new Error('LEGACY_EVIDENCE_EXCEEDS_BUDGET');
    const extracted = await structured<FactExtraction>('facts_extract', request, FactExtractionSchema, value => checkRefs(value.facts, observations, publicRefs(currentPublicInPlayFacts), []));
    checkRefs(extracted.facts, observations, publicRefs(currentPublicInPlayFacts), []);
    reviewedFacts = await reviewFactGroups({ facts: extracted.facts, observations, currentPublicInPlayFacts, fixed: { migrationFromVersion: latest.version }, structured, trace, budget, ...(input.rules ? { rules: input.rules } : {}) });
  }
  const validate = (patch: StrategyPatch) => {
    if (patch.changes.some(change => change.kind !== 'add')) throw new Error('LEGACY_MIGRATION_ONLY_ADD');
    applyStrategyPatch(previous, patch, { baseVersion: latest.version, matchId: input.session?.matchId ?? 'legacy-migration', facts: [], migration: true });
  };
  const request = { stage: 'legacy_candidates', baseVersion: latest.version, legacy, scope, reviewedFacts, constraints: { status: 'candidate', benefit: 'untested', evidence: [], preserveUnknown: true } };
  if (!within(request, budget)) throw new Error('LEGACY_INPUT_EXCEEDS_BUDGET');
  const patch = await structured<StrategyPatch>('legacy_candidates', request, StrategyPatchSchema, validate); validate(patch);
  const policy = applyStrategyPatch(previous, patch, { baseVersion: latest.version, matchId: input.session?.matchId ?? 'legacy-migration', facts: [], migration: true });
  const update = { strategy: renderPolicy(policy, { includeInactive: true }), policy, changeSummary: patch.changeSummary, evidenceRefs: [] };
  await trace.append({ kind: 'strategy_migration_candidate', fromVersion: latest.version, sourceHash: hash(latest.content), patch, update });
  return update;
}
