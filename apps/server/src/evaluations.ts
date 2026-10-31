import { join } from 'node:path';
import { CreateEvaluationInputSchema, CreateComparisonInputSchema } from '../../../packages/protocol/src/index.ts';
import type { CreateEvaluationInput, CreateComparisonInput, EvaluationRecord, PlayerSpec, StrategyVersion } from '../../../packages/protocol/src/index.ts';
import { validationError, strategyScope } from '../../../packages/agent/src/index.ts';
import { ApiError, JsonRepository, clone, now, uid } from './storage.ts';
import { MatchRuntime, type MatchRecord } from './match.ts';
import { ReplayEntropy } from './entropy.ts';
import type { GameService } from './service.ts';

interface Scenario extends EvaluationRecord { initial: Pick<MatchRecord, 'state' | 'meta'>; runtimeHash: string }
/** 只保留显式启动入口。读取和普通对局结算均不会创建评估。 */
export class Evaluations {
  readonly service: GameService; readonly repository: JsonRepository<Scenario>;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(service: GameService) { this.service = service; this.repository = new JsonRepository(join(service.dataDir, 'evaluations')); }
  #serial<T>(action: () => Promise<T>): Promise<T> { const task = this.#queue.then(action); this.#queue = task.catch(() => {}); return task; }
  #public(scenario: Scenario): EvaluationRecord {
    const { initial: _initial, runtimeHash: _runtimeHash, ...record } = scenario;
    const run = (value: EvaluationRecord['baseline']) => ({ ...value, match: this.service.match(value.matchId).summary() });
    return { ...clone(record), baseline: run(record.baseline), comparisons: record.comparisons.map(run) };
  }
  async list(): Promise<EvaluationRecord[]> { return (await this.repository.list()).map(value => this.#public(value)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  async get(id: string): Promise<EvaluationRecord> { return this.#public(await this.repository.get(id)); }
  #version(versions: StrategyVersion[], version: number, deck: PlayerSpec['deck'], rules: string): StrategyVersion {
    const value = versions.find(item => item.version === version), scope = strategyScope(deck, rules);
    if (!value) throw new ApiError('INVALID_STRATEGY_VERSION', '策略版本不存在');
    if (!value.policy?.plan?.trim()) throw new ApiError('STRATEGY_NOT_INITIALIZED', '请选择已完成完整策略初始化的版本');
    if (value.policy.scope.deckHash !== scope.deckHash || value.policy.scope.rulesHash !== scope.rulesHash) throw new ApiError('STRATEGY_SCOPE_CONFLICT', '策略版本与冻结卡组或规则不匹配');
    return clone(value);
  }
  async create(raw: unknown): Promise<EvaluationRecord> {
    const error = validationError(CreateEvaluationInputSchema, raw); if (error) throw new ApiError('INVALID_EVALUATION',error);
    return this.#serial(async () => {
      const input = raw as CreateEvaluationInput;
      if (input.players[0].opponentId === input.players[1].opponentId) throw new ApiError('DUPLICATE_AI_OPPONENT', '请选择两名独立 AI');
      const id = uid(), matchId = uid(), rules = this.service.rulesText();
      const opponents = await Promise.all(input.players.map(player => this.service.opponents.get(player.opponentId)));
      const players = opponents.map((opponent, index) => ({ id: index === 0 ? 'A' : 'B', name: opponent.name ?? `AI ${index === 0 ? 'A' : 'B'}`, kind: 'ai', deck: clone(opponent.deck), opponentId: opponent.id })) as [PlayerSpec,PlayerSpec];
      for (const player of players) if (!player.deck.cards.some(entry => entry.card.kind === 'pokemon' && entry.card.stage === '基础')) throw new ApiError('NO_BASIC_POKEMON','卡组至少需要一张基础宝可梦');
      const strategies = Object.fromEntries(players.map((player,index) => [player.id,this.#version(opponents[index]!.strategies,input.players[index]!.version,player.deck,rules)]));
      const prompts = await this.service.prompts(), model = await this.service.modelConfig();
      const match = new MatchRuntime({ directory: join(this.service.dataDir,'matches',matchId), entropy: new ReplayEntropy() });
      await match.create({ id: matchId, players, mode: 'ai_ai', strategies, rules, prompts: { ...prompts, version: prompts.version! }, model, evaluation: { id, phase:'baseline' } });
      this.service.matches.set(matchId, match);
      const scenario: Scenario = { id, createdAt: now(), evaluatedPlayer: input.evaluatedPlayer, players: clone(input.players), baseline: { matchId, version: input.players[input.evaluatedPlayer === 'A' ? 0 : 1].version }, comparisons: [], initial: clone(match.records[0]!), runtimeHash: this.service.runtimeHash };
      await this.repository.save(scenario);
      this.service.start(match,false);
      return this.#public(scenario);
    });
  }
  async compare(id: string, raw: unknown): Promise<EvaluationRecord> {
    const error = validationError(CreateComparisonInputSchema,raw); if (error) throw new ApiError('INVALID_COMPARISON',error);
    return this.#serial(async () => {
      const input = raw as CreateComparisonInput, scenario = await this.repository.get(id);
      if (scenario.runtimeHash !== this.service.runtimeHash) throw new ApiError('EVALUATION_RUNTIME_CHANGED', '执行代码已变化，请用当前版本重新建立对照起点',409);
      if (this.service.match(scenario.baseline.matchId).state.flow.phase !== 'finished') throw new ApiError('BASELINE_NOT_FINISHED','请先完成版本 A 对局',409);
      const index = scenario.evaluatedPlayer === 'A' ? 0 : 1;
      const opponent = await this.service.opponents.get(scenario.players[index].opponentId);
      const initial = clone(scenario.initial);
      const version = this.#version(opponent.strategies,input.version,initial.state.players[index].deck,initial.meta.rules);
      initial.meta.strategies[scenario.evaluatedPlayer] = version;
      initial.meta.evaluation = { id, phase:'comparison' };
      const matchId = uid(), match = new MatchRuntime({ directory: join(this.service.dataDir,'matches',matchId) });
      await match.createFromScenario(matchId,initial); this.service.matches.set(matchId,match);
      scenario.comparisons.push({ matchId, version: input.version }); await this.repository.save(scenario);
      this.service.start(match,false);
      return this.#public(scenario);
    });
  }
}
