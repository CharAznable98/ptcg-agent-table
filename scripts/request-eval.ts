import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import type { TSchema } from '@sinclair/typebox';
import { AgentRuntime, createModel, JsonlTrace, loadModelConfig, MemorySessionStore, SecretRedactor, tokenUsage, validationError } from '../packages/agent/src/index.ts';
import type { ModelItem, ModelReply, ModelRequest, ToolReceipt, ToolRequest, TraceSink } from '../packages/agent/src/types.ts';
import { MatchRuntime, type MatchRecord } from '../apps/server/src/match.ts';
import { ReplayEntropy } from '../apps/server/src/entropy.ts';
import type { GameState, ModelConfig, PlayerId } from '../packages/protocol/src/index.ts';

export const digest = (value: string | Buffer | unknown): string => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);

export type SafetyCheck = { kind:'bench_from_deck'; stage:string; maxHp:number }
  | { kind:'new_item_attachment' | 'new_stadium_group' | 'new_stack_lineage' | 'no_rejected_operation' };
export type Oracle = { kind: 'turn_draw' } | { kind: 'top_partition'; count: number }
  | { kind: 'dispute_response'; response: 'accept' | 'defend'; reasonGroups: string[][] }
  | { kind:'state_safety'; checks:SafetyCheck[] };
export interface Selection {
  id: string; title: string; matchDir: string; callId: string; rubric: string; ruleRefs: string[]; oracle: Oracle;
}
export interface FrozenCase {
  schemaVersion: 1; id: string; title: string; rubric: string; ruleRefs: string[]; oracle: Oracle;
  source: { matchId: string; callId: string; playerId: PlayerId; revision: number; sequence: number; traceLine: number; traceHash: string; journalHash: string;
    historyCutoff?: { format:'trace-receipts-v1'; revisionEntrySequence:number; lastObservedSequence:number|null } };
  normalization: { format: 'portable-v1'; removedReasoningItems: number; originalInputHash: string };
  originalWire?: ModelItem; request: Omit<ModelRequest, 'signal'>; inputHash: string;
  historicalReply?: ModelReply; journalFile: string;
}
interface Suite { schemaVersion: 1; createdAt: string; files: Record<string,string>; cases: string[]; }
export interface RequestBank {
  schemaVersion:1; id:string;
  fixture:{ directory:string; manifestHash:string };
  grading:{ automatic:string; manual:string };
  questions:(Pick<FrozenCase,'id'|'title'|'source'|'inputHash'|'oracle'> & {category:'flow'|'anomaly';manualReview:string[]})[];
}

/** 只移除提供方专属的恢复项，保留席位消息、工具调用与实际反馈。 */
export function portableInput(items: ModelItem[]): { input: ModelItem[]; removedReasoningItems: number } {
  const input: ModelItem[] = []; let removedReasoningItems = 0;
  for (const item of items) {
    if (item.type === 'reasoning') { removedReasoningItems++; continue; }
    if (item.type === 'function_call') {
      input.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments }); continue;
    }
    if (item.type === 'function_call_output') {
      input.push({ type: 'function_call_output', call_id: item.call_id, output: item.output }); continue;
    }
    assert.ok(['user','assistant','system','developer'].includes(String(item.role)), 'UNSUPPORTED_INPUT_ITEM');
    let content = item.content;
    if (Array.isArray(content)) {
      assert.ok(content.every(part => part && typeof part === 'object' && typeof part.text === 'string'), 'UNSUPPORTED_MEDIA_INPUT');
      content = content.map(part => part.text).join('');
    }
    assert.equal(typeof content, 'string', 'UNSUPPORTED_MESSAGE_CONTENT');
    input.push({ role: item.role, content });
  }
  return { input, removedReasoningItems };
}

export function requestRevision(items: ModelItem[]): number {
  for (const item of items.toReversed()) {
    if (item.role !== 'user' || typeof item.content !== 'string') continue;
    let value: ModelItem; try { value = JSON.parse(item.content) as ModelItem; } catch { continue; }
    if (Number.isSafeInteger(value?.revision)) return value.revision as number;
  }
  throw new Error('REQUEST_REVISION_MISSING');
}

