import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GameService } from '../src/service.ts';
import { selection } from '../src/match.ts';
import type { DeckData, GameCommand, PlayerId } from '../../../packages/protocol/src/index.ts';

const face = { kind: 'pokemon' as const, name: '合成基础', hp: 60, types: ['草'], stage: '基础', abilities: [], attacks: [], weaknesses: [], resistances: [], retreatCost: 0 };
const deck: DeckData = { name: '合成', cards: [{ card: face, count: 60 }] };
async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-context-host-'));
  const service = new GameService({ dataDir: join(directory, 'data'), systemDir: join(directory, 'system') });
  await service.init(); t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const created = await service.createMatch({ mode: 'local', autoRun: false, players: [{ name: 'A', kind: 'human', deck }, { name: 'B', kind: 'human', deck }] }), match = service.match(created.match.id);
  for (let i = 0; i < 5 && match.state.flow.choice; i++) {
    const choice = match.state.flow.choice, actor = choice.playerId;
    const command = choice.kind === 'choose_first' ? { kind: 'choose_first' as const, firstPlayer: 'A' as const } : { kind: 'initial_placement' as const, active: { zoneId: actor + ':hand', index: 0 }, bench: [] };
    assert.equal((await match.command(actor, { requestId: randomUUID(), revision: match.state.revision, command })).status, 'committed');
  }
  const execute = (actor: PlayerId, command: GameCommand, requestId = randomUUID()) => { const { kind, ...args } = command; return match.execute({ matchId: match.state.id, playerId: actor, requestId, revision: match.state.revision, tool: kind, arguments: args }); };
  return { match, execute };
}

test('隐藏洗牌可继续固定步骤，已知手牌展示不中断，未知展示与盲抽仍中断', async t => {
  const { match, execute } = await fixture(t);
  const shuffled = await execute('A', { kind: 'shuffle', selection: selection('A:deck') });
  assert.equal(shuffled.continuation, 'continue', 'HIDDEN_SHUFFLE_ALWAYS_INTERRUPTS');
  assert.deepEqual(shuffled.continuationGuard, { kind: 'hidden_shuffle', zoneIds: ['A:deck'] });
  assert.equal((await execute('A', { kind: 'show', selection: selection('A:hand', 0, 1) })).continuation, 'continue');
  assert.equal((await execute('A', { kind: 'show', selection: selection('A:deck', 0, 1) })).continuation, 'observe');
  await execute('A', { kind: 'shuffle', selection: selection('A:deck') });
  const id = randomUUID(), draw = { kind: 'move' as const, source: selection('A:deck', 0, 1), destination: { container: { kind: 'zone' as const, zoneId: 'A:hand' }, index: 0 } };
  const receipt = await execute('A', draw, id); assert.equal(receipt.continuation, 'observe');
  const replay = await match.execute({ matchId: match.state.id, playerId: 'A', requestId: id, revision: receipt.revision - 1, tool: 'move', arguments: { source: draw.source, destination: draw.destination } });
  assert.deepEqual(replay, receipt);
});

test('工具定义在阶段切换时保持稳定，可用集仍按权限变化', async t => {
  const { match, execute } = await fixture(t);
  const first = await match.observe(match.state.id, 'A', null); assert.ok(first.toolCatalog?.length, 'STABLE_TOOL_CATALOG_MISSING');
  await execute('A', { kind: 'set_turn', phase: 'check', playerId: null });
  const second = await match.observe(match.state.id, 'A', first.cursor);
  assert.deepEqual(second.toolCatalog, first.toolCatalog);
  await execute('A', { kind: 'set_turn', phase: 'turn', playerId: 'B' });
  const waiting = await match.observe(match.state.id, 'A', second.cursor);
  assert.equal(waiting.tools.length, 0); assert.deepEqual(waiting.toolCatalog, first.toolCatalog);
});

