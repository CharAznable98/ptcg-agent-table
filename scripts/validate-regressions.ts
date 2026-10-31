import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { Type, type TSchema } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import { MatchRuntime,asJson } from '../apps/server/src/match.ts';
import { ReplayEntropy } from '../apps/server/src/entropy.ts';
import { executeCore,projectTable } from '../packages/game-core/src/index.ts';
import { AgentRuntime,FileSessionStore,JsonlTrace,createModel,loadModelConfig,loadPrompts,UsageAccumulator,DEFAULT_LIMITS } from '../packages/agent/src/index.ts';
import { parseStructured } from '../packages/agent/src/schema.ts';
import { modelToolDefinition,decodeActionArguments } from '../packages/agent/src/action-codec.ts';
import { reviewFactGroups, type ReviewStage } from '../packages/agent/src/strategy-review.ts';
import { userMessage } from '../packages/agent/src/context.ts';
import { atomicJson } from '../packages/agent/src/storage.ts';
import type { ReviewFact } from '../packages/agent/src/schema.ts';
import type { PlayerId,GameCommand,OpponentRecord } from '../packages/protocol/src/index.ts';
import type { ModelItem,Json } from '../packages/agent/src/types.ts';

// 只复验已完成局的原始错误场景及赛后核验，不启动新整局，不改历史运行。
const root=resolve(import.meta.dirname,'..'),matchId=process.argv[2]!;
const directory=join(root,'data/matches',matchId),match=new MatchRuntime({directory});await match.recover();
assert.equal(match.state.flow.phase,'finished');
const config=await loadModelConfig(join(root,'system/agent.json')),prompts=await loadPrompts(join(root,'system/prompts.json'));
assert.equal(config.model,'gpt-6.1-terra');assert.equal(config.reasoningEffort,'medium');assert.equal(config.fast,false);
const trace=new JsonlTrace(join(root,'regression-trace.jsonl')),model=createModel(config,trace,trace.redactor);
const original=(await readFile(join(directory,'agent-trace.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as ModelItem);
const store=new FileSessionStore(join(directory,'contexts')),result:{moves:unknown[];facts:unknown[];summaries:unknown[]}={moves:[],facts:[],summaries:[]};
const structured=async<T>(sessionId:string,stage:string,input:unknown,schema:TSchema,validate?:(value:T)=>void|Promise<void>):Promise<T>=>{
 let last:unknown;
 for(let attempt=0;attempt<3;attempt++){
  const reply=await model.generate({role:'summary',sessionId,instructions:prompts.summary,input:[userMessage(input),...(last?[userMessage({validationError:String(last)})]:[])],tools:[{name:'submit_result',description:prompts.toolDescriptions.submit_result!,inputSchema:schema,effect:'read'}],toolChoice:'submit_result'});
  try{assert.equal(reply.calls.length,1);assert.equal(reply.calls[0]!.name,'submit_result');const value=parseStructured<T>(schema,JSON.parse(reply.calls[0]!.arguments));await validate?.(value);return value;}
  catch(error){last=error;await trace.append({kind:'regression_result_rejected',stage,attempt,error:String(error)});}
 }
 throw last;
};
for(const [index,row] of match.records.entries()){
 if(row.receipt?.status!=='rejected'||row.receipt.error.code!=='OUT_OF_RANGE'||row.request?.command.kind!=='move')continue;
 const before=match.records[index-1]!,command=row.request.command as Extract<GameCommand,{kind:'move'}>;
 assert.equal(command.source.container.kind,'zone');assert.equal(command.destination.container.kind,'zone');
 assert.equal(command.source.container.zoneId,command.destination.container.zoneId);
 const fixed:GameCommand={...command,destination:{...command.destination,index:'end'}};
 const pure=executeCore(before.state,fixed,row.actor!,new ReplayEntropy(before.meta.randomness!));
 assert.equal(pure.changed,true);assert.equal((pure.result as {destinationIndex:number}).destinationIndex,pure.state.zones[command.destination.container.zoneId]!.contents.items.length-1);
 assert.deepEqual(pure.state.zones[command.destination.container.zoneId]!.contents.items.at(-1),before.state.zones[command.source.container.zoneId]!.contents.items[0]);
 const actor=(row.actor as {kind:'player';playerId:PlayerId}).playerId,sessionId=`bottom-regression:${index}:${randomUUID()}`;
 await trace.append({kind:'context_created',sessionId,matchId,playerId:actor});
 const port=new MatchRuntime({directory:join(root,'unused-player-port')});port.state=before.state;port.meta={...before.meta,prompts};port.records=match.records.slice(0,index);
 const catalog=port.tools(actor,true),move=catalog.find(tool=>tool.name==='move')!;
 const wrapper={name:'execute_sequence',description:prompts.toolDescriptions.execute_sequence!,effect:'command' as const,inputSchema:Type.Object({actions:Type.Array(Type.Union(catalog.map(tool=>Type.Object({tool:Type.Literal(tool.name),arguments:modelToolDefinition(tool).inputSchema},{additionalProperties:false}))),{minItems:1,maxItems:16})},{additionalProperties:false})};
 const reply=await model.generate({role:'player',sessionId,instructions:prompts.player+'\n\n'+prompts.feedback.positionEncoding+'\n\n'+prompts.feedback.playerRulesHeading+'\n'+before.meta.rules,
  input:[userMessage({validationOnly:true,snapshot:projectTable(before.state,actor),execution:{argumentFormat:'ptcg-positions-v1',maxActionsPerDecision:16,availableTools:catalog.map(t=>t.name)},mechanicalStep:{source:`${command.source.container.zoneId}/0`,destination:`${command.destination.container.zoneId}/end`,instruction:'本次仅复验已确定的机械步骤：将当前牌库顶部1张放回同一牌库底部。只提交这一个move，末尾交给程序计算；不进行新的对战选择。'}})],tools:[wrapper],toolChoice:'execute_sequence'});
 assert.equal(reply.calls.length,1);assert.equal(reply.calls[0]!.name,'execute_sequence');
 const actions=(JSON.parse(reply.calls[0]!.arguments)as{actions:{tool:string;arguments:Json}[]}).actions;assert.equal(actions.length,1);assert.equal(actions[0]!.tool,'move');
 const decoded=decodeActionArguments(move,actions[0]!.arguments) as unknown as Omit<Extract<GameCommand,{kind:'move'}>,'kind'>;
 assert.equal(decoded.destination.index,'end');assert.deepEqual(decoded.source,command.source);
 const played=executeCore(before.state,{kind:'move',...decoded},row.actor!,new ReplayEntropy(before.meta.randomness!));assert.deepEqual(played.state,pure.state);
 result.moves.push({revision:before.state.revision,oldError:row.receipt.error.code,oldIndex:command.destination.index,resolvedIndex:(played.result as{destinationIndex:number}).destinationIndex,modelReply:reply.calls[0],passed:true});
}
assert.equal(result.moves.length,2);
for(const actor of ['A','B']as const){
 const session=(await store.load(matchId,actor))!;await trace.append({kind:'context_loaded',sessionId:session.sessionId,matchId,playerId:actor});
 const target=actor==='A'?'counter_reset':'two_bombs_attack';
 const notes=original.find(e=>e.kind==='strategy_fact_notes'&&e.playerId===actor)!.facts as ReviewFact[];
 const fact=notes.find(f=>f.id.endsWith('.'+target))!;assert.ok(fact);
 const frame=await match.observe(matchId,actor,null);
 const reviewed=await reviewFactGroups({facts:[fact],observations:session.observations,currentPublicInPlayFacts:(frame.snapshot as unknown as{inPlayFacts:Record<string,unknown>[]}).inPlayFacts,fixed:{matchId,playerId:actor},budget:Math.floor(DEFAULT_LIMITS.maxReviewInputBytes*.72),rules:match.meta.rules,trace,
  structured:<T>(stage:ReviewStage,input:unknown,schema:TSchema,validate?: (value:T)=>void|Promise<void>)=>structured<T>(`summary:${session.sessionId}:evidence-regression`,stage,input,schema,validate)});
 assert.equal(reviewed[0]!.assessment.status,'supported',JSON.stringify(reviewed[0]!.assessment));
 assert.equal(reviewed[0]!.verificationScope,'observed_events');result.facts.push({playerId:actor,reviewed:reviewed[0],passed:true});
}
const runtime=new AgentRuntime({model,match,store,trace,prompts});
await Promise.all((['A','B']as const).map(async actor=>{
 const opponentId=match.state.players.find(p=>p.id===actor)!.opponentId!;
 const opponent=JSON.parse(await readFile(join(root,'data/opponents',opponentId+'.json'),'utf8'))as OpponentRecord;
 const latest=opponent.strategies.at(-1)!;assert.equal(latest.version,2);
 const update=await runtime.summarize(matchId,actor,latest);assert.ok(update.policy?.plan?.trim());
 result.summaries.push({playerId:actor,sourceOpponentId:opponentId,baseVersion:latest.version,update});
}));
await trace.flush();const usage=new UsageAccumulator();for(const line of(await readFile(join(root,'regression-trace.jsonl'),'utf8')).trim().split('\n'))usage.add(JSON.parse(line));
await atomicJson(join(root,'regression-results.json'),{status:'passed',scope:'2个原始底部错误点+2条错误事实原件核验+同局双方完整复盘重做，非新整局',...result,usage:usage.report()});
console.log(JSON.stringify({status:'passed',moves:result.moves.length,facts:result.facts.length,summaries:result.summaries.length,usage:usage.report().totals}));