export function historicalReply(response: ModelItem): ModelReply {
  const output = response.output as ModelItem[];
  assert.ok(Array.isArray(output), 'RESPONSE_OUTPUT_MISSING');
  return { id: String(response.id), model: String(response.model), output,
    calls: output.filter(item => item.type === 'function_call').map(item => ({ callId: String(item.call_id), name: String(item.name), arguments: String(item.arguments) })),
    usage: response.usage as Record<string,unknown> ?? null };
}

/** 原件只读；输出目录必须不存在，历史回答不参与模型输入或评分标准。 */
export async function extractSuite(selections: Selection[], output: string): Promise<void> {
  assert.ok(selections.length > 0 && selections.every(item => validId(item.id)), 'INVALID_CASE_ID');
  assert.equal(new Set(selections.map(item => item.id)).size, selections.length, 'DUPLICATE_CASE_ID');
  await mkdir(dirname(output), { recursive: true }); await mkdir(output);
  const suite: Suite = { schemaVersion: 1, createdAt: new Date().toISOString(), files: {}, cases: [] };
  const grouped = new Map<string,Selection[]>();
  for (const item of selections) { const path=resolve(item.matchDir);grouped.set(path,[...(grouped.get(path)??[]),item]); }
  for (const [matchDir, selected] of grouped) {
    const traceBytes = await readFile(join(matchDir, 'agent-trace.jsonl'));
    const journalBytes = await readFile(join(matchDir, 'journal.jsonl'));
    assert.ok(traceBytes.at(-1) === 10 && journalBytes.at(-1) === 10, 'SOURCE_INCOMPLETE_LINE');
    const wanted = new Set(selected.map(item => item.callId)), sessions = new Map<string,PlayerId>();
    const starts = new Map<string,{ row: ModelItem; line: number }>(), finishes = new Map<string,ModelItem>();
    const toolFinishes: { row:ModelItem; line:number }[]=[];
    let line = 0;
    for (const text of traceBytes.toString('utf8').trimEnd().split('\n')) {
      line++; const row = JSON.parse(text) as ModelItem;
      if (row.kind === 'context_created') sessions.set(String(row.sessionId), row.playerId as PlayerId);
      if (row.kind === 'tool_finished') toolFinishes.push({row,line});
      if (row.kind === 'model_started' && wanted.has(String(row.callId))) {
        assert.equal(row.attempt, 0, 'EXTRACTION_REQUIRES_FIRST_ATTEMPT');
        assert.ok(!starts.has(String(row.callId)), 'DUPLICATE_CALL_ATTEMPT'); starts.set(String(row.callId), { row, line });
      }
      if (row.kind === 'model_finished' && wanted.has(String(row.callId))) finishes.set(String(row.callId), row);
    }
    const records = journalBytes.toString('utf8').trimEnd().split('\n').map(text => JSON.parse(text) as MatchRecord);
    const matchId = records[0]!.state.id; assert.ok(validId(matchId), 'INVALID_MATCH_ID');
    const cases: FrozenCase[] = [];
    for (const selection of selected) {
      const start = starts.get(selection.callId), finish = finishes.get(selection.callId);
      assert.ok(start && finish, `CALL_NOT_COMPLETED: ${selection.callId}`);
      assert.equal(start.row.role, 'player', 'ONLY_PLAYER_REQUESTS_SUPPORTED');
      const wire = start.row.request as ModelItem;
      if (typeof start.row.requestHash === 'string') assert.equal(digest(wire),start.row.requestHash,'SOURCE_REQUEST_HASH_MISMATCH');
      assert.ok(Array.isArray(wire.input), 'RESPONSES_INPUT_REQUIRED');
      const normalized = portableInput(wire.input as ModelItem[]), revision = requestRevision(normalized.input);
      const playerId = sessions.get(String(start.row.sessionId)); assert.ok(playerId === 'A' || playerId === 'B', 'SEAT_MISSING');
      // rejected/runtime 记录不推进 revision，不能取该版本的最后一条，否则会带入未来失败。
      // 保留首次到达该版本的状态，以及本次 model_started 前工具反馈已证实的同版本记录。
      const requestIds=new Set<string>(),eventIds=new Set<string>(),knownPrefixes=new Set<string>();
      for(const finished of toolFinishes) {
        if(finished.line>=start.line) break;
        if(typeof finished.row.requestId==='string') {
          requestIds.add(finished.row.requestId);
          const seat=sessions.get(String(finished.row.sessionId));
          if(seat) knownPrefixes.add(`known:${digest([seat,finished.row.requestId])}`);
        }
        const receipt=finished.row.receipt as ModelItem|undefined;
        const eventId=receipt?.eventId ?? (receipt?.data as ModelItem|undefined)?.eventId;
        if(typeof eventId==='string') eventIds.add(eventId);
      }
      const atRevision=records.filter(record=>record.state.revision===revision),entry=atRevision[0];
      const observed=atRevision.findLast(record=>requestIds.has(record.request?.requestId??'') || eventIds.has(record.event?.A.id??'') || knownPrefixes.has(record.request?.requestId.split(':').slice(0,2).join(':')??''));
      const before=observed??entry;
      assert.ok(before?.meta.randomness && entry, 'FROZEN_STATE_OR_ENTROPY_MISSING');
      const tools = (wire.tools as ModelItem[]).map(tool => ({ name: String(tool.name), description: String(tool.description ?? ''), inputSchema: tool.parameters as TSchema, effect: 'command' as const }));
      const request: Omit<ModelRequest,'signal'> = { role: 'player', sessionId: `request-eval:${selection.id}`, instructions: String(wire.instructions), input: normalized.input, tools };
      const journalFile = `journal-${matchId}.jsonl`;
      cases.push({ schemaVersion: 1, id: selection.id, title: selection.title, rubric: selection.rubric, ruleRefs: selection.ruleRefs, oracle: selection.oracle,
        source: { matchId, callId: selection.callId, playerId, revision, sequence: before.sequence, traceLine: start.line, traceHash: digest(traceBytes), journalHash: digest(journalBytes),
          historyCutoff:{format:'trace-receipts-v1',revisionEntrySequence:entry.sequence,lastObservedSequence:observed?.sequence??null} },
        normalization: { format: 'portable-v1', removedReasoningItems: normalized.removedReasoningItems, originalInputHash: digest(wire.input) },
        originalWire: wire, request, inputHash: digest(request), historicalReply: historicalReply(finish.response as ModelItem), journalFile });
    }
    const cutoff = Math.max(...cases.map(item => item.source.sequence));
    const prefix = records.filter(record => record.sequence <= cutoff).map(record => JSON.stringify(record)).join('\n')+'\n';
    const journalFile = cases[0]!.journalFile;
    await writeFile(join(output, journalFile), prefix, { flag: 'wx', mode: 0o600 }); suite.files[journalFile] = digest(prefix);
    for (const item of cases) {
      const filename = `${item.id}.json`; await save(join(output, filename), item);
      suite.cases.push(filename); suite.files[filename] = digest(await readFile(join(output, filename)));
    }
    assert.equal(digest(await readFile(join(matchDir,'agent-trace.jsonl'))), digest(traceBytes), 'SOURCE_TRACE_CHANGED_DURING_EXTRACTION');
    assert.equal(digest(await readFile(join(matchDir,'journal.jsonl'))), digest(journalBytes), 'SOURCE_JOURNAL_CHANGED_DURING_EXTRACTION');
  }
  await save(join(output,'manifest.json'),suite);
}

