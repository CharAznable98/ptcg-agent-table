import { createHash } from 'node:crypto';
import type { StrategyEntry, StrategyPatch, StrategyPolicy } from '../../protocol/src/strategy.ts';
import type { StrategySnapshot } from './types.ts';
import { StrategyPolicySchema } from '../../protocol/src/strategy.ts';
import { validationError } from './schema.ts';

/** 所有创建、迁移和兼容恢复使用同一散列口径。 */
export function strategyScope(deck: unknown, rules: string): StrategyPolicy['scope'] {
  return { deckHash: createHash('sha256').update(JSON.stringify(deck)).digest('hex'), rulesHash: createHash('sha256').update(rules).digest('hex') };
}

export interface VerifiedPolicyFact { id: string; status: 'supported' | 'refuted' | 'unresolved'; evidenceRefs: string[] }
export interface ApplyPolicyOptions {
  baseVersion: number;
  matchId: string;
  facts: VerifiedPolicyFact[];
  visibleEntryIds?: string[];
  /** 迁移只能产生候选，不能把历史正文变成已经证实的经验。 */
  migration?: boolean;
}
const statuses = ['candidate', 'active', 'suspended', 'retired'];
const benefits = ['untested', 'observational', 'evaluated'];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const text = (value: unknown, limit: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export function validatePolicy(policy: StrategyPolicy): void {
  if (validationError(StrategyPolicySchema, policy)) throw new Error('STRATEGY_POLICY_INVALID');
  if (policy.schemaVersion !== 1 || !text(policy.scope?.deckHash, 256) || !text(policy.scope?.rulesHash, 256) || !Array.isArray(policy.entries)) throw new Error('STRATEGY_POLICY_INVALID');
  if (policy.plan !== undefined && !text(policy.plan, 12000)) throw new Error('STRATEGY_PLAN_INVALID');
  const ids = new Set<string>();
  for (const entry of policy.entries) {
    if (!identifier.test(entry.id) || ids.has(entry.id)) throw new Error('STRATEGY_ENTRY_ID_INVALID_OR_DUPLICATE');
    ids.add(entry.id);
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1 || !statuses.includes(entry.status) || !benefits.includes(entry.benefit)
      || !text(entry.when, 1200) || !text(entry.prefer, 1200) || !text(entry.because, 1600) || !Array.isArray(entry.unless) || entry.unless.length > 12 || entry.unless.some(item => !text(item, 600)) || !Array.isArray(entry.evidence)) throw new Error('STRATEGY_ENTRY_INVALID');
    for (const evidence of entry.evidence) if (!text(evidence.matchId, 256) || !['support', 'counter'].includes(evidence.direction)
      || !Array.isArray(evidence.eventIds) || !Array.isArray(evidence.factIds) || evidence.eventIds.some(id => !text(id, 256)) || evidence.factIds.some(id => !text(id, 256))) throw new Error('STRATEGY_EVIDENCE_INVALID');
  }
}