test('公开牌组的时点跟随换位和暂存，进入隐藏区重置，不泄露隐藏组标识', async t => {
  const { match, execute } = await fixture(t);
  const facts = async () => (await match.observe(match.state.id, 'A', null)).snapshot as any;
  const initial = (await facts()).inPlayFacts; assert.ok(Array.isArray(initial), 'IN_PLAY_FACTS_MISSING');
  const active = initial.find((x: any) => x.position.zoneId === 'A:active'); assert.ok(active.lineageRef);
  await execute('A', { kind: 'move', source: selection('A:active', 0, 1), destination: { container: { kind: 'zone', zoneId: 'A:staging' }, index: 0 } });
  await execute('A', { kind: 'move', source: selection('A:staging', 0, 1), destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
  const moved = (await facts()).inPlayFacts.find((x: any) => x.position.zoneId === 'A:bench');
  assert.equal(moved.lineageRef, active.lineageRef); assert.deepEqual(moved.firstInPlay, active.firstInPlay);
  await execute('A', { kind: 'move', source: selection('A:bench', 0, 1), destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 0 } });
  assert.equal((await facts()).inPlayFacts.some((x: any) => x.lineageRef === active.lineageRef), false);
  await execute('A', { kind: 'move', source: selection('A:hand', 0, 1), destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
  const returned = (await facts()).inPlayFacts.find((x: any) => x.position.zoneId === 'A:bench');
  assert.notEqual(returned.lineageRef, active.lineageRef);
  for (const x of (await facts()).inPlayFacts) assert.match(x.position.zoneId, /:(active|bench)$/);
});

test('先前临时查看的位置不变时展示可继续；隐藏洗牌即使牌名相同也使位置知识失效', async t => {
  const { execute } = await fixture(t);
  await execute('A', { kind: 'look', selection: selection('A:deck', 0, 1) });
  await execute('A', { kind: 'declare', text: '仅宣告，不改变牌库' });
  assert.equal((await execute('A', { kind: 'show', selection: selection('A:deck', 0, 1) })).continuation, 'continue');
  await execute('A', { kind: 'shuffle', selection: selection('A:deck') });
  assert.equal((await execute('A', { kind: 'show', selection: selection('A:deck', 0, 1) })).continuation, 'observe');
});

test('修改卡组后生成完整新计划，保留旧版本且旧局不能污染新范围', async t => {
  const { match } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-policy-scope-'));
  const service = new GameService({ dataDir: join(directory, 'data'), systemDir: join(directory, 'system'), modelFactory: () => ({ async generate(request) {
    const input = JSON.parse(request.input[0]!.content as string);
    if(input.stage === 'strategy_initialize') return { id:'init',model:'test',output:[],calls:[{callId:'init',name:'submit_result',arguments:JSON.stringify({plan:'合成完整计划：稳定攻击和资源接续',changeSummary:'初始化'})}],usage:null };
    throw new Error('此验证仅允许初始化请求');
  } }) });
  await service.init(); t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const opponent = await service.createOpponent({ deck });
  const first = await service.createMatch({ mode: 'human_ai', players: [{ kind: 'human', name: 'A', deck }, { kind: 'ai', name: 'B', opponentId: opponent.id }] });
  const oldMatch = service.match(first.match.id); await service.agent(oldMatch);
  const old = await service.opponents.get(opponent.id), structured = old.strategies.at(-1)!;
  structured.policy!.entries.push({ id: 'old-scope', revision: 1, status: 'active', when: '合成条件', prefer: '比较两种资源选择', because: '合成机制', unless: [], benefit: 'untested', evidence: [] });
  await service.opponents.save(old);
  const changed = { ...deck, name: '不同卡组范围' }; await service.updateOpponent(opponent.id, { deck: changed });
  const second = await service.createMatch({ mode: 'human_ai', players: [{ kind: 'human', name: 'A', deck }, { kind: 'ai', name: 'B', opponentId: opponent.id }] });
  await service.agent(service.match(second.match.id));
  const next = (await service.opponents.get(opponent.id)).strategies.at(-1)!;
  assert.equal(next.version, structured.version + 1); assert.deepEqual(next.policy!.entries, []); assert.ok(next.policy!.plan?.trim());
  assert.equal(structured.policy!.entries[0]!.status, 'active');
  assert.notEqual(next.policy!.scope.deckHash, structured.policy!.scope.deckHash);
  assert.equal((await oldMatch.command('A', { requestId: randomUUID(), revision: oldMatch.state.revision, command: { kind: 'concede' } })).status, 'committed');
  const oldRuntime = await service.agent(oldMatch);
  await assert.rejects(oldRuntime.summarize(oldMatch.state.id, 'B', next), /STRATEGY_SCOPE_CONFLICT/);
  assert.equal(match.state.flow.phase, 'turn');
});

test('同名场上实例独立关联，撤销叠牌后保留初始在场时点', async t => {
  const { match, execute } = await fixture(t);
  const readFacts = async () => ((await match.observe(match.state.id, 'A', null)).snapshot as any).inPlayFacts;
  const original = (await readFacts()).find((fact: any) => fact.position.zoneId === 'A:active');
  await execute('A', { kind: 'create_group', destination: { container: { kind: 'zone', zoneId: 'A:bench' }, index: 0 } });
  await execute('A', { kind: 'move', source: selection('A:hand', 0, 1), destination: { container: { kind: 'group', position: { zoneId: 'A:bench', index: 0 }, relation: 'stack' }, index: 0 } });
  const other = (await readFacts()).find((fact: any) => fact.position.zoneId === 'A:bench');
  assert.notEqual(other.lineageRef, original.lineageRef);
  assert.notEqual(other.firstInPlay.eventId, original.firstInPlay.eventId);
  const changed = await execute('A', { kind: 'move', source: selection('A:hand', 0, 1), destination: { container: { kind: 'group', position: { zoneId: 'A:active', index: 0 }, relation: 'stack' }, index: 1 } });
  assert.equal(changed.status, 'committed');
  assert.ok((await readFacts()).find((fact: any) => fact.lineageRef === original.lineageRef).lastEvolution);
  const eventId = (changed.data as { eventId: string }).eventId;
  await execute('A', { kind: 'set_turn', phase: 'turn', playerId: 'B' });
  await execute('B', { kind: 'object', targetEventId: eventId, reason: '合成回滚验证', evidenceRefs: [eventId], proposal: { restoreBeforeEventId: eventId, shuffles: [] } });
  const dispute = match.meta.dispute!;
  assert.equal((await execute('A', { kind: 'respond', response: { kind: 'accept', disputeId: dispute.id, proposalId: dispute.proposalId } })).status, 'committed');
  const restored = (await readFacts()).find((fact: any) => fact.position.zoneId === 'A:active');
  assert.equal(restored.lineageRef, original.lineageRef); assert.deepEqual(restored.firstInPlay, original.firstInPlay);
  assert.equal(restored.lastEvolution, null); assert.ok(match.meta.revoked[eventId]);
});

test('已确定的检查阶段步骤可同批推进，交权和随机结果仍要求观察', async t => {
  const { match, execute } = await fixture(t);
  const check = await execute('A',{kind:'set_turn',phase:'check',playerId:null});
  assert.equal(check.continuation,'continue','仅切换到检查阶段不应要求一次空的玩家决策');
  assert.equal((await execute('A',{kind:'random',mode:'coins',count:1})).continuation,'observe');
  assert.equal((await execute('A',{kind:'set_turn',phase:'turn',playerId:'B'})).continuation,'observe');
  const recovered = await match.execute({ matchId:match.state.id,playerId:'A',requestId:crypto.randomUUID(),revision:match.state.revision,tool:'set_turn',arguments:{phase:'check',playerId:null} });
  assert.equal(recovered.status,'rejected','交权后旧玩家不能继续执行序列');
});

test('预选牌面检索只定位已查看散牌；展示/移动可批量并持久幂等，洗后不得猜牌', async t => {
  const { match, execute } = await fixture(t);
  const invoke=(tool:string,args:Record<string,unknown>,requestId=crypto.randomUUID(),revision=match.state.revision)=>match.execute({matchId:match.state.id,playerId:'A',requestId,revision,tool,arguments:args as never});
  const blind=await invoke('move_known',{zoneId:'A:deck',name:face.name,destination:{container:{kind:'zone',zoneId:'A:hand'},index:0}});
  assert.equal(blind.status,'not_executed');
  const looked=await execute('A',{kind:'look',selection:selection('A:deck')});
  assert.equal(looked.continuation,'continue');assert.deepEqual(looked.continuationGuard,{kind:'named_selection',zoneIds:['A:deck']});
  assert.equal((await invoke('show_known',{zoneId:'A:deck',name:face.name})).status,'committed');
  const id=crypto.randomUUID(),revision=match.state.revision,args={zoneId:'A:deck',name:face.name,destination:{container:{kind:'zone',zoneId:'A:hand'},index:0}};
  const before=match.state.zones['A:hand']!.contents.items.length,receipt=await invoke('move_known',args,id,revision);
  assert.equal(receipt.status,'committed');assert.equal(receipt.continuation,'continue');
  assert.deepEqual(await invoke('move_known',args,id,revision),receipt);
  await assert.rejects(()=>invoke('move_known',args,id,receipt.revision),/请求标识/);
  assert.equal(match.state.zones['A:hand']!.contents.items.length,before+1);
  await assert.rejects(()=>invoke('move_known',{...args,name:'不同意图'},id,revision),/请求标识/);
  await execute('A',{kind:'shuffle',selection:selection('A:deck')});
  assert.equal((await invoke('show_known',{zoneId:'A:deck',name:face.name})).status,'not_executed');
  const namedCommits=match.records.filter(row=>row.event&&row.request?.requestId.startsWith('known:'));
  assert.ok(namedCommits.every(row=>['show','move'].includes(row.request!.command.kind)),'牌桌记录仍是标准原子命令');
});

test('整库查看后的多目标按牌面检索保留剩余已知散牌，新插入未知牌不能借授权', async t => {
  const {match,execute}=await fixture(t);
  await execute('A',{kind:'look',selection:selection('A:deck')});
  for(let i=0;i<2;i++){
    const result=await match.execute({matchId:match.state.id,playerId:'A',requestId:crypto.randomUUID(),revision:match.state.revision,tool:'move_known',arguments:{zoneId:'A:deck',name:face.name,destination:{container:{kind:'zone',zoneId:'A:hand'},index:0}}});
    assert.equal(result.status,'committed',`第${i+1}个预选目标不应因前一个确定移动失效`);
    assert.equal(result.continuation,'continue');
  }
  const knownCount=match.state.zones['A:deck']!.contents.items.length;
  await execute('A',{kind:'move',source:selection('B:hand',0,1),destination:{container:{kind:'zone',zoneId:'A:deck'},index:0}});
  const unavailable=await match.execute({matchId:match.state.id,playerId:'A',requestId:crypto.randomUUID(),revision:match.state.revision,tool:'show_known',arguments:{zoneId:'A:deck',name:face.name,occurrence:knownCount}});
  assert.equal(unavailable.status,'not_executed','新插入的未查看散牌不能借用整库历史授权');
});

test('真实宿主一轮模型完成预定整库检索、展示、移动和收尾，不预猜未知结果',async t=>{
 const {match}=await fixture(t);
 const {AgentRuntime,MemorySessionStore,loadPrompts}=await import('../../../packages/agent/src/index.ts');
 let decisions=0;
 const actions=[
  {tool:'look',arguments:{selection:'A:deck'}},
  {tool:'show_known',arguments:{zoneId:'A:deck',name:face.name}},
  {tool:'move_known',arguments:{zoneId:'A:deck',name:face.name,destination:'A:hand/0'}},
  {tool:'show_known',arguments:{zoneId:'A:deck',name:face.name}},
  {tool:'move_known',arguments:{zoneId:'A:deck',name:face.name,destination:'A:hand/0'}},
  {tool:'shuffle',arguments:{selection:'A:deck'}},
  {tool:'set_turn',arguments:{phase:'check',playerId:null}},
  {tool:'set_turn',arguments:{phase:'turn',playerId:'B'}},
 ];
 const runtime=new AgentRuntime({match,store:new MemorySessionStore(),trace:{async append(){}},prompts:await loadPrompts(),model:{async generate(request){
  decisions++;assert.deepEqual(request.tools.map(tool=>tool.name),['execute_sequence']);
  const args=JSON.stringify({actions});return{id:'test',model:'test',usage:null,calls:[{callId:'batch',name:'execute_sequence',arguments:args}],output:[{type:'function_call',call_id:'batch',name:'execute_sequence',arguments:args}]};
 }}});
 await runtime.create({matchId:match.state.id,playerId:'A',deck:deck as never,rules:match.meta.rules,strategy:{version:1,content:''}});
 const before=match.state.zones['A:hand']!.contents.items.length;
 const result=await runtime.activate(match.state.id,'A');assert.equal(result.status,'waiting');assert.equal(decisions,1);
 assert.equal(match.state.zones['A:hand']!.contents.items.length,before+2);assert.equal(match.state.flow.operator,'B');
});

test('并发按牌面请求共用public ID时，缺牌结果固定意图且不同目标不能随后执行', async t => {
  const { match } = await fixture(t);
  const revision = match.state.revision, before = match.state.zones['A:hand']!.contents.items.length;
  const invoke = (name: string) => match.execute({ matchId: match.state.id, playerId: 'A', requestId: 'known-concurrent-intent', revision, tool: 'move_known',
    arguments: { zoneId: 'A:hand', name, destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 0 } } });
  const [missing, different] = await Promise.allSettled([invoke('不存在的合成牌'), invoke(face.name)]);
  assert.equal(missing!.status, 'fulfilled');
  if (missing!.status === 'fulfilled') assert.equal(missing.value.status, 'not_executed');
  assert.equal(different!.status, 'rejected', '同一public ID已被缺牌意图占用，不得接受不同目标并产生副作用');
  if (different!.status === 'rejected') assert.match(String(different.reason), /请求标识/);
  assert.equal(match.state.zones['A:hand']!.contents.items.length, before, '冲突目标不得移动卡牌');
  assert.equal(match.records.filter(row => row.request?.requestId.startsWith('known:')).length, 1, '只持久保存首次public请求的结果');
});
