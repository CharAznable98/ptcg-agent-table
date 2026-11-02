import type { StrategyPolicy } from '../../protocol/src/strategy.ts';
import type { TSchema } from '@sinclair/typebox';

/** 所有内容均可序列化；玩家输入必须已经由牌桌模块按席位投影。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ModelItem = Record<string, unknown>;
export type AgentRole = 'player' | 'judge' | 'summary' | 'compactor';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: TSchema;
  /** read 只能读取该角色已有权限内的信息；查看隐藏牌仍是 command。 */
  effect: 'read' | 'command';
  /** 仅模型包装工具使用紧凑位置参数；宿主和持久化请求仍为规范命令。 */
  argumentEncoding?: 'ptcg-positions-v1';
}

export interface ModelRequest {
  role: AgentRole;
  sessionId: string;
  instructions: string;
  input: ModelItem[];
  tools: ToolDefinition[];
  /** 专用结构化任务或唯一玩家工具固定函数；多工具时由模型选择。 */
  toolChoice?: string;
  signal?: AbortSignal;
}

export interface ModelReply {
  id: string;
  model: string;
  output: ModelItem[];
  calls: { callId: string; name: string; arguments: string }[];
  usage: Record<string, unknown> | null;
}

/** 一次推理，不执行任何游戏工具，也不持有玩家的长期记忆。 */
export interface ModelGateway {
  generate(request: ModelRequest): Promise<ModelReply>;
}

export interface Observation {
  id: string;
  revision: number;
  data: Json;
}

export interface PlayerFrame {
  matchId: string;
  playerId: string;
  revision: number;
  cursor: string;
  /** active 包含被请求的异议回应／准备选择；waiting 不调用模型。 */
  status: 'active' | 'waiting' | 'finished';
  snapshot: Json;
  observations: Observation[];
  tools: ToolDefinition[];
  /** 定义稳定的工具全集；本轮仍仅允许tools列出的能力。 */
  toolCatalog?: ToolDefinition[];
}

export interface ToolRequest {
  /** 服务端绑定，模型参数不得提供身份、版本或请求 ID。 */
  matchId: string;
  playerId: string;
  requestId: string;
  revision: number;
  tool: string;
  arguments: Json;
}

export interface ToolReceipt {
  status: 'committed' | 'read' | 'rejected' | 'not_executed';
  revision: number;
  data: Json;
  /** 宿主确认没有新信息或流程变化时，才允许执行同一序列的下一步。缺省要求重新观察。 */
  continuation?: 'continue' | 'observe';
  /** 洗牌位置失效；或整区查看后仅允许预定的按牌面选择跨过新信息边界。 */
  continuationGuard?: { kind: 'hidden_shuffle' | 'named_selection'; zoneIds: string[] };
}

/** 游戏模块真实接缝；execute 必须保证 requestId 的持久幂等与席位权限。 */
export interface MatchPort {
  observe(matchId: string, playerId: string, after: string | null): Promise<PlayerFrame>;
  execute(request: ToolRequest): Promise<ToolReceipt>;
}

export interface TraceSink {
  append(event: Record<string, unknown>): Promise<void>;
}

export interface StrategySnapshot {
  version: number;
  content: string;
  policy?: StrategyPolicy;
}

export interface PendingTool {
  callId: string;
  request: ToolRequest;
  sequenceIndex?: number;
}

export interface PendingSequence {
  callId: string;
  actions: { tool: string; arguments: Json }[];
  next: number;
  expectedRevision: number;
  results: { index: number; tool: string; receipt: ToolReceipt }[];
}

export interface ContextProgress {
  version: 2;
  observationOffset: number;
  toolOffset: number;
  /** messages 中已被一次完整成功的玩家推理消费的前缀；其后完整保留到成功送达。 */
  deliveredMessages?: number;
  /** 与最后一次成功推理输入同时提交的原始源水位；未消费反馈不能先进入摘要。 */
  deliveredObservations?: number;
  deliveredTools?: number;
  /** 当前线上段中已成功交付的编码消息数；失败请求追加部分不参与压缩触发。 */
  deliveredWireItems?: number;
  /** 旧上下文曾投递的快照，首次迁移压缩成功后移出活跃上下文。 */
  legacySnapshots?: Json[];
  /** 只追加的有线上下文；压缩成功后重新建立一段。 */
  wire?: { format: 'append-state-v1'; epoch: number; historyStart: number; sourceMessages: number; items: ModelItem[]; lastSnapshot: Json | null; revision: number | null; summaryKey: string; catalogs: { cards: Record<string, unknown>; flows: Record<string, unknown> } };
}

/** 一局一个席位一个上下文；此对象不会因牌桌回滚而恢复旧版。 */
export interface PlayerSession {
  schemaVersion: 1;
  sessionId: string;
  matchId: string;
  playerId: string;
  instructions: string;
  deck: Json;
  strategy: StrategySnapshot;
  policyScope?: { deckHash: string; rulesHash: string };
  /** 本局冻结的独立规则正文，只在需要核验规则事实的复盘阶段读取。 */
  rulesText?: string;
  messages: ModelItem[];
  /** 全量自身观察用于恢复、压缩依据与赛后总结，不自动全量塞进每次请求。 */
  observations: Observation[];
  /** 已收集但尚未写入玩家消息的观察；等待期间也持久保留。 */
  pendingObservations: Observation[];
  /** 完成及拒绝的本席位工具尝试；赛后总结不能只看到成功操作。 */
  toolHistory: ModelItem[];
  cursor: string | null;
  summary: { text: string; evidenceRefs: string[] } | null;
  pending: PendingTool | null;
  sequence?: PendingSequence | null;
  context?: ContextProgress;
  modelCalls: number;
  toolCalls: number;
  compactions: number;
}

export interface SessionStore {
  load(matchId: string, playerId: string): Promise<PlayerSession | null>;
  save(session: PlayerSession): Promise<void>;
}

export interface AgentLimits {
  maxDecisionsPerActivation: number;
  maxTotalModelCalls: number;
  maxConsecutiveFailures: number;
  /** 已消费可压缩历史的 UTF-8 触发阈值；不计每段必重发的快照/旧摘要，不等同于 token。 */
  compactAfterBytes: number;
  /** 遗留配置兼容；成功摘要前缀不再重放，未消费段仍完整保护。 */
  recentHistoryBytes: number;
  maxSummaryBytes: number;
  /** 专用复盘每次请求的 UTF-8 输入预算，不等同于模型 token 上限。 */
  maxReviewInputBytes: number;
  maxActionsPerDecision: number;
  /** 单步恢复旧序列时也受此限制；已提交但反馈丢失的原请求结算计一次。 */
  maxToolCallsPerActivation: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxDecisionsPerActivation: 64,
  maxTotalModelCalls: 2048,
  maxConsecutiveFailures: 3,
  compactAfterBytes: 80_000,
  recentHistoryBytes: 12_000,
  maxSummaryBytes: 12_000,
  maxReviewInputBytes: 160_000,
  maxActionsPerDecision: 16,
  maxToolCallsPerActivation: 512,
};