/** 纯函数应用增量。未触及条目原值保留；提交幂等由策略版本仓库按来源去重。 */
export function applyStrategyPatch(previous: StrategyPolicy, patch: StrategyPatch, options: ApplyPolicyOptions): StrategyPolicy {
  validatePolicy(previous);
  if (patch.baseVersion !== options.baseVersion) throw new Error('STRATEGY_VERSION_CONFLICT');
  if (!Array.isArray(patch.changes) || patch.changes.length > 16 || !text(patch.changeSummary, 3000)) throw new Error('STRATEGY_PATCH_INVALID');
  const next = structuredClone(previous), touched = new Set<string>();
  if (patch.plan !== undefined) {
    if (!text(patch.plan, 12000)) throw new Error('STRATEGY_PLAN_INVALID');
    next.plan = patch.plan;
  }
  const facts = new Map(options.facts.map(fact => [fact.id, fact]));
  for (const change of patch.changes) {
    const id = change.kind === 'add' ? change.entry.id : change.id;
    if (touched.has(id)) throw new Error('STRATEGY_ENTRY_CHANGED_TWICE');
    touched.add(id);
    const index = next.entries.findIndex(entry => entry.id === id), old = next.entries[index];
    if (change.kind === 'add') {
      if (old) throw new Error('STRATEGY_ENTRY_ALREADY_EXISTS');
      if (change.entry.revision !== 1) throw new Error('STRATEGY_ENTRY_REVISION_INVALID');
    } else {
      if (!old || old.revision !== change.expectedRevision) throw new Error('STRATEGY_ENTRY_REVISION_CONFLICT');
      if (options.visibleEntryIds && !options.visibleEntryIds.includes(id)) throw new Error('STRATEGY_ENTRY_NOT_REVIEWED');
      if (old.status === 'retired') throw new Error('STRATEGY_ENTRY_RETIRED');
    }
    if (!('entry' in change)) {
      if (!text(change.reason, 1600) || !change.factIds.length) throw new Error('STRATEGY_LIFECYCLE_REQUIRES_FACTS');
      const evidence = change.factIds.map(factId => {
        const fact = facts.get(factId);
        if (!fact || fact.status === 'unresolved') throw new Error('STRATEGY_FACT_NOT_REVIEWED');
        return { matchId: options.matchId, eventIds: [...fact.evidenceRefs], factIds: [factId], direction: 'counter' as const };
      });
      next.entries[index] = { ...old!, revision: old!.revision + 1, status: change.kind === 'suspend' ? 'suspended' : 'retired', evidence: dedupeEvidence([...old!.evidence, ...evidence]) };
      continue;
    }
    const entry = structuredClone(change.entry);
    if (entry.id !== id || entry.revision !== (old ? old.revision + 1 : 1)) throw new Error('STRATEGY_ENTRY_REVISION_INVALID');
    if (options.migration && (entry.status !== 'candidate' || entry.benefit !== 'untested' || entry.evidence.length)) throw new Error('LEGACY_MIGRATION_REQUIRES_CANDIDATE');
    // 单局复盘不是受控评估；不能借一次更新把事实核实偷换成收益已评估。
    if (entry.benefit === 'evaluated' && old?.benefit !== 'evaluated') throw new Error('STRATEGY_BENEFIT_ESCALATION');
    const inherited = (evidence: StrategyEntry['evidence'][number]) => old?.evidence.some(item => JSON.stringify(item) === JSON.stringify(evidence));
    const currentEvidence = entry.evidence.filter(evidence => evidence.matchId === options.matchId && (!inherited(evidence) || evidence.factIds.every(id => facts.has(id))));
    for (const evidence of currentEvidence) {
      if (!evidence.factIds.length) throw new Error('STRATEGY_EVIDENCE_REQUIRES_FACTS');
      const cited = evidence.factIds.map(factId => {
        const fact = facts.get(factId);
        if (!fact) throw new Error(`STRATEGY_FACT_NOT_REVIEWED: factId=${factId}`);
        if (evidence.direction === 'support' && fact.status !== 'supported') throw new Error(`ACTIVE_REQUIRES_VERIFIED_FACTS: ${factId}=${fact.status}`);
        return fact;
      });
      const allowedEvents = new Set(cited.flatMap(fact => fact.evidenceRefs));
      const invalidEvents = evidence.eventIds.filter(id => !allowedEvents.has(id));
      if (invalidEvents.length) throw new Error(`STRATEGY_FACT_NOT_REVIEWED: eventIds=${invalidEvents.join(',')}; allowedEventIds=${[...allowedEvents].join(',')}`);
    }
    // 旧证据只能原样继承，不能制造或修改外局证据来绕过当前核验。
    for (const evidence of entry.evidence.filter(evidence => evidence.matchId !== options.matchId)) {
      if (!old?.evidence.some(item => JSON.stringify(item) === JSON.stringify(evidence))) throw new Error('STRATEGY_FOREIGN_EVIDENCE_CHANGED');
    }
    if (entry.status === 'active' && (!currentEvidence.some(evidence => evidence.direction === 'support' && evidence.factIds.length) || currentEvidence.some(evidence => evidence.direction === 'counter' && evidence.factIds.some(id => facts.get(id)?.status === 'refuted')))) throw new Error('ACTIVE_REQUIRES_VERIFIED_FACTS');
    if (old) {
      // 修订不能抹去曾有证据；新的内容和生命周期仍可否定它。
      entry.evidence = dedupeEvidence([...old.evidence, ...entry.evidence]);
      next.entries[index] = entry;
    } else next.entries.push(entry);
  }
  validatePolicy(next);
  return next;
}
function dedupeEvidence<T>(items: T[]): T[] { return [...new Map(items.map(item => [JSON.stringify(item), item])).values()]; }

const statusLabels = { candidate: '候选', active: '启用', suspended: '暂停', retired: '退役' };
/** 玩家只读启用条目；管理界面可要求完整生命周期投影。 */
export function renderPolicy(policy: StrategyPolicy, options: { includeInactive?: boolean } = {}): string {
  validatePolicy(policy);
  const entries = policy.entries.filter(entry => options.includeInactive || entry.status === 'active').map(entry =>
    `[${entry.id} r${entry.revision} · ${statusLabels[entry.status]}]\n条件：${entry.when}\n比较与偏好：${entry.prefer}\n原因：${entry.because}${entry.unless.length ? `\n例外：${entry.unless.join('；')}` : ''}`).join('\n\n');
  return [policy.plan, entries].filter(Boolean).join('\n\n');
}

/** 有界读取不删除长期存储。只允许修改本次实际展示的条目。 */
export function policyReadingProjection(policy: StrategyPolicy, maxBytes = 30_000): StrategyPolicy {
  validatePolicy(policy);
  const entries: StrategyEntry[] = [];
  const ordered = [...policy.entries].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
  for (const entry of ordered) {
    if (Buffer.byteLength(JSON.stringify({ ...policy, entries: [...entries, entry] })) <= maxBytes) entries.push(structuredClone(entry));
  }
  return { ...structuredClone(policy), entries };
}

/** 对局读取投影与用户管理正文分开；旧全文和未启用条目不进入玩家上下文。 */
export function playerStrategyProjection(snapshot: StrategySnapshot, scope?: StrategyPolicy['scope']): StrategySnapshot & { reviewRequired?: true } {
  if (!snapshot.policy) return { version: snapshot.version, content: '', ...(snapshot.content.trim() ? { reviewRequired: true as const } : {}) };
  validatePolicy(snapshot.policy);
  const mismatch = scope && (scope.deckHash !== snapshot.policy.scope.deckHash || scope.rulesHash !== snapshot.policy.scope.rulesHash);
  const policy = { ...structuredClone(snapshot.policy), entries: mismatch ? [] : structuredClone(snapshot.policy.entries.filter(entry => entry.status === 'active')) };
  if (mismatch) delete policy.plan;
  if (mismatch) return { version: snapshot.version, content: '策略适用范围已变化，启用条目需复核。', policy, reviewRequired: true };
  return { version: snapshot.version, content: renderPolicy(policy), policy };
}