export async function loadSuite(directory: string): Promise<FrozenCase[]> {
  const suite = await json<Suite>(join(directory,'manifest.json')); assert.equal(suite.schemaVersion,1);
  for (const [name, hash] of Object.entries(suite.files)) {
    assert.ok(!name.includes('/') && !name.includes('\\') && name !== '..', 'INVALID_SUITE_FILE');
    assert.equal(digest(await readFile(join(directory,name))),hash,`SUITE_HASH_MISMATCH: ${name}`);
  }
  for (const name of suite.cases) assert.ok(suite.files[name] && /^[a-zA-Z0-9_-]+\.json$/.test(name),'UNVERIFIED_CASE_FILE');
  const cases = await Promise.all(suite.cases.map(name => json<FrozenCase>(join(directory,name))));
  for (const item of cases) { assert.equal(digest(item.request),item.inputHash,'INPUT_HASH_MISMATCH'); assert.ok(suite.files[item.journalFile]); }
  return cases;
}

export async function loadJournal(directory:string,filename:string):Promise<MatchRecord[]> {
  assert.ok(/^[a-zA-Z0-9_-]+\.jsonl(?:\.br)?$/.test(filename),'INVALID_JOURNAL_FILE');
  const bytes=await readFile(join(directory,filename));
  const text=(filename.endsWith('.br')?brotliDecompressSync(bytes):bytes).toString('utf8');
  return text.trimEnd().split('\n').map(line=>JSON.parse(line) as MatchRecord);
}

