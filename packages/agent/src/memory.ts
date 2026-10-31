import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './storage.ts';
import type { Json, StrategySnapshot, TraceSink } from './types.ts';
import type { StrategyUpdate } from './schema.ts';
import type { StrategyPolicy } from '../../protocol/src/strategy.ts';
import { renderPolicy, validatePolicy } from './policy.ts';

export interface StrategyVersion {
  version: number;
  content: string;
  createdAt: string;
  source: { kind: 'initial' } | { kind: 'match'; matchId: string; playerId: string } | { kind: 'migration'; fromVersion: number };
  policy?: StrategyPolicy;
  updateId?: string;
  previousVersion?: number;
  changeSummary?: string;
  evidenceRefs?: string[];
}

export interface OpponentRecord {
  schemaVersion: 1;
  id: string;
  deck: Json;
  strategies: StrategyVersion[];
}

const queues = new Map<string, Promise<unknown>>();

/** 一个 AI 对手的完整卡组与策略历史同存 JSON；提交可跨进程重启识别。 */
export class StrategyRepository {
  readonly directory: string;
  readonly trace: TraceSink;
  constructor(directory: string, trace: TraceSink) { this.directory = directory; this.trace = trace; }
  #path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('OPPONENT_ID_INVALID');
    return join(this.directory, `${id}.json`);
  }
  async create(deck: Json, initialStrategy = ''): Promise<OpponentRecord> {
    const record: OpponentRecord = { schemaVersion: 1, id: randomUUID(), deck,
      strategies: [{ version: 1, content: initialStrategy, createdAt: new Date().toISOString(), source: { kind: 'initial' } }] };
    await atomicJson(this.#path(record.id), record);
    return record;
  }
  async read(id: string): Promise<OpponentRecord> {
    const record = JSON.parse(await readFile(this.#path(id), 'utf8')) as OpponentRecord;
    if (record.schemaVersion !== 1 || record.id !== id || !Array.isArray(record.strategies) || !record.strategies.length) throw new Error('OPPONENT_DATA_INVALID');
    for (const [i, version] of record.strategies.entries()) {
      if (version.version !== i + 1 || typeof version.content !== 'string') throw new Error('STRATEGY_HISTORY_INVALID');
      if (version.policy) validatePolicy(version.policy);
    }
    return record;
  }
  async latest(id: string): Promise<StrategySnapshot> {
    const latest = (await this.read(id)).strategies.at(-1)!;
    return { version: latest.version, content: latest.content, ...(latest.policy ? { policy: structuredClone(latest.policy) } : {}) };
  }
  async publish(input: { opponentId: string; matchId: string; playerId: string; baseVersion: number; update: StrategyUpdate }): Promise<StrategyVersion> {
    return this.#publish({ opponentId: input.opponentId, baseVersion: input.baseVersion, update: input.update,
      source: { kind: 'match', matchId: input.matchId, playerId: input.playerId }, identity: [input.matchId, input.opponentId, input.playerId] });
  }
  async migrate(input: { opponentId: string; baseVersion: number; update: StrategyUpdate }): Promise<StrategyVersion> {
    return this.#publish({ ...input, source: { kind: 'migration', fromVersion: input.baseVersion }, identity: ['migration', input.opponentId, input.baseVersion] });
  }
  async #publish(input: { opponentId: string; baseVersion: number; update: StrategyUpdate; source: StrategyVersion['source']; identity: unknown[] }): Promise<StrategyVersion> {
    const path = this.#path(input.opponentId);
    const task = (queues.get(path) ?? Promise.resolve()).then(async () => {
      const updateId = createHash('sha256').update(JSON.stringify(input.identity)).digest('hex');
      const record = await this.read(input.opponentId);
      const existing = record.strategies.find(v => v.updateId === updateId);
      if (existing) {
        await this.trace.append({ kind: 'strategy_publish_recovered', updateId, opponentId: input.opponentId, version: existing.version });
        return existing;
      }
      const latest = record.strategies.at(-1)!;
      if (latest.version !== input.baseVersion) throw new Error('STRATEGY_VERSION_CONFLICT: 必须基于最新版重新总结');
      const policy = input.update.policy;
      if (latest.policy && !policy) throw new Error('STRUCTURED_POLICY_REQUIRED');
      if (policy) {
        validatePolicy(policy);
        if (latest.policy) {
          if (latest.policy.scope.deckHash !== policy.scope.deckHash || latest.policy.scope.rulesHash !== policy.scope.rulesHash) throw new Error('STRATEGY_SCOPE_CONFLICT');
          for (const old of latest.policy.entries) {
            const next = policy.entries.find(entry => entry.id === old.id);
            if (!next || next.revision !== old.revision && next.revision !== old.revision + 1) throw new Error('STRATEGY_ENTRY_REVISION_CONFLICT');
            if (next.revision === old.revision && JSON.stringify(next) !== JSON.stringify(old)) throw new Error('STRATEGY_UNTOUCHED_ENTRY_CHANGED');
          }
          for (const entry of policy.entries.filter(entry => !latest.policy!.entries.some(old => old.id === entry.id))) if (entry.revision !== 1) throw new Error('STRATEGY_ENTRY_REVISION_INVALID');
        }
      }
      if (input.source.kind === 'migration') {
        if (latest.policy || !policy || policy.entries.some(entry => entry.status !== 'candidate' || entry.benefit !== 'untested' || entry.evidence.length)) throw new Error('LEGACY_MIGRATION_REQUIRES_CANDIDATE');
      }
      const next: StrategyVersion = { version: latest.version + 1, previousVersion: latest.version,
        content: policy ? renderPolicy(policy, { includeInactive: true }) : input.update.strategy, ...(policy ? { policy: structuredClone(policy) } : {}),
        createdAt: new Date().toISOString(), source: input.source, updateId,
        changeSummary: input.update.changeSummary, evidenceRefs: input.update.evidenceRefs };
      await this.trace.append({ kind: 'strategy_publish_prepared', opponentId: input.opponentId, updateId, baseVersion: latest.version, candidate: next });
      record.strategies.push(next);
      await atomicJson(path, record);
      await this.trace.append({ kind: 'strategy_publish_completed', opponentId: input.opponentId, updateId, version: next.version });
      return next;
    });
    queues.set(path, task.catch(() => {}));
    return task;
  }
}
