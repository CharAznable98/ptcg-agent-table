import type { StrategyPolicy } from './strategy.ts';
import type { ActionReference, HumanActionView } from './human-actions.ts';
import type { TSchema } from '@sinclair/typebox';
import type { CardData, DeckData, Visibility } from './cards.ts';
import type { CommandEnvelope, GameCommand, GameResult, PlayerId, Position, Proposal, Selection } from './commands.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Viewer = PlayerId | 'omniscient';
export type Actor = { kind: 'player'; playerId: PlayerId } | { kind: 'system'; purpose: 'setup' | 'disposition' | 'debug' };
export type ZoneKind = 'deck' | 'hand' | 'prizes' | 'discard' | 'lost' | 'active' | 'bench' | 'stadium' | 'staging';
export interface CardInstance { id: string; definitionId: string; ownerId: PlayerId; state: { visibility?: Visibility; markers: Record<string, string | number | boolean> } }
export interface GroupState { damageCounters: number; specialConditions: string[]; markers: Record<string, string | number | boolean> }
export interface CardGroup { id: string; stack: string[]; attached: string[]; state: GroupState }
export type ObjectRef = { kind: 'card' | 'group'; id: string };
export interface Zone { id: string; kind: ZoneKind; playerId: PlayerId | null; contents: { layout: 'sequence' | 'slots'; items: (ObjectRef | null)[] }; defaultVisibility: Visibility }
export interface PlayerSpec { id: PlayerId; name: string; kind: 'human' | 'ai'; deck: DeckData; opponentId?: string }

/** eligible 等决定资料只交给被请求的席位，其他席位只能读 kind 和 playerId。 */
export interface Choice {
  kind: 'choose_first' | 'initial_placement' | 'mulligan_draw' | 'additional_bench' | 'result_confirm' | 'handoff' | 'dispute_response';
  playerId: PlayerId;
  eligible?: Position[];
  maximum?: number;
  failedHands?: CardData[][];
  message?: string;
}
export interface GameFlow {
  phase: 'setup' | 'turn' | 'check' | 'result_pending' | 'finished';
  turnOwner: PlayerId | null;
  operator: PlayerId;
  turnNumber: number;
  firstPlayer: PlayerId | null;
  choice: Choice | null;
  handoffReturnTo: PlayerId | null;
  proposedResult: GameResult | null;
  result: GameResult | null;
}
/** 系统准备进度参与恢复；不作为普通玩家观察直接返回。 */
export interface SetupProgress {
  stage: 'first' | 'deal' | 'placement' | 'mulligan' | 'bonus' | 'additional' | 'reveal' | 'done';
  mulligans: Record<PlayerId, number>;
  bonus: Record<PlayerId, number>;
  placed: Record<PlayerId, boolean>;
  bonusChosen: Record<PlayerId, boolean>;
  additionalChosen: Record<PlayerId, boolean>;
  failedHands: Record<PlayerId, CardData[][]>;
  pending?: { id: string; playerId: PlayerId; cardIds: string[]; kind: 'initial' | 'additional'; cursor: number };
}
export interface GameState {
  schemaVersion: 1;
  id: string;
  revision: number;
  players: [PlayerSpec, PlayerSpec];
  definitions: Record<string, CardData>;
  cards: Record<string, CardInstance>;
  groups: Record<string, CardGroup>;
  zones: Record<string, Zone>;
  playerMarkers: Record<PlayerId, Record<string, string | number | boolean>>;
  flow: GameFlow;
  setup: SetupProgress;
}
export interface Entropy { uuid(): string; integer(maxExclusive: number): number; scoped?(purpose: string): Entropy }
export interface Reveal { recipients: PlayerId[]; cards: { position: Position; card: CardData }[] }
export interface CoreResult { state: GameState; result: Json; reveals: Reveal[]; changed: boolean }
/** 私有系统命令不能通过 HTTP 或模型自行提交，仅服务端编排与授权恢复使用。 */
export type InternalCommand =
  | { kind: 'system_progress'; flow?: GameFlow; setup?: SetupProgress }
  | { kind: 'system_restore'; state: GameState };
export type CoreCommand = GameCommand | InternalCommand;