/** 数据包路径相对题目索引，使整个问题集可以随仓库或目录一起迁移。 */
export async function verifyRequestBank(bankFile:string,directory?:string) {
  const bytes=await readFile(bankFile),bank=JSON.parse(bytes.toString('utf8')) as RequestBank;
  assert.equal(bank.schemaVersion,1,'UNSUPPORTED_BANK_VERSION');
  assert.ok(validId(bank.id) && Array.isArray(bank.questions) && bank.questions.length>0,'INVALID_REQUEST_BANK');
  assert.ok(typeof bank.grading?.automatic==='string' && typeof bank.grading?.manual==='string','BANK_GRADING_REQUIRED');
  const suite=directory?resolve(directory):resolve(dirname(bankFile),bank.fixture.directory),manifestHash=digest(await readFile(join(suite,'manifest.json')));
  assert.equal(manifestHash,bank.fixture.manifestHash,'BANK_MANIFEST_HASH_MISMATCH');
  const cases=await loadSuite(suite);
  assert.deepEqual(bank.questions.map(item=>item.id),cases.map(item=>item.id),'BANK_CASES_MISMATCH');
  for(const [index,item] of cases.entries()) {
    const question=bank.questions[index]!;
    assert.equal(question.category,item.oracle.kind==='state_safety'?'anomaly':'flow','BANK_CATEGORY_MISMATCH');
    for(const key of ['title','source','inputHash','oracle'] as const) assert.equal(digest(question[key]),digest(item[key]),`BANK_CASE_MISMATCH:${item.id}:${key}`);
    assert.ok(question.manualReview?.length>0 && question.manualReview.every(text=>typeof text==='string' && text.trim().length>0),'BANK_REVIEW_REQUIRED');
  }
  return {schemaVersion:1,bankId:bank.id,bankHash:digest(bytes),suite,manifestHash,cases:cases.length,
    flowChecks:bank.questions.filter(item=>item.category==='flow').length,anomalyChecks:bank.questions.filter(item=>item.category==='anomaly').length,manualReviewRequired:true};
}

interface Execution { request: ToolRequest; receipt: ToolReceipt; state: GameState }
export interface Check { name: string; passed: boolean; detail: string }
const ids = (state: GameState, zone: string) => state.zones[zone]?.contents.items.flatMap(item => item?.kind === 'card' ? [item.id] : []) ?? [];

