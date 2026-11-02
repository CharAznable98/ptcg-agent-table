import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MatchRuntime } from '../src/match.ts';
import { loadDefaultPrompts } from '../../../packages/agent/src/prompts.ts';
import { digest, executeCandidate, extractSuite, loadJournal, loadSuite, outcomeChecks, portableInput, runSuite, verifyRequestBank } from '../../../scripts/request-eval.ts';
import type { ModelReply, ToolRequest } from '../../../packages/agent/src/types.ts';

async function fixture(t: TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'ptcg-request-eval-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const matchDir=join(dir,'source');
  const card={kind:'pokemon' as const,name:'合成样本',hp:60,types:[],stage:'基础',abilities:[],attacks:[],weaknesses:[],resistances:[],retreatCost:0};
  const deck={name:'合成卡组',cards:[{count:60,card}]};
  const match=new MatchRuntime({directory:matchDir});
  await match.create({id:'synthetic-eval',mode:'local',players:[{id:'A',name:'A',kind:'human',deck},{id:'B',name:'B',kind:'human',deck}],prompts:await loadDefaultPrompts(),model:{schemaVersion:1,model:'test',reasoningEffort:'medium',fast:false,connection:{kind:'local_codex_credentials'}},strategies:{},rules:''});
  while(match.state.flow.choice) {
    const choice=match.state.flow.choice;
    assert.ok(choice.kind==='choose_first' || choice.kind==='initial_placement');
    await match.command(choice.playerId,{requestId:randomUUID(),revision:match.state.revision,command:choice.kind==='choose_first'?{kind:'choose_first',firstPlayer:'A'}:{kind:'initial_placement',active:{zoneId:`${choice.playerId}:hand`,index:0},bench:[]}});
  }
  const revision=match.state.revision,move=match.tools('A').find(tool=>tool.name==='move')!;
  const args={source:{container:{kind:'zone',zoneId:'A:deck'},range:{mode:'range',start:0,count:1}},destination:{container:{kind:'zone',zoneId:'A:hand'},index:0}} as const;
  const reject=async(requestId:string)=>match.command('A',{requestId,revision,command:{kind:'move',...args,source:{...args.source,range:{mode:'range',start:9999,count:1}}}});
  const priorReceipt=await reject('prior-failure');assert.equal(priorReceipt.status,'rejected');
  const call={type:'function_call',call_id:'c',name:'move',arguments:JSON.stringify(args)};
  const wire={model:'test',instructions:'固定合成输入',input:[{role:'user',content:JSON.stringify({revision,visibleFact:'只看当时信息'})},{type:'reasoning',encrypted_content:'provider-only-state',summary:[]}],tools:[{type:'function',name:'move',parameters:move.inputSchema}]};
  const rows=[{kind:'context_created',sessionId:'s',playerId:'A'},{kind:'tool_finished',sessionId:'s',requestId:'prior-failure',receipt:{status:priorReceipt.status,revision,data:priorReceipt}},{kind:'model_started',callId:'call',attempt:0,role:'player',sessionId:'s',request:wire},{kind:'model_finished',callId:'call',attempt:0,response:{id:'r',model:'test',output:[call],usage:null}}];
  await writeFile(join(matchDir,'agent-trace.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  // 后续记录存在，但不能进入这个较早请求的输入或执行起点。
  assert.equal((await reject('FUTURE_REJECT_SENTINEL')).status,'rejected');
  await match.command('A',{requestId:randomUUID(),revision:match.state.revision,command:{kind:'declare',text:'FUTURE_SENTINEL'}});
  const selections=[{id:'draw',title:'合成抽牌',matchDir,callId:'call',rubric:'先从牌库顶部抽1张',ruleRefs:[],oracle:{kind:'turn_draw' as const}}];
  const suite=join(dir,'suite');await extractSuite(selections,suite);
  const item=(await loadSuite(suite))[0]!;
  const prefix=(await readFile(join(suite,item.journalFile),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const bank=join(dir,'bank.json');
  await writeFile(bank,JSON.stringify({schemaVersion:1,id:'synthetic-v1',fixture:{directory:suite,manifestHash:digest(await readFile(join(suite,'manifest.json')))},grading:{automatic:'合成抽牌检查',manual:'检查完整行动'},questions:[{id:item.id,title:item.title,category:'flow',inputHash:item.inputHash,source:item.source,oracle:item.oracle,manualReview:['先抽牌，实际进度另记']}]}));
  assert.ok(item.historicalReply);
  return {dir,matchDir,suite,item,prefix,call,args,bank,historicalReply:item.historicalReply};
}

test('固定输入仅删除提供方思考恢复项，保留原生调用反馈，拒绝悄悄丢弃媒体',()=>{
  const normalized=portableInput([{role:'user',content:'事实'},{type:'reasoning',encrypted_content:'private'},{type:'function_call',id:'private-id',call_id:'a',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'反馈'},{type:'message',role:'assistant',content:[{type:'output_text',text:'公开文本'}]}]);
  assert.equal(normalized.removedReasoningItems,1);
  assert.deepEqual(normalized.input,[{role:'user',content:'事实'},{type:'function_call',call_id:'a',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'反馈'},{role:'assistant',content:'公开文本'}]);
  assert.throws(()=>portableInput([{role:'user',content:[{type:'input_image',image_url:'x'}]}]),/UNSUPPORTED_MEDIA/);
});

test('从真实格式轨迹冻结请求，排除未来状态；原件不变，篡改样本会被散列拦截',async t=>{
  const {dir,matchDir,suite,item,prefix,historicalReply}=await fixture(t);
  const before=digest(await readFile(join(matchDir,'journal.jsonl')));
  assert.equal(item.normalization.removedReasoningItems,1);assert.equal(JSON.stringify(item.request).includes('provider-only-state'),false);
  assert.equal(JSON.stringify(prefix).includes('FUTURE_SENTINEL'),false);
  assert.equal(JSON.stringify(prefix).includes('prior-failure'),true);
  assert.equal(JSON.stringify(prefix).includes('FUTURE_REJECT_SENTINEL'),false);
  const replay=await executeCandidate(item,prefix,historicalReply,join(dir,'replay'));
  assert.equal(replay.passed,true);assert.equal(replay.executions.length,1);
  assert.equal(digest(await readFile(join(matchDir,'journal.jsonl'))),before);
  const changed={...item,title:'已篡改'};await writeFile(join(suite,'draw.json'),JSON.stringify(changed));
  await assert.rejects(loadSuite(suite),/SUITE_HASH_MISMATCH/);
});

test('语法可通过但动作无法执行时单列失败，纯文字不能作为完成；不重复请求模型',async t=>{
  const {dir,item,prefix,args}=await fixture(t);
  const bad={...args,source:{...args.source,range:{mode:'range',start:9999,count:1}}};
  const reply:ModelReply={id:'bad',model:'test',output:[],calls:[{callId:'c',name:'move',arguments:JSON.stringify(bad)}],usage:null};
  const result=await executeCandidate(item,prefix,reply,join(dir,'bad'));
  assert.equal(result.protocolPassed,true);assert.equal(result.executionPassed,false);assert.equal(result.passed,false);
  const text=await executeCandidate(item,prefix,{...reply,calls:[],output:[{role:'assistant',content:'计划'}]},join(dir,'text'));
  assert.equal(text.protocolPassed,false);assert.equal(text.executions.length,0);assert.equal(text.activation.decisions,1);
});

test('版本化问题集锁定数据包、输入来源和评分；请求前拒绝不匹配的数据集',async t=>{
  const {dir,suite,bank}=await fixture(t);
  const verified=await verifyRequestBank(bank);assert.equal(verified.cases,1);assert.equal(verified.manualReviewRequired,true);
  const original=JSON.parse(await readFile(bank,'utf8'));
  await writeFile(bank,JSON.stringify({...original,questions:[{...original.questions[0],oracle:{kind:'top_partition',count:2}}]}));
  await assert.rejects(verifyRequestBank(bank),/BANK_CASE_MISMATCH:draw:oracle/);
  await writeFile(bank,JSON.stringify({...original,questions:[{...original.questions[0],source:{...original.questions[0].source,sequence:9999}}]}));
  await assert.rejects(verifyRequestBank(bank),/BANK_CASE_MISMATCH:draw:source/);
  await writeFile(bank,JSON.stringify({...original,fixture:{...original.fixture,manifestHash:'bad'}}));
  await assert.rejects(runSuite(suite,[{id:'never-called',configFile:join(dir,'does-not-exist.json')}],join(dir,'must-not-run'),{bankFile:bank}),/BANK_MANIFEST_HASH_MISMATCH/);
});

test('仓库问题集复制到独立目录后可校验并离线回放全部控制样本',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ptcg-published-bank-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const copied=join(dir,'questions');
  await cp(fileURLToPath(new URL('../../../evals/requests/',import.meta.url)),copied,{recursive:true});
  const bank=join(copied,'v1.json'),verified=await verifyRequestBank(bank);
  assert.equal(verified.cases,8);assert.equal(verified.suite,join(copied,'fixtures/v1'));
  const cases=await loadSuite(verified.suite);
  const controls=JSON.parse(await readFile(join(verified.suite,'controls.json'),'utf8')) as {controls:{id:string;caseId:string;expectedAutomaticPass:boolean;reply:ModelReply}[]};
  assert.equal(controls.controls.length,13);
  assert.equal(new Set(controls.controls.map(control=>control.caseId)).size,cases.length);
  let currentFile='',prefix:Awaited<ReturnType<typeof loadJournal>>=[];
  for(const control of controls.controls) {
    const item=cases.find(item=>item.id===control.caseId)!;assert.ok(item);
    assert.equal(item.originalWire,undefined);assert.equal(item.historicalReply,undefined);
    assert.doesNotMatch(JSON.stringify(item.request),/encrypted_content|apiKeyFile|apiKeyEnv|access_token|refresh_token|\/Users\/|\/home\//);
    if(currentFile!==item.journalFile) {
      currentFile=item.journalFile;prefix=await loadJournal(verified.suite,currentFile);
      for(const row of prefix) assert.doesNotMatch(JSON.stringify(row.meta.model.connection),/apiKey|authFile|access_token|refresh_token|\/Users\/|\/home\//);
    }
    const result=await executeCandidate(item,prefix,control.reply,join(dir,control.id));
    assert.equal(result.protocolPassed,true,control.id);
    assert.equal(result.passed,control.expectedAutomaticPass,control.id);
  }
  assert.equal((await verifyRequestBank(bank)).bankHash,verified.bankHash);
});

test('规则检查允许不同合法选牌，分别报告选择和归底；异议不能以错误接受通过',async t=>{
  const {item,prefix}=await fixture(t),before=structuredClone(prefix.at(-1)!.state);
  const deck=before.zones['A:deck']!.contents.items,hand=before.zones['A:hand']!.contents.items;
  for(const index of [0,1]) {
    const after=structuredClone(before),chosen=after.zones['A:deck']!.contents.items.splice(index,1)[0]!;
    after.zones['A:hand']!.contents.items.push(chosen);
    const rest=after.zones['A:deck']!.contents.items.shift()!;after.zones['A:deck']!.contents.items.push(rest);
    const request:ToolRequest={matchId:before.id,playerId:'A',requestId:'r',revision:before.revision,tool:'move',arguments:{}};
    const checks=outcomeChecks({...item,oracle:{kind:'top_partition',count:2}},before,[{request,receipt:{status:'committed',revision:after.revision,data:{}},state:after}]);
    assert.ok(checks.every(check=>check.passed));
  }
  assert.ok(deck.length>2 && hand.length>0);
  const request:ToolRequest={matchId:before.id,playerId:'A',requestId:'r',revision:before.revision,tool:'respond',arguments:{response:{kind:'accept'}}};
  const disputed=outcomeChecks({...item,oracle:{kind:'dispute_response',response:'defend',reasonGroups:[['抗性'],['100']]}},before,[{request,receipt:{status:'committed',revision:before.revision,data:{}},state:before}]);
  assert.ok(disputed.every(check=>!check.passed));
});

test('同一冻结输入给多组模型，按各自独立状态评分并保存原始轨迹',async t=>{
  const {dir,suite,call,item,bank}=await fixture(t),seen:Record<string,unknown>[]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    const body=JSON.parse(Buffer.concat(chunks).toString());seen.push(body);res.setHeader('Content-Type','text/event-stream');
    res.end(`data: ${JSON.stringify({type:'response.completed',response:{id:'r',model:body.model,status:'completed',reasoning:body.reasoning,output:[call],usage:{input_tokens:9,output_tokens:3}}})}\n\n`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert.ok(address && typeof address!=='string');
  const variants=[];
  for(const effort of ['medium','low','none']) {
    const path=join(dir,effort+'.json');await writeFile(path,JSON.stringify({schemaVersion:1,model:effort,reasoningEffort:effort,fast:false,connection:{kind:'openai_compatible',protocol:'responses',baseUrl:`http://127.0.0.1:${address.port}`}}));
    variants.push({id:effort,configFile:path});
  }
  const output=join(dir,'results'),report=await runSuite(suite,variants,output,{bankFile:bank});
  assert.ok(report.results.every(row=>row.passed));assert.equal(seen.length,3);
  for(const body of seen) { assert.deepEqual(body.input,item.request.input);assert.equal(body.instructions,item.request.instructions);assert.deepEqual(body.tool_choice,{type:'function',name:'move'}); }
  assert.equal(new Set(report.results.map(row=>row.inputHash)).size,1);assert.equal(new Set(report.results.map(row=>row.requestHash)).size,1);
  const after=await Promise.all(variants.map(async v=>JSON.parse(await readFile(join(output,`draw-${v.id}-1/execution/after.json`),'utf8')).state));
  assert.deepEqual(after[0],after[1]);assert.deepEqual(after[1],after[2]);
  assert.equal(report.sourceStable,true);
  assert.equal(report.bank?.bankId,'synthetic-v1');assert.equal(report.automatedChecksOnly,true);
  assert.equal(JSON.parse(await readFile(join(output,'bank-verification.json'),'utf8')).bankHash,report.bank?.bankHash);
});

test('新增异常检查能区分物品附着、竞技场卡牌组和错误进化，不把已有异常归因新回答',async t=>{
  const {item,prefix}=await fixture(t),before=structuredClone(prefix.at(-1)!.state);
  const ids=Object.keys(before.cards).slice(0,3),groupId='synthetic-group';
  before.groups[groupId]={id:groupId,stack:[ids[0]!],attached:[],state:{damageCounters:0,specialConditions:[],markers:{}}};
  before.definitions['synthetic-item']={kind:'trainer',name:'合成物品',subtype:'item',text:'合成效果'};
  before.cards[ids[1]!]!.definitionId='synthetic-item';
  before.definitions['synthetic-evolution']={kind:'pokemon',name:'合成进化',hp:100,types:[],stage:'1阶进化',evolvesFrom:'另一种合成宝可梦',abilities:[],attacks:[],weaknesses:[],resistances:[],retreatCost:0};
  before.cards[ids[2]!]!.definitionId='synthetic-evolution';
  const after=structuredClone(before);after.groups[groupId]!.attached.push(ids[1]!);after.groups[groupId]!.stack.push(ids[2]!);after.zones.stadium!.contents.items=[{kind:'group',id:groupId}];
  const request:ToolRequest={matchId:before.id,playerId:'A',requestId:'r',revision:before.revision,tool:'move',arguments:{}};
  const checks=[{kind:'new_item_attachment' as const},{kind:'new_stadium_group' as const},{kind:'new_stack_lineage' as const}];
  const scored=outcomeChecks({...item,oracle:{kind:'state_safety',checks}},before,[{request,receipt:{status:'committed',revision:before.revision,data:{}},state:after}]);
  assert.ok(scored.every(check=>!check.passed));
  const unchanged=outcomeChecks({...item,oracle:{kind:'state_safety',checks}},after,[{request,receipt:{status:'committed',revision:before.revision,data:{}},state:after}]);
  assert.ok(unchanged.every(check=>check.passed));
});