export interface CardView { kind: 'card'; position: Position; card: CardData; ownerId: PlayerId; markers: Record<string, string | number | boolean> }
export interface HiddenView { kind: 'hidden'; position: Position }
export interface GroupView { kind: 'group'; position: Position; stack: (CardView | HiddenView)[]; attached: (CardView | HiddenView)[]; state: GroupState }
export type ObjectView = CardView | HiddenView | GroupView;
export interface ZoneView { id: string; kind: ZoneKind; playerId: PlayerId | null; layout: 'sequence' | 'slots'; items: (ObjectView | null)[]; defaultVisibility: Visibility }
export interface TableView {
  id: string;
  revision: number;
  viewer: Viewer;
  players: { id: PlayerId; name: string; kind: 'human' | 'ai' }[];
  zones: ZoneView[];
  flow: GameFlow;
  ownDeck?: DeckData;
  playerMarkers: Partial<Record<PlayerId, Record<string, string | number | boolean>>>;
}
export interface PublicEvent { id: string; sequence: number; revision: number; at: string; actor: PlayerId | 'system'; commandKind: string; label: string; data: Json; revokedBy?: string; action?: ActionReference }
export interface DisputeView {
  id: string; targetEventId: string; raisedBy: PlayerId; respondent: PlayerId; reason: string;
  proposalId: string; proposal: Proposal; status: 'awaiting_response' | 'awaiting_judge' | 'applying' | 'closed';
  ruling?: { verdict: 'uphold' | 'dismiss'; ruleRefs: string[]; steps: Json[] };
}
export interface RuntimeStatus { status: 'idle' | 'running' | 'waiting' | 'paused' | 'aborted' | 'completed'; error?: string; activePlayer?: PlayerId; modelCalls?: number }
export interface MatchView extends TableView { evaluation?: { id: string; phase: 'baseline' | 'comparison' }; mode: MatchMode; events: PublicEvent[]; cursor: string; dispute: DisputeView | null; runtime: RuntimeStatus; summaries: Partial<Record<PlayerId, { status: 'pending' | 'completed' | 'failed'; version?: number; error?: string }>>; replay?: { index: number; total: number }; humanAction?: HumanActionView | null }
export interface MatchSummary { id: string; createdAt: string; mode: MatchMode; players: { id: PlayerId; name: string; kind: 'human' | 'ai' }[]; phase: GameFlow['phase']; result: GameResult | null; runtime: RuntimeStatus; revision: number }
export type MatchMode = 'ai_ai' | 'human_ai' | 'local';
export interface CreateMatchInput { mode: MatchMode; players: [{ name: string; kind: 'human' | 'ai'; deckId?: string; deck?: DeckData; opponentId?: string }, { name: string; kind: 'human' | 'ai'; deckId?: string; deck?: DeckData; opponentId?: string }]; autoRun?: boolean }
export interface CreateMatchResponse { match: MatchSummary }
/** HTTP 操作显式指定人类席位；引擎内部继续使用 CommandEnvelope。 */
export interface MatchCommandInput extends CommandEnvelope { playerId: PlayerId }
export type CommandReceipt =
  | { status: 'committed'; eventId: string; revision: number; result: Json; revokedBy?: string }
  | { status: 'not_executed'; revision: number; reason: string }
  | { status: 'rejected'; revision: number; error: { code: string; message: string } };
export interface DeckRecord { id: string; deck: DeckData; createdAt: string; updatedAt: string }
export interface StrategyVersion { version: number; content: string; createdAt: string; source: { kind: 'initial' | 'user_edit' } | { kind: 'match'; matchId: string; playerId: string } | { kind: 'migration'; fromVersion: number }; policy?: StrategyPolicy; updateId?: string; previousVersion?: number; changeSummary?: string; evidenceRefs?: string[] }
export interface OpponentRecord { schemaVersion: 1; id: string; name?: string; deck: DeckData; strategies: StrategyVersion[]; origin?: { opponentId: string } }
export interface PromptConfig { schemaVersion: 1; player: string; judge: string; summary: string; compactor: string; humanExecutor?: string; toolDescriptions: Record<string, string>; feedback: Record<string, string>; version?: string }
export interface ErrorResponse { error: { code: string; message: string } }
export interface ToolSpec { name: string; description: string; inputSchema: TSchema; effect: 'read' | 'command' }

// 所有实现共同遵守：API 的 command 与这些已定类型完全一致；不可悄悄新增万能补丁。
export type { CardData, DeckData, Visibility, CommandEnvelope, GameCommand, GameResult, PlayerId, Position, Proposal, Selection };