/** 这些是选样者声明的场景检查，并非正式牌桌的通用规则校验。只比较新增异常。 */
function safetyChecks(checks:SafetyCheck[],before:GameState,executions:Execution[],player:PlayerId):Check[] {
  const card=(state:GameState,id:string)=>state.definitions[state.cards[id]!.definitionId]!;
  const benchCards=(state:GameState)=>state.zones[`${player}:bench`]!.contents.items.flatMap(item=>!item?[]:item.kind==='card'?[item.id]:state.groups[item.id]!.stack);
  const states=executions.filter(step=>step.receipt.status==='committed').map(step=>step.state);
  return checks.map(check=>{
    if(check.kind==='no_rejected_operation') return {name:check.kind,passed:executions.length>0 && executions.every(step=>step.receipt.status!=='rejected'),detail:'本次有效执行不得再次使用不存在的卡牌组或已占用槽位；不检查整局策略质量。'};
    const violations=(state:GameState):Set<string>=>{
      if(check.kind==='bench_from_deck') {
        const old=new Set(benchCards(before)),fromDeck=new Set(ids(before,`${player}:deck`));
        return new Set(benchCards(state).filter(id=>!old.has(id)&&fromDeck.has(id)).filter(id=>{
          const c=card(state,id);return c.kind!=='pokemon'||c.stage!==check.stage||c.hp>check.maxHp;
        }));
      }
      if(check.kind==='new_stadium_group') return new Set(state.zones.stadium!.contents.items.flatMap(item=>item?.kind==='group'?[item.id]:[]));
      if(check.kind==='new_item_attachment') return new Set(Object.values(state.groups).flatMap(group=>group.attached.filter(id=>{const c=card(state,id);return c.kind==='trainer'&&c.subtype==='item';}).map(id=>`${group.id}:${id}`)));
      const result=new Set<string>();
      for(const group of Object.values(state.groups)) for(let i=1;i<group.stack.length;i++) {
        const lower=card(state,group.stack[i-1]!),upper=card(state,group.stack[i]!);
        if(lower.kind!=='pokemon'||upper.kind!=='pokemon'||!upper.evolvesFrom) continue;
        // 基础直接到2阶时允许卡组中存在的完整进化链，是否满足跳阶效果与时机另审。
        const hasIntermediate=lower.stage==='基础'&&Object.values(state.definitions).some(c=>c.kind==='pokemon'&&c.name===upper.evolvesFrom&&c.evolvesFrom===lower.name);
        if(upper.evolvesFrom!==lower.name&&!hasIntermediate) result.add(`${group.id}:${group.stack[i-1]}:${group.stack[i]}`);
      }
      return result;
    };
    const old=violations(before),added=[...new Set(states.flatMap(state=>[...violations(state)].filter(key=>!old.has(key))))];
    return {name:check.kind,passed:added.length===0,detail:`仅核对本场景声明的新增异常；新增 ${added.length} 项。已有错误、其他卡牌例外和行动完成度另审。`};
  });
}

/** 评分只覆盖每个样本预先声明的规则事实，不将历史模型行动当成唯一答案。 */
export function outcomeChecks(item: Pick<FrozenCase,'oracle'|'source'>, before: GameState, executions: Execution[]): Check[] {
  const successful = executions.filter(step => step.receipt.status === 'committed' || step.receipt.status === 'read');
  const player = item.source.playerId, hand = `${player}:hand`, deck = `${player}:deck`;
  if(item.oracle.kind==='state_safety') return safetyChecks(item.oracle.checks,before,executions,player);
  if (item.oracle.kind === 'turn_draw') {
    const first = successful.find(step => step.request.tool !== 'declare'); const top = ids(before,deck)[0];
    const passed = !!first && first.request.tool === 'move' && ids(first.state,hand).includes(top!) && ids(first.state,hand).length === ids(before,hand).length+1 && ids(first.state,deck).length === ids(before,deck).length-1;
    return [{ name:'turn_draw',passed,detail:'首个实际操作从本席位牌库顶部抽1张；允许先宣告。' }];
  }
  if (item.oracle.kind === 'top_partition') {
    assert.ok(item.oracle.count >= 2 && item.oracle.count <= 5, 'INVALID_PARTITION_COUNT');
    const viewed = ids(before,deck).slice(0,item.oracle.count);
    let handChosen = false, complete = false;
    for (const step of successful) {
      const selected = viewed.filter(id => ids(step.state,hand).includes(id) && !ids(before,hand).includes(id));
      handChosen ||= selected.length === 1;
      const rest = viewed.filter(id => !selected.includes(id));
      complete ||= selected.length === 1 && rest.every(id => ids(step.state,deck).slice(-rest.length).includes(id));
    }
    const noShuffle = !successful.some(step => step.request.tool === 'shuffle');
    return [{ name:'choose_known_card',passed:handChosen,detail:'仅从已查看的指定集合选择1张加入手牌，允许不同合法选择。' },
      { name:'finish_partition',passed:complete && noShuffle,detail:'在本次有效前缀内将剩余卡牌归底；本效果不洗牌。' }];
  }
  const responding = successful.find(step => step.request.tool === 'respond');
  const response = (responding?.request.arguments as { response?: { kind?:string; reason?:string; evidenceRefs?:string[] } } | undefined)?.response;
  const correctKind = response?.kind === item.oracle.response;
  const reason = response?.reason ?? '';
  const explained = item.oracle.reasonGroups.every(group => group.some(text => reason.includes(text)));
  return [{ name:'dispute_position',passed:correctKind,detail:`本场景应提交${item.oracle.response}，不能接受错误处置。` },
    { name:'dispute_explanation',passed:correctKind && explained && !!response?.evidenceRefs?.length,detail:'辩护需覆盖预先声明的规则要点并引用实际证据；关键词检查仍需人工复核解释。' }];
}

export async function executeCandidate(item: FrozenCase, prefix: MatchRecord[], reply: ModelReply, output: string) {
  await mkdir(output);
  const relevant = prefix.filter(row => row.sequence <= item.source.sequence);
  const last = relevant.at(-1)!; assert.equal(last.state.revision,item.source.revision);
  assert.ok(last.meta.randomness,'ENTROPY_REQUIRED');
  const match = new MatchRuntime({ directory: output, entropy: new ReplayEntropy(last.meta.randomness) });
  // 不调用 recover/createFromScenario，避免恢复时 pump 或重新执行开局。
  match.records = structuredClone(relevant); match.state = structuredClone(last.state); match.meta = structuredClone(last.meta);
  const before = structuredClone(match.state), executions: Execution[] = [], events: ModelItem[] = [];
  let stop = false, generated = 0;
  const trace: TraceSink = { async append(event) {
    events.push(structuredClone(event));
    if (['sequence_finished','tool_rejected','decision_rejected'].includes(String(event.kind)) || (event.kind === 'tool_finished' && reply.calls[0]?.name !== 'execute_sequence')) stop=true;
  } };
  const port = { async observe(...args: Parameters<MatchRuntime['observe']>) { const frame = await match.observe(...args); return stop ? { ...frame,status:'waiting' as const } : frame; },
    async execute(request: ToolRequest) { const receipt=await match.execute(request); executions.push({ request:structuredClone(request),receipt:structuredClone(receipt),state:structuredClone(match.state) }); return receipt; } };
  const runtime = new AgentRuntime({ match:port,model:{ async generate() { assert.equal(++generated,1,'ONE_DECISION_ONLY'); return structuredClone(reply); } },store:new MemorySessionStore(),trace,prompts:last.meta.prompts,limits:{ maxDecisionsPerActivation:1 } });
  await runtime.create({ matchId:item.source.matchId,playerId:item.source.playerId,deck:{},strategy:{version:0,content:''},rules:last.meta.rules });
  const activation=await runtime.activate(item.source.matchId,item.source.playerId);
  const call=reply.calls[0],definition=item.request.tools.find(tool => tool.name===call?.name);
  let schemaError: string | null = null;
  try { schemaError=definition && call ? validationError(definition.inputSchema,JSON.parse(call.arguments)) : 'TOOL_UNAVAILABLE'; }
  catch { schemaError='ARGUMENTS_JSON_INVALID'; }
  const protocolPassed=reply.calls.length===1 && schemaError===null;
  const executionPassed=protocolPassed && executions.length>0 && executions.every(step => step.receipt.status!=='rejected') && !events.some(event => event.kind==='tool_rejected');
  const checks=outcomeChecks(item,before,executions);
  const result={ protocolPassed,schemaError,executionPassed,checks,passed:executionPassed && checks.every(check=>check.passed),activation,
    executions:executions.map(({state:_state,...step})=>step),sequence:events.findLast(event=>event.kind==='sequence_finished') ?? null };
  await save(join(output,'execution.json'),result); await save(join(output,'after.json'),{state:match.state,meta:match.meta});
  return result;
}

async function sourceHashes(): Promise<Record<string,string>> {
  const paths:string[]=['package.json','package-lock.json'];
  async function walk(path:string) { for (const entry of await readdir(path,{withFileTypes:true})) { const p=join(path,entry.name); if(entry.isDirectory()) await walk(p); else if(entry.name.endsWith('.ts') || entry.name.endsWith('.json') || entry.name.endsWith('.md') || entry.name.endsWith('.br')) paths.push(p); } }
  for(const root of ['scripts','evals','packages/agent','packages/protocol/src','packages/game-core/src','apps/server/src','rules']) await walk(root);
  return Object.fromEntries(await Promise.all(paths.sort().map(async path=>[path,digest(await readFile(path))])));
}

export interface Variant { id:string; configFile:string }
export async function runSuite(suiteDir:string, variants:Variant[], output:string, options:{ repeats?:number; timeoutMs?:number; toolChoice?:'forced'|'auto';bankFile?:string }={}) {
  const bank=options.bankFile?await verifyRequestBank(options.bankFile,suiteDir):undefined;
  const cases=await loadSuite(suiteDir),repeats=options.repeats??1,timeoutMs=options.timeoutMs??120000;
  assert.ok(Number.isSafeInteger(repeats) && repeats>=1 && repeats<=20,'INVALID_REPEATS');
  assert.ok(variants.length>0 && variants.every(v=>validId(v.id)) && new Set(variants.map(v=>v.id)).size===variants.length,'INVALID_VARIANTS');
  await mkdir(dirname(output),{recursive:true});await mkdir(output);
  const hashes=await sourceHashes();await save(join(output,'source-hashes.json'),hashes);
  await save(join(output,'suite-manifest.json'),await json(join(suiteDir,'manifest.json')));
  if(bank) await save(join(output,'bank-verification.json'),bank);
  const configs=new Map<string,ModelConfig>();
  for(const variant of variants) { const config=await loadModelConfig(variant.configFile); configs.set(variant.id,{...config,cacheKeyStrategy:'disabled',maxRetries:0,timeoutMs}); }
  await save(join(output,'variants.json'),Object.fromEntries([...configs].map(([id,c])=>[id,{ model:c.model,reasoningEffort:c.reasoningEffort,fast:c.fast,timeoutMs,protocol:c.connection.kind==='local_codex_credentials'?'responses':c.connection.protocol }])));
  const results:ModelItem[]=[];
  for(let repeat=0;repeat<repeats;repeat++) for(const [caseIndex,item] of cases.entries()) {
    const prefix=await loadJournal(suiteDir,item.journalFile);
    // 按场景轮换首发组；逐个请求，避免本机并发压测干扰延迟。
    const ordered=variants.map((_,index)=>variants[(index+caseIndex+repeat)%variants.length]!);
    for(const variant of ordered) {
      const runId=`${item.id}-${variant.id}-${repeat+1}`,dir=join(output,runId);await mkdir(dir);
      const redactor=new SecretRedactor(),trace=new JsonlTrace(join(dir,'model-trace.jsonl'),redactor),config=configs.get(variant.id)!;
      assert.equal(digest(item.request),item.inputHash,'INPUT_MUTATED');
      const request:ModelRequest={...structuredClone(item.request),...(options.toolChoice!=='auto' && item.request.tools.length===1?{toolChoice:item.request.tools[0]!.name}:{})};
      const requestHash=digest(request);await save(join(dir,'input.json'),request);
      const started=Date.now();let result:ModelItem;let stage='model';let modelElapsedMs:number|undefined;
      try {
        const reply=await createModel(config,trace,redactor).generate(request),elapsedMs=Date.now()-started;
        modelElapsedMs=elapsedMs;stage='execution';
        await save(join(dir,'reply.json'),reply);
        const scored=await executeCandidate(item,prefix,reply,join(dir,'execution'));
        result={caseId:item.id,title:item.title,variant:variant.id,repeat:repeat+1,inputHash:item.inputHash,requestHash,requestCompleted:true,elapsedMs,usage:tokenUsage(reply.usage),...scored};
      } catch(error) {
        result={caseId:item.id,title:item.title,variant:variant.id,repeat:repeat+1,inputHash:item.inputHash,requestHash,requestCompleted:stage!=='model',elapsedMs:modelElapsedMs??Date.now()-started,errorStage:stage,error:redactor.clean(error instanceof Error?error.message:String(error)),passed:false};
      }
      await trace.flush();await save(join(dir,'result.json'),result);results.push(result);
      await writeFile(join(output,'results.partial.json'),JSON.stringify(results,null,2)+'\n',{mode:0o600});
      console.log(JSON.stringify({case:item.id,variant:variant.id,elapsedMs:result.elapsedMs,protocol:result.protocolPassed,execution:result.executionPassed,passed:result.passed,error:result.error}));
    }
  }
  const after=await sourceHashes(),stable=JSON.stringify(hashes)===JSON.stringify(after);
  const summary=variants.map(variant=>{const rows=results.filter(row=>row.variant===variant.id),times=rows.filter(row=>row.requestCompleted).map(row=>row.elapsedMs as number).sort((a,b)=>a-b);return {variant:variant.id,samples:rows.length,completed:times.length,passed:rows.filter(row=>row.passed).length,protocolPassed:rows.filter(row=>row.protocolPassed).length,executionPassed:rows.filter(row=>row.executionPassed).length,errors:rows.filter(row=>row.error).length,meanMs:times.length?Math.round(times.reduce((a,b)=>a+b,0)/times.length):null,medianMs:!times.length?null:times.length%2?times[Math.floor(times.length/2)]!:(times[times.length/2-1]!+times[times.length/2]!)/2};});
  const report={schemaVersion:1,createdAt:new Date().toISOString(),suite:resolve(suiteDir),...(bank?{bank}:{}),automatedChecksOnly:true,toolChoice:options.toolChoice??'forced',repeats,sourceStable:stable,summary,results};
  await save(join(output,'report.json'),report);
  const seconds=(ms:number|null)=>ms===null?'无完成样本':(ms/1000).toFixed(2)+' 秒';
  const md=['# 固定请求评测','',`每组每场景 ${repeats} 次；工具方式 ${report.toolChoice}；源码${stable?'稳定':'运行期间发生变化，结果待复核'}。`,'','| 配置 | 响应完成 | 自动检查通过 | 协议通过 | 执行通过 | 完成请求平均耗时 | 中位耗时 |','|---|---:|---:|---:|---:|---:|---:|',...summary.map(row=>`| ${row.variant} | ${row.completed}/${row.samples} | ${row.passed}/${row.samples} | ${row.protocolPassed}/${row.samples} | ${row.executionPassed}/${row.samples} | ${seconds(row.meanMs)} | ${seconds(row.medianMs)} |`),'','自动检查覆盖样本预先声明的事实。规则正确性、额外副作用和行动完成度按问题集清单另行复核；读取历史或提交宣告不能直接计为完成。未执行后缀不计成功，错误与超时单列，失败请求不混入完成请求的耗时均值。原始输入、模型轨迹、回复、隔离执行及逐项评分见同目录 JSON。',''].join('\n');
  await writeFile(join(output,'报告.md'),md,{flag:'wx',mode:0o600});assert.ok(stable,'SOURCE_CHANGED_DURING_RUN');
  return report;
}

async function main() {
  const [command,input,...args]=process.argv.slice(2);
  const option=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  assert.ok(input,'INPUT_REQUIRED');
  if(command==='verify') { console.log(JSON.stringify(await verifyRequestBank(resolve(input),option('--suite'))));return; }
  const output=option('--output');assert.ok(output,'用法: node scripts/request-eval.ts verify <问题集JSON> [--suite <数据集目录>] | extract <选样JSON> --output <新数据集目录> | run <数据集目录> --matrix <配置矩阵JSON> --output <新结果目录> [--bank <问题集JSON>] [--repeats 1] [--tool-choice forced|auto]');
  if(command==='extract') { const selections=await json<Selection[]>(input);await extractSuite(selections,resolve(output));console.log('SUITE '+resolve(output)); }
  else if(command==='run') { const matrix=option('--matrix');assert.ok(matrix,'MATRIX_REQUIRED');const variants=await json<Variant[]>(matrix);const mode=option('--tool-choice')??'forced';assert.ok(mode==='auto'||mode==='forced','INVALID_TOOL_CHOICE');const bankFile=option('--bank');const report=await runSuite(resolve(input),variants.map(v=>({...v,configFile:resolve(dirname(matrix),v.configFile)})),resolve(output),{repeats:Number(option('--repeats')??1),timeoutMs:Number(option('--timeout-ms')??120000),toolChoice:mode,...(bankFile?{bankFile:resolve(bankFile)}:{})});console.log(JSON.stringify(report.summary)); }
  else throw new Error('UNKNOWN_COMMAND');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
