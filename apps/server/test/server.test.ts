import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { GameService } from '../src/service.ts';
import { MatchRuntime, selection } from '../src/match.ts';
import type { CommandReceipt, CreateMatchResponse, DeckData, GameCommand, MatchView, OpponentRecord, PlayerId, PromptConfig } from '../../../packages/protocol/src/index.ts';
import { loadPrompts } from '../../../packages/agent/src/prompts.ts';
import { FileSessionStore } from '../../../packages/agent/src/storage.ts';
import { validationError } from '../../../packages/agent/src/schema.ts';
import type { ModelGateway, ModelRequest } from '../../../packages/agent/src/types.ts';

const basic = { name: '测试宝可梦', kind: 'pokemon' as const, hp: 60, types: ['火'], stage: '基础', abilities: [], attacks: [{ name:'撞击',energyCost:[],damageText:'10',text:'' }], weaknesses: [], resistances: [], retreatCost: 0 };
const deck: DeckData = { name: '测试卡组', cards: [{ card: basic, count: 60 }] };
async function setup(t: TestContext, modelFactory?: () => ModelGateway) {
  const dir = await mkdtemp(join(tmpdir(), 'ptcg-server-'));
  const app = await buildApp({ dataDir: join(dir, 'data'), systemDir: join(dir, 'system'), modelFactory: () => {
    const model = modelFactory?.();
    return { async generate(request) {
      const input = JSON.parse(request.input[0]!.content as string);
      if (input.stage === 'strategy_initialize') return { id: 'initialize-test', model: 'test', output: [], calls: [{ callId: 'init', name: 'submit_result', arguments: JSON.stringify({ plan: '合成卡组整体计划：建立可持续攻击与接续，控制奖赏交换和资源支出，以实际可见信息调整。', changeSummary: '生成完整计划' }) }], usage: null };
      if (!model) throw new Error('测试未配置预期模型请求');
      return model.generate(request);
    } };
  } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, dir, service: app.gameService };
}
async function create(app: Awaited<ReturnType<typeof buildApp>>, mode: 'local'|'human_ai'|'ai_ai' = 'local'): Promise<CreateMatchResponse> {
  const response = await app.inject({ method: 'POST', url: '/api/matches', payload: { mode, players: [{ name:'甲',kind:mode === 'ai_ai' ? 'ai' : 'human',deck },{ name:'乙',kind:mode === 'local' ? 'human' : 'ai',deck }] } });
  assert.equal(response.statusCode, 200, response.body); return response.json<CreateMatchResponse>();
}
async function view(app: Awaited<ReturnType<typeof buildApp>>, game: CreateMatchResponse, player: PlayerId = 'A'): Promise<MatchView> {
  const response = await app.inject({ method:'GET',url:`/api/matches/${game.match.id}?viewer=${player}` }); assert.equal(response.statusCode,200,response.body); return response.json<MatchView>();
}
async function command(app: Awaited<ReturnType<typeof buildApp>>, game: CreateMatchResponse, actor: PlayerId, cmd: GameCommand, requestId = randomUUID(), revision?: number): Promise<CommandReceipt> {
  const current = await view(app,game,actor);
  const response = await app.inject({method:'POST',url:`/api/matches/${game.match.id}/commands`,payload:{playerId:actor,requestId,revision:revision ?? current.revision,command:cmd}});
  assert.equal(response.statusCode,200,response.body); return response.json<CommandReceipt>();
}
async function ready(app: Awaited<ReturnType<typeof buildApp>>, game: CreateMatchResponse): Promise<MatchView> {
  for (let i=0;i<5;i++) {
    const current=await view(app,game); const choice=current.flow.choice; if(!choice) { await app.gameService.prepareHumanTurn(app.gameService.match(game.match.id)); return view(app,game); }
    const cmd: GameCommand = choice.kind==='choose_first' ? {kind:'choose_first',firstPlayer:'A'} : {kind:'initial_placement',active:{zoneId:`${choice.playerId}:hand`,index:0},bench:[]};
    const result=await command(app,game,choice.playerId,cmd); assert.equal(result.status,'committed',JSON.stringify(result));
  }
  return view(app,game);
}
test('卡背图片缺失返回 404，配置本地 PNG 后按原始内容返回', async t => {
  const { app, service } = await setup(t);
  const missing = await app.inject('/api/assets/card-back.png');
  assert.equal(missing.statusCode, 404); assert.equal(missing.json().error.code, 'NOT_FOUND');
  // 非官方合成 1×1 PNG，不依赖用户本机图片。
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=', 'base64');
  const directory = join(service.dataDir, 'assets');
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'card-back.png'), image);
  const response = await app.inject('/api/assets/card-back.png');
  assert.equal(response.statusCode, 200); assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'no-cache'); assert.deepEqual(response.rawPayload, image);
});
test('health / JSON 卡组保存、更新、导出、删除', async t => {
  const {app}=await setup(t); assert.deepEqual((await app.inject('/api/health')).json(),{ok:true});
  const saved=(await app.inject({method:'POST',url:'/api/decks',payload:{deck}})).json<{id:string}>();
  assert.deepEqual((await app.inject(`/api/decks/${saved.id}/export`)).json(),deck);
  assert.equal((await app.inject({method:'PUT',url:`/api/decks/${saved.id}`,payload:{deck:{...deck,name:'修改'}}})).json<{deck:DeckData}>().deck.name,'修改');
  assert.equal((await app.inject('/api/decks')).json<{decks:unknown[]}>().decks.length,1);
  assert.equal((await app.inject({method:'DELETE',url:`/api/decks/${saved.id}`})).statusCode,200);
  assert.equal((await app.inject(`/api/decks/${saved.id}`)).statusCode,404);
});

test('顺序执行只跨过确定操作，新牌面、随机、交权和幂等开牌重试要求重新观察', async t => {
  const { app, service } = await setup(t), game = await create(app); await ready(app, game);
  const match = service.match(game.match.id);
  const execute = (cmd: GameCommand) => {
    const { kind, ...args } = cmd;
    return match.execute({ matchId: match.state.id, playerId: 'A', requestId: randomUUID(), revision: match.state.revision, tool: kind, arguments: args });
  };
  assert.equal((await execute({ kind: 'declare', text: '合成验证' })).continuation, 'continue');
  assert.equal((await execute({ kind: 'set_state', target: { kind: 'player', playerId: 'A' }, field: { key: 'marker', name: '合成标记', value: true } })).continuation, 'continue');
  assert.equal((await execute({ kind: 'move', source: selection('A:hand', 0, 1), destination: { container: { kind: 'zone', zoneId: 'A:discard' }, index: 0 } })).continuation, 'continue');
  const request = { matchId: match.state.id, playerId: 'A', requestId: randomUUID(), revision: match.state.revision, tool: 'move', arguments: { source: selection('A:deck', 0, 1), destination: { container: { kind: 'zone', zoneId: 'A:hand' }, index: 0 } } };
  const receipt = await match.execute(request);
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.continuation, 'observe');
  assert.deepEqual(await match.execute(request), receipt, '重试必须沿用原来开牌的信息边界');
  assert.equal((await execute({ kind: 'random', mode: 'coins', count: 1 })).continuation, 'observe');
  assert.equal((await execute({ kind: 'shuffle', selection: selection('A:deck') })).continuation, 'continue');
  assert.equal((await execute({ kind: 'look', selection: selection('B:hand', 0, 1) })).continuation, 'observe');
  assert.equal((await execute({ kind: 'set_turn', phase: 'turn', playerId: 'B' })).continuation, 'observe');
});

test('模型只收到一个set_turn工具，并从同一共享schema获得阶段与玩家的联合约束', async t => {
  const { app, service } = await setup(t), game = await create(app); await ready(app, game);
  const tools = service.match(game.match.id).tools('A').filter(tool => tool.name === 'set_turn');
  assert.equal(tools.length, 1);
  assert.ok(validationError(tools[0]!.inputSchema, { phase: 'check', playerId: 'A' }));
  assert.ok(validationError(tools[0]!.inputSchema, { phase: 'turn', playerId: null }));
  assert.equal(validationError(tools[0]!.inputSchema, { phase: 'check', playerId: null }), null);
  assert.equal(validationError(tools[0]!.inputSchema, { phase: 'turn', playerId: 'B' }), null);
});
test('历史工具默认到达近期事件，按字节分页且游标能遍历全部记录', async t => {
  const { app, service } = await setup(t), game = await create(app); await ready(app, game);
  const match = service.match(game.match.id);
  for (let index = 0; index < 20; index++) await command(app, game, 'A', { kind: 'declare', text: `EVENT_${index}:` + '历史记录'.repeat(300) });
  const read = async (args: Record<string, unknown>) => {
    const receipt = await match.execute({ matchId: game.match.id, playerId: 'A', revision: match.state.revision, requestId: randomUUID(), tool: 'read_history', arguments: args as never });
    assert.equal(receipt.status, 'read');
    return receipt.data as unknown as { entries: { id: string; sequence: number; data: unknown }[]; cursor: string; previousCursor: string; hasMore: boolean; hasPrevious: boolean };
  };
  const latest = await read({ limit: 200 });
  assert.match(JSON.stringify(latest.entries.at(-1)), /EVENT_19/, 'DEFAULT_PAGE_MISSES_CURRENT_EVENT');
  assert.ok(Buffer.byteLength(JSON.stringify(latest)) <= 24_000, 'HISTORY_PAGE_TOO_LARGE');
  assert.equal(latest.hasPrevious, true);
  const older = await read({ before: latest.previousCursor, limit: 200 });
  assert.ok(older.entries.at(-1)!.sequence < latest.entries[0]!.sequence);
  const ids: string[] = []; let cursor = '0';
  for (let page = 0; page < 100; page++) {
    const result = await read({ after: cursor, limit: 200 }); ids.push(...result.entries.map(event => event.id)); cursor = result.cursor;
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24_000);
    if (!result.hasMore) break;
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, match.compactHistory('A', '0', 2000).entries.map(event => event.id));
});
test('卡组严格格式与零基础预检，不启动无解重抽',async t=>{
  const {app}=await setup(t);
  assert.equal((await app.inject({method:'POST',url:'/api/decks',payload:{deck:{cards:[{card:basic,count:0}]}}})).statusCode,400);
  const invalid={cards:[{card:{kind:'energy',name:'火能量',subtype:'basic',energyType:'火'},count:60}]};
  assert.equal((await app.inject({method:'POST',url:'/api/matches',payload:{mode:'local',players:[{name:'甲',kind:'human',deck:invalid},{name:'乙',kind:'human',deck}]}})).statusCode,400);
});
test('AI 对手用户策略更新及完整导入保留历史并生成新身份',async t=>{
  const {app}=await setup(t); const first=(await app.inject({method:'POST',url:'/api/opponents',payload:{name:'对手',deck,strategy:''}})).json<OpponentRecord>();
  const changed=(await app.inject({method:'PUT',url:`/api/opponents/${first.id}`,payload:{strategy:'先考虑奖赏'}})).json<OpponentRecord>();
  assert.equal(changed.strategies.length,2); assert.equal(changed.strategies[1]!.source.kind,'user_edit');
  const imported=(await app.inject({method:'POST',url:'/api/opponents/import',payload:changed})).json<OpponentRecord>();
  assert.notEqual(imported.id,first.id); assert.equal(imported.origin?.opponentId,first.id); assert.deepEqual(imported.strategies,changed.strategies);
});
test('自动准备逐原子操作生成手牌、奖赏与公开战斗卡牌组',async t=>{
  const {app}=await setup(t); const game=await create(app); const current=await ready(app,game);
  assert.equal(current.flow.phase,'turn'); assert.equal(current.flow.turnOwner,'A');
  for(const id of ['A','B']) { assert.equal(current.zones.find(z=>z.id===`${id}:hand`)!.items.length,id === 'A' ? 7 : 6); assert.equal(current.zones.find(z=>z.id===`${id}:prizes`)!.items.filter(Boolean).length,6); assert.equal(current.zones.find(z=>z.id===`${id}:active`)!.items[0]!.kind,'group'); }
  const auto=current.events.filter(e=>e.actor==='system'); assert.ok(auto.some(e=>e.commandKind==='shuffle')); assert.ok(auto.some(e=>e.commandKind==='create_group')); assert.ok(auto.some(e=>e.commandKind==='move')); assert.ok(current.revision>15);
});
test('无需凭证仍保留人机视角限制，全知和 live 导出均拒绝',async t=>{
  const {app}=await setup(t); const game=await create(app,'human_ai'); assert.equal('access' in game,false);
  for(const viewer of ['B','omniscient']) assert.equal((await app.inject({url:`/api/matches/${game.match.id}?viewer=${viewer}`})).statusCode,403);
  assert.equal((await app.inject({url:`/api/matches/${game.match.id}/export`})).statusCode,403);
  assert.equal((await app.inject({url:`/api/matches/${game.match.id}`})).statusCode,200);
});
test('对局无需凭证即可读取历史、回放、控制和导出，AI 观战默认全知', async t => {
  const { app, service } = await setup(t); const game = await create(app, 'ai_ai');
  const current = (await app.inject(`/api/matches/${game.match.id}`)).json<MatchView>();
  assert.equal(current.viewer, 'omniscient'); assert.equal(current.mode, 'ai_ai');
  assert.equal((await app.inject(`/api/matches/${game.match.id}/history`)).statusCode, 200);
  assert.equal((await app.inject(`/api/matches/${game.match.id}/replay?index=0`)).statusCode, 200);
  const paused = await app.inject({ method: 'POST', url: `/api/matches/${game.match.id}/control`, payload: { action: 'pause' } });
  assert.equal(paused.statusCode, 202);
  const aborted = await app.inject({ method: 'POST', url: `/api/matches/${game.match.id}/debug`, payload: { kind: 'abort', reason: '合成验证' } });
  assert.equal(aborted.statusCode, 200); assert.equal(aborted.json<MatchView>().runtime.status, 'aborted');
  const exported = await app.inject(`/api/matches/${game.match.id}/export`);
  assert.equal(exported.statusCode, 200); assert.equal(exported.body.includes('adminToken'), false);
  assert.equal((await readFile(service.match(game.match.id).journal.path, 'utf8')).includes('seatTokens'), false);
});
test('HTTP 命令必须显式指定有效人类席位，不能操作 AI，错误请求不写日志', async t => {
  const { app, service } = await setup(t); const game = await create(app, 'human_ai');
  const match = service.match(game.match.id); const records = match.records.length;
  const payload = { requestId: randomUUID(), revision: match.state.revision, command: { kind: 'concede' } };
  for (const playerId of [undefined, 'omniscient', 'C', null]) {
    const response = await app.inject({ method: 'POST', url: `/api/matches/${game.match.id}/commands`, payload: { ...payload, playerId } });
    assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'INVALID_PLAYER');
  }
  const ai = await app.inject({ method: 'POST', url: `/api/matches/${game.match.id}/commands`, payload: { ...payload, playerId: 'B' } });
  assert.equal(ai.statusCode, 403); assert.equal(ai.json().error.code, 'AI_PLAYER');
  assert.equal(match.records.length, records);
  const human = await app.inject({ method: 'POST', url: `/api/matches/${game.match.id}/commands`, payload: { ...payload, playerId: 'A' } });
  assert.equal(human.statusCode, 200); assert.equal(human.json<CommandReceipt>().status, 'committed');
  assert.equal((await app.inject(`/api/matches/${game.match.id}/replay?viewer=omniscient&index=0`)).statusCode, 200);
});
test('旧凭证记录可直接恢复，历史原件不改写且后续记录和导出不再包含凭证', async t => {
  const { app, service } = await setup(t); const game = await create(app); await ready(app, game);
  const original = service.match(game.match.id);
  const legacy = original.records.map(record => JSON.stringify({ ...record, meta: { ...record.meta, access: { adminToken: 'legacy-admin', seatTokens: { A: 'legacy-seat' }, allowedViewers: ['A', 'B'] } } })).join('\n') + '\n';
  await writeFile(original.journal.path, legacy);
  const recovered = new MatchRuntime({ directory: original.directory }); await recovered.recover();
  assert.equal(await readFile(original.journal.path, 'utf8'), legacy);
  assert.equal('access' in recovered.meta, false); assert.ok(recovered.records.every(record => !('access' in record.meta)));
  service.matches.set(game.match.id, recovered);
  assert.equal((await app.inject(`/api/matches/${game.match.id}`)).statusCode, 200);
  assert.equal((await command(app, game, 'A', { kind: 'declare', text: '恢复后操作' })).status, 'committed');
  const persisted = await readFile(original.journal.path, 'utf8');
  assert.ok(persisted.startsWith(legacy)); assert.equal(persisted.slice(legacy.length).includes('legacy-'), false);
  const exported = await app.inject(`/api/matches/${game.match.id}/export`);
  assert.equal(exported.statusCode, 200); assert.equal(exported.body.includes('legacy-'), false);
});
test('look 仅本人原始回执／历史可见；show 双方收到，后续隐藏不抹历史',async t=>{
  const {app}=await setup(t); const game=await create(app); await ready(app,game);
  const looked=await command(app,game,'A',{kind:'look',selection:selection('B:hand',0,1)});
  assert.equal(looked.status,'committed'); assert.match(JSON.stringify(looked),/测试宝可梦/);
  const b=await view(app,game,'B'); const a=await view(app,game,'A');
  const own=a.events.find(e=>e.id===(looked.status==='committed'?looked.eventId:''))!;
  const theirs=b.events.find(e=>e.id===own.id)!;
  assert.ok((own.data as Record<string,unknown>).reveals); assert.equal((theirs.data as Record<string,unknown>).reveals,undefined);
  const showed=await command(app,game,'A',{kind:'show',selection:selection('A:hand',0,1)}); assert.equal(showed.status,'committed');
  const b2=await view(app,game,'B'); assert.ok((b2.events.at(-1)!.data as Record<string,unknown>).reveals);
});
test('命令幂等不重投币；跨席位缓存读取拒绝；过期位置持久拒绝',async t=>{
  const {app,service}=await setup(t); const game=await create(app); const current=await ready(app,game); const requestId=randomUUID();
  const first=await command(app,game,'A',{kind:'random',mode:'coins',count:3},requestId,current.revision);
  const again=await command(app,game,'A',{kind:'random',mode:'coins',count:3},requestId,current.revision); assert.deepEqual(again,first);
  const bad=await app.inject({method:'POST',url:`/api/matches/${game.match.id}/commands`,payload:{playerId:'B',requestId,revision:current.revision,command:{kind:'random',mode:'coins',count:3}}}); assert.equal(bad.statusCode,409);
  const expired=await command(app,game,'A',{kind:'declare',text:'旧请求'},randomUUID(),current.revision); assert.equal(expired.status,'rejected');
  assert.equal(service.match(game.match.id).records.filter(r=>r.request?.requestId===requestId).length,1);
});
test('认可异议：恢复目标前状态，保留观察，并标记失效历史',async t=>{
  const {app}=await setup(t); const game=await create(app); await ready(app,game);
  const mark=await command(app,game,'A',{kind:'set_state',target:{kind:'player',playerId:'A'},field:{key:'marker',name:'本回合附能',value:true}}); assert.equal(mark.status,'committed'); if(mark.status!=='committed')return;
  await command(app,game,'A',{kind:'set_turn',phase:'turn',playerId:'B'});
  const objected=await command(app,game,'B',{kind:'object',targetEventId:mark.eventId,reason:'记录错误',evidenceRefs:[mark.eventId]}); assert.equal(objected.status,'committed');
  let current=await view(app,game); const dispute=current.dispute!;
  const frozen=await command(app,game,'B',{kind:'declare',text:'不应执行'}); assert.equal(frozen.status,'rejected');
  const accepted=await command(app,game,'A',{kind:'respond',response:{kind:'accept',disputeId:dispute.id,proposalId:dispute.proposalId}}); assert.equal(accepted.status,'committed');
  current=await view(app,game); assert.equal(current.dispute!.status,'closed'); assert.equal(current.flow.operator,'A'); assert.equal(current.playerMarkers.A?.['本回合附能'],undefined); assert.ok(current.events.find(e=>e.id===mark.eventId)!.revokedBy);
});
test('只洗牌处置无需旧快照，结束前完整执行固定计划',async t=>{
  const {app}=await setup(t); const game=await create(app); await ready(app,game);
  const looked=await command(app,game,'A',{kind:'look',selection:selection('B:deck',0,1)}); if(looked.status!=='committed')throw Error('look');
  await command(app,game,'A',{kind:'set_turn',phase:'turn',playerId:'B'});
  await command(app,game,'B',{kind:'object',targetEventId:looked.eventId,reason:'查看不当',evidenceRefs:[looked.eventId],proposal:{shuffles:[selection('B:deck')]}});
  const dispute=(await view(app,game)).dispute!;
  await command(app,game,'A',{kind:'respond',response:{kind:'accept',disputeId:dispute.id,proposalId:dispute.proposalId}});
  const current=await view(app,game); assert.equal(current.flow.operator,'B'); assert.equal(current.dispute!.status,'closed'); assert.ok(current.events.at(-2)!.commandKind==='shuffle'); assert.equal(current.events.find(e=>e.id===looked.eventId)!.revokedBy,undefined);
});
test('正常结果须对手确认，回放不改变 live 状态',async t=>{
  const {app}=await setup(t); const game=await create(app); await ready(app,game);
  assert.equal((await command(app,game,'A',{kind:'report_result',result:{kind:'win',winner:'A',reason:'拿完奖赏'}})).status,'committed');
  assert.equal((await view(app,game)).flow.phase,'result_pending');
  await command(app,game,'B',{kind:'confirm_result',agree:true}); const end=await view(app,game); assert.equal(end.flow.phase,'finished');
  const replay=await app.inject({url:`/api/matches/${game.match.id}/replay?viewer=omniscient&index=0`}); assert.equal(replay.statusCode,200,replay.body); assert.equal(replay.json<MatchView>().flow.phase,'setup'); assert.equal((await view(app,game)).revision,end.revision);
});
test('重启恢复原始回执与全部牌桌；尾部损坏保存原件后修复',async t=>{
  const {app,dir,service}=await setup(t); const game=await create(app); await ready(app,game); const requestId=randomUUID(); const before=await view(app,game); const original=await command(app,game,'A',{kind:'random',mode:'coins',count:8},requestId,before.revision);
  const journal=join(service.match(game.match.id).directory,'journal.jsonl'); await appendFile(journal,'{"torn":');
  const recovered=new GameService({dataDir:join(dir,'data'),systemDir:join(dir,'system')}); await recovered.init(); t.after(()=>recovered.close());
  const match=recovered.match(game.match.id); assert.equal(match.state.revision,(await view(app,game)).revision); assert.deepEqual(await match.command('A',{requestId,revision:before.revision,command:{kind:'random',mode:'coins',count:8}}),original); assert.ok((await readFile(journal,'utf8')).endsWith('\n'));
});
test('提示词热更新只用于新局；模型配置拒绝明文凭据',async t=>{
  const {app,service}=await setup(t); const first=await create(app); const prompts=(await app.inject('/api/settings/prompts')).json<PromptConfig>();
  const changed=await app.inject({method:'PUT',url:'/api/settings/prompts',payload:{...prompts,player:prompts.player+'\n新局测试'}}); assert.equal(changed.statusCode,200,changed.body);
  const second=await create(app); assert.notEqual(service.match(first.match.id).meta.prompts.version,service.match(second.match.id).meta.prompts.version); assert.equal(service.match(first.match.id).meta.prompts.player.includes('新局测试'),false);
  assert.equal((await app.inject({method:'PUT',url:'/api/settings/model',payload:{schemaVersion:1,model:'gpt-6.1-terra',reasoningEffort:'medium',fast:false,connection:{kind:'openai_compatible',baseUrl:'http://localhost',apiKeyEnv:'TEST_KEY',protocol:'responses',apiKey:'forbidden'}}})).statusCode,400);
});
test('run 先返回 202；模型在后台等待，暂停不占牌桌写队列',async t=>{
  let entered!:()=>void; const called=new Promise<void>(resolve=>{entered=resolve});
  const {app}=await setup(t,()=>({ async generate(request:ModelRequest){ entered(); await new Promise<void>((resolve,reject)=>{request.signal?.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});}); throw Error('not reached'); } }));
  const game=await create(app,'ai_ai'); const start=Date.now(); const response=await app.inject({method:'POST',url:`/api/matches/${game.match.id}/control`,payload:{action:'run'}}); assert.equal(response.statusCode,202); assert.ok(Date.now()-start<1000); await called;
  const paused=await app.inject({method:'POST',url:`/api/matches/${game.match.id}/control`,payload:{action:'pause'}}); assert.equal(paused.statusCode,202); assert.equal(paused.json<{status:string}>().status,'paused');
});
test('准备选择期间禁止HTTP绕过；交接后普通动作与结果确认工具映射正确',async t=>{
  const {app,service}=await setup(t); const game=await create(app); const first=await view(app,game); const chooser=first.flow.choice!.playerId;
  const bypass=await command(app,game,chooser,{kind:'move',source:selection(`${chooser}:deck`,0,1),destination:{container:{kind:'zone',zoneId:`${chooser}:hand`},index:0}}); assert.equal(bypass.status,'rejected');
  await ready(app,game); await command(app,game,'A',{kind:'handoff',to:'B',reason:'选择换上的宝可梦'});
  const tools=service.match(game.match.id).tools('B').map(tool=>tool.name); assert.ok(tools.includes('move')); assert.ok(tools.includes('handoff'));
  await command(app,game,'B',{kind:'declare',text:'已选择'}); await command(app,game,'B',{kind:'handoff',to:'A',reason:'选择完成',returning:true});
  await command(app,game,'A',{kind:'report_result',result:{kind:'draw',reason:'同时达成'}});
  assert.ok(service.match(game.match.id).tools('B').some(tool=>tool.name==='confirm_result'));
});
test('默认提示词可恢复；缺少工具说明拒绝；冻结规则工具可按来源与关键字检索',async t=>{
  const {app,service}=await setup(t); const defaults=(await app.inject('/api/settings/prompts/default')).json<PromptConfig>(); assert.ok(defaults.toolDescriptions.move);
  const invalid=structuredClone(defaults); delete invalid.toolDescriptions.move;
  assert.equal((await app.inject({method:'PUT',url:'/api/settings/prompts',payload:invalid})).statusCode,400);
  const game=await create(app); const match=service.match(game.match.id);
  const response=await match.execute({matchId:game.match.id,playerId:'A',requestId:randomUUID(),revision:match.state.revision,tool:'read_rules',arguments:{id:'规则基准',query:'中毒',limit:2}});
  assert.equal(response.status,'read'); assert.match(JSON.stringify(response.data),/中毒/); assert.match(JSON.stringify(response.data),/规则基准/);
});
test('仅辩护触发独立裁判；裁判终局可确认有效的已有报告',async t=>{
  let calls=0;
  const {app,service}=await setup(t,()=>({async generate(request){ assert.equal(request.role,'judge'); calls++; const input=JSON.parse(request.input[0]!.content as string) as {disputeId:string;validReportedResults:string[];facts:{dispute:{targetEventId:string}}}; assert.deepEqual(input.validReportedResults,[input.facts.dispute.targetEventId]); return {id:'judge-test',model:'test',output:[],calls:[{callId:'judge-call',name:'submit_result',arguments:JSON.stringify({verdict:'uphold',explanation:'依公开报告确认',evidenceRefs:[input.facts.dispute.targetEventId],ruleRefs:['规则基准'],steps:[{kind:'end_match',result:{kind:'confirm_reported_result',reportEventId:input.facts.dispute.targetEventId}}]})}],usage:null};}}));
  const game=await create(app); await ready(app,game); assert.equal(calls,0);
  const report=await command(app,game,'A',{kind:'report_result',result:{kind:'win',winner:'A',reason:'奖赏已取完'}}); if(report.status!=='committed')throw Error('report');
  await command(app,game,'B',{kind:'object',targetEventId:report.eventId,reason:'需要核对结局',evidenceRefs:[report.eventId]}); assert.equal(calls,0);
  const dispute=(await view(app,game)).dispute!;
  await command(app,game,'A',{kind:'respond',response:{kind:'defend',disputeId:dispute.id,reason:'记录已经完整',evidenceRefs:[report.eventId]}});
  for(let i=0;i<100&&service.drivers.has(game.match.id);i++)await new Promise(resolve=>setTimeout(resolve,10));
  const final=await view(app,game); assert.equal(calls,1); assert.equal(final.flow.phase,'finished'); assert.deepEqual(final.flow.result,{kind:'win',winner:'A',reason:'奖赏已取完'}); assert.equal(final.dispute!.status,'closed');
});
test('AI 赛后总结仅获自身视角，并发布幂等策略版本',async t=>{
  const secretName='从未公开的对手私有卡组内容'; let summaries=0;
  const {app,service}=await setup(t,()=>({async generate(request){ assert.equal(request.role,'summary'); summaries++; assert.equal(JSON.stringify(request.input).includes(secretName),false); return {id:'summary-test',model:'test',output:[],calls:[{callId:'summary-call',name:'submit_result',arguments:JSON.stringify(JSON.parse(request.input[0]!.content as string).stage === 'facts_extract' ? { facts: [] } : { baseVersion: 1, plan: '合成卡组整体计划：建立可持续攻击与接续，控制奖赏交换和资源支出，以实际可见信息调整。', changes: [], changeSummary: '保留信息边界' })}],usage:null};}}));
  const secretDeck:DeckData={cards:[{card:{...basic,name:secretName},count:60}]};
  const response=await app.inject({method:'POST',url:'/api/matches',payload:{mode:'human_ai',players:[{name:'人类',kind:'human',deck:secretDeck},{name:'AI',kind:'ai',deck}]}}); const game=response.json<CreateMatchResponse>();
  await command(app,game,'A',{kind:'concede'});
  for(let i=0;i<100&&service.drivers.has(game.match.id);i++)await new Promise(resolve=>setTimeout(resolve,10));
  const match=service.match(game.match.id); const opponent=await service.opponents.get(match.state.players[1].opponentId!);
  assert.equal(summaries,2); assert.equal(opponent.strategies.length,2); assert.equal(match.meta.summaries.B?.status,'completed');
  service.wake(match); for(let i=0;i<100&&service.drivers.has(game.match.id);i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(summaries,2); assert.equal((await service.opponents.get(opponent.id)).strategies.length,2);
});
test('终局命令已提交但反馈丢失时，先结算原请求再进行赛后总结', async t => {
  let summaries = 0;
  const { app, service } = await setup(t, () => ({ async generate(request) {
    assert.equal(request.role, 'summary'); summaries++;
    return { id: 'terminal-summary', model: 'test', output: [], calls: [{ callId: 'summary-call', name: 'submit_result', arguments: JSON.stringify(JSON.parse(request.input[0]!.content as string).stage === 'facts_extract' ? { facts: [] } : { baseVersion: 1, plan: '合成卡组整体计划：建立可持续攻击与接续，控制奖赏交换和资源支出，以实际可见信息调整。', changes: [], changeSummary: '合成终局恢复验证' }) }], usage: null };
  } }));
  const game = await create(app, 'human_ai'), match = service.match(game.match.id);
  await service.agent(match);
  const store = new FileSessionStore(join(match.directory, 'contexts')), session = (await store.load(match.state.id, 'B'))!;
  const request = { matchId: match.state.id, playerId: 'B', requestId: randomUUID(), revision: match.state.revision, tool: 'concede', arguments: {} };
  session.pending = { callId: 'terminal-call', request };
  session.messages.push({ type: 'function_call', call_id: 'terminal-call', name: 'concede', arguments: '{}' });
  await store.save(session);
  assert.equal((await match.execute(request)).status, 'committed');
  assert.equal(match.state.flow.phase, 'finished');
  service.wake(match);
  for (let i = 0; i < 100 && service.drivers.has(match.state.id); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(match.meta.summaries.B?.status, 'completed'); assert.equal(summaries, 2);
  assert.equal((await store.load(match.state.id, 'B'))!.pending, null);
  assert.equal(match.records.filter(r => r.request?.requestId === request.requestId).length, 1);
});
test('自动单方重抽等待对手先摆放，并公开失败手牌再一次选择补抽',async t=>{
  const {dir}=await setup(t); let shuffle=0;
  const entropy={uuid:randomUUID,integer(max:number){if(max===60)shuffle++;return shuffle>=3?0:max-1;}};
  const energy={kind:'energy' as const,name:'火能量',subtype:'basic' as const,energyType:'火'};
  const poor:DeckData={cards:[{card:energy,count:7},{card:basic,count:53}]};
  const match=new MatchRuntime({directory:join(dir,'mulligan'),entropy}); const prompts=await loadPrompts();
  await match.create({id:'mulligan',players:[{id:'A',name:'甲',kind:'human',deck},{id:'B',name:'乙',kind:'human',deck:poor}],mode:'local',prompts,model:{schemaVersion:1,model:'gpt-6.1-terra',reasoningEffort:'medium',fast:false,connection:{kind:'local_codex_credentials'}},strategies:{},rules:'冻结规则'});
  const send=(id:PlayerId,command:GameCommand)=>match.command(id,{requestId:randomUUID(),revision:match.state.revision,command});
  await send(match.state.flow.choice!.playerId,{kind:'choose_first',firstPlayer:'A'});
  assert.equal(match.state.flow.choice!.kind,'initial_placement'); assert.equal(match.state.flow.choice!.playerId,'A'); assert.equal(match.state.setup.mulligans.B,0);
  await send('A',{kind:'initial_placement',active:{zoneId:'A:hand',index:0},bench:[]});
  assert.equal(match.state.setup.mulligans.B,1); assert.equal(match.state.setup.bonus.A,1); assert.ok(match.view('A').events.some(event=>event.commandKind==='show'&&(event.data as Record<string,unknown>).reveals));
  assert.equal(match.state.flow.choice!.playerId,'B'); const eligible=match.state.flow.choice!.eligible![0]!;
  await send('B',{kind:'initial_placement',active:eligible,bench:[]});
  assert.equal(match.state.flow.choice!.kind,'mulligan_draw'); assert.equal(match.state.flow.choice!.maximum,1); assert.equal(match.state.flow.choice!.failedHands!.length,1);
  await send('A',{kind:'mulligan_draw',count:1}); assert.equal(match.state.flow.choice!.kind,'additional_bench');
  const additional=match.state.flow.choice!.eligible!; assert.equal(additional.length,1);
  assert.equal((await send('A',{kind:'additional_bench',bench:[{zoneId:'A:hand',index:1}]})).status,'rejected');
  await send('A',{kind:'additional_bench',bench:additional}); assert.equal(match.state.flow.phase,'turn');
});
test('SSE 无需凭证，按指定视角推送历史观察和状态失效通知',async t=>{
  const {app}=await setup(t); const game=await create(app); const address=await app.listen({host:'127.0.0.1',port:0}); const controller=new AbortController();
  const response=await fetch(`${address}/api/matches/${game.match.id}/events?viewer=A`,{signal:controller.signal}); assert.equal(response.status,200); const reader=response.body!.getReader();
  const first=await reader.read(); assert.match(new TextDecoder().decode(first.value),/event: observation/); assert.match(new TextDecoder().decode(first.value),/event: change/); controller.abort(); await reader.cancel().catch(()=>{});
  assert.equal((await app.inject({url:`/api/matches/${game.match.id}`,headers:{origin:'https://untrusted.example'}})).headers['access-control-allow-origin'],undefined);
});
test('agent 观察与历史只发送紧凑增量，保留已获牌面与流程',async t=>{
  const {app,service}=await setup(t); const game=await create(app); await ready(app,game);
  await command(app,game,'A',{kind:'show',selection:selection('A:hand',0,1)});
  const match=service.match(game.match.id); const frame=await match.observe(game.match.id,'B',null);
  assert.ok(frame.observations.length>10);
  for(const item of frame.observations) { const event=item.data as {data:Record<string,unknown>}; assert.equal(event.data.table,undefined); assert.ok(Array.isArray(event.data.observedCards)); assert.ok(event.data.flow); }
  assert.ok(frame.observations.some(item=>JSON.stringify(item.data).includes('测试宝可梦')));
  for(const cardId of Object.keys(match.state.cards)) assert.equal(JSON.stringify(frame).includes(cardId),false);
  const read=await match.execute({matchId:game.match.id,playerId:'B',requestId:randomUUID(),revision:frame.revision,tool:'read_history',arguments:{}});
  assert.equal(JSON.stringify(read.data).includes('"table"'),false);
  assert.ok((await view(app,game,'B')).events.some(event=>(event.data as Record<string,unknown>).table));
});
test('恢复后洗牌任务中断可从日志续行，不重复恢复或已完成随机',async t=>{
  const {app,service}=await setup(t); const game=await create(app); await ready(app,game); const match=service.match(game.match.id);
  const mark=await command(app,game,'A',{kind:'set_state',target:{kind:'player',playerId:'A'},field:{key:'marker',name:'错误标记',value:1}}); if(mark.status!=='committed')throw Error('mark');
  await command(app,game,'A',{kind:'set_turn',phase:'turn',playerId:'B'});
  await command(app,game,'B',{kind:'object',targetEventId:mark.eventId,reason:'恢复并洗牌',evidenceRefs:[mark.eventId],proposal:{restoreBeforeEventId:mark.eventId,shuffles:[selection('A:deck'),selection('B:deck')]}});
  const dispute=(await view(app,game)).dispute!; const append=match.journal.append.bind(match.journal); let failed=false;
  match.journal.append=async record=>{if(!failed&&record.actor?.kind==='system'&&record.actor.purpose==='disposition'&&record.request?.command.kind==='shuffle'){failed=true;throw Error('测试：落盘前停止');}await append(record);};
  const accepted=await app.inject({method:'POST',url:`/api/matches/${game.match.id}/commands`,payload:{playerId:'A',requestId:randomUUID(),revision:match.state.revision,command:{kind:'respond',response:{kind:'accept',disputeId:dispute.id,proposalId:dispute.proposalId}}}}); assert.equal(accepted.statusCode,503);
  assert.equal(match.meta.dispute!.status,'applying'); assert.equal(match.storageFaulted,true);
  const restored=match.records.filter(record=>record.request?.command.kind==='system_restore'); assert.equal(restored.length,1); assert.equal(match.meta.revoked[mark.eventId],restored[0]!.event!.A.id);
  const recovered=new MatchRuntime({directory:match.directory}); await recovered.recover();
  assert.equal(recovered.meta.dispute!.status,'closed'); assert.equal(recovered.records.filter(record=>record.request?.command.kind==='system_restore').length,1);
  assert.equal(recovered.records.filter(record=>record.actor?.kind==='system'&&record.actor.purpose==='disposition'&&record.request?.command.kind==='shuffle').length,2);
  const reobject=await recovered.command('A',{requestId:randomUUID(),revision:recovered.state.revision,command:{kind:'object',targetEventId:mark.eventId,reason:'旧分支不能复活',evidenceRefs:[mark.eventId]}}); assert.equal(reobject.status,'rejected');
  const explicit=await recovered.command('A',{requestId:randomUUID(),revision:recovered.state.revision,command:{kind:'object',targetEventId:mark.eventId,reason:'只处理信息后果',evidenceRefs:[mark.eventId],proposal:{shuffles:[]}}}); assert.equal(explicit.status,'committed');
});
test('JSONL 中段损坏拒绝恢复，合法无换行末条恢复后继续可读',async t=>{
  const {dir}=await setup(t); const {Journal}=await import('../src/storage.ts'); const {writeFile}=await import('node:fs/promises');
  const invalid=join(dir,'invalid.jsonl'); await writeFile(invalid,'{"a":1}\nBROKEN\n{"a":2}\n'); await assert.rejects(()=>new Journal(invalid).read(),/中段损坏/);
  const valid=join(dir,'valid.jsonl'); await writeFile(valid,'{"a":1}'); const journal=new Journal<{a:number}>(valid); assert.deepEqual(await journal.read(),[{a:1}]); await journal.append({a:2}); assert.deepEqual(await journal.read(),[{a:1},{a:2}]);
});
test('日志不确定提交后禁止继续写入，重启按实际已落盘记录恢复原反馈',async t=>{
  const {app,service}=await setup(t); const game=await create(app); await ready(app,game); const match=service.match(game.match.id); const revision=match.state.revision; const requestId=randomUUID();
  const append=match.journal.append.bind(match.journal); let once=true;
  match.journal.append=async record=>{await append(record);if(once){once=false;throw Error('测试：同步后、内存更新前连接丢失');}};
  const response=await app.inject({method:'POST',url:`/api/matches/${game.match.id}/commands`,payload:{playerId:'A',requestId,revision,command:{kind:'declare',text:'已持久化的宣告'}}});
  assert.equal(response.statusCode,503); assert.equal(match.storageFaulted,true);
  const persisted=await readFile(join(match.directory,'journal.jsonl'),'utf8');
  await assert.rejects(()=>match.command('A',{requestId:randomUUID(),revision,command:{kind:'random',mode:'coins',count:1}}),/重启恢复/);
  await assert.rejects(()=>match.saveRuntime(),/重启恢复/); assert.equal(await readFile(join(match.directory,'journal.jsonl'),'utf8'),persisted);
  const recovered=new MatchRuntime({directory:match.directory});await recovered.recover();assert.equal(recovered.state.revision,revision+1);
  const receipt=await recovered.command('A',{requestId,revision,command:{kind:'declare',text:'已持久化的宣告'}});assert.equal(receipt.status,'committed');assert.equal(recovered.state.revision,revision+1);
});
test('关闭服务先终止活跃SSE流，app.close不等待浏览器断线',async t=>{
  const {app}=await setup(t); const game=await create(app); const address=await app.listen({host:'127.0.0.1',port:0});
  const response=await fetch(`${address}/api/matches/${game.match.id}/events?viewer=A`,{});const reader=response.body!.getReader();await reader.read();
  let timeout:NodeJS.Timeout|undefined; try { await Promise.race([app.close(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('服务关闭超过 1000ms')),1000);})]); } finally {clearTimeout(timeout);await reader.cancel().catch(()=>{});}
});
test('待定胜利被裁判判异常结束时，不能错误确认为被质疑的胜利',async t=>{
  const {app,service}=await setup(t,()=>({async generate(request){
    assert.equal(request.role,'judge');
    const input=JSON.parse(request.input[0]!.content as string) as {validReportedResults:string[];facts:{dispute:{targetEventId:string}}};
    assert.deepEqual(input.validReportedResults,[input.facts.dispute.targetEventId]);
    return {id:'judge-abnormal',model:'test',output:[],calls:[{callId:'judge-abnormal-call',name:'submit_result',arguments:JSON.stringify({verdict:'uphold',explanation:'隐藏信息已无法公平修复',evidenceRefs:[input.facts.dispute.targetEventId],ruleRefs:['规则基准'],steps:[{kind:'end_match',result:{kind:'abnormal',reason:'内部完整裁决不应发布'}}]})}],usage:null};
  }}));
  const game=await create(app); await ready(app,game);
  const report=await command(app,game,'A',{kind:'report_result',result:{kind:'win',winner:'A',reason:'被质疑的胜利'}}); if(report.status!=='committed')throw Error('report');
  await command(app,game,'B',{kind:'object',targetEventId:report.eventId,reason:'不应确认胜利',evidenceRefs:[report.eventId]});
  const dispute=(await view(app,game)).dispute!;
  await command(app,game,'A',{kind:'respond',response:{kind:'defend',disputeId:dispute.id,reason:'请独立裁定',evidenceRefs:[report.eventId]}});
  for(let i=0;i<100&&service.drivers.has(game.match.id);i++)await new Promise(resolve=>setTimeout(resolve,10));
  const final=await view(app,game);assert.equal(final.flow.phase,'finished');assert.deepEqual(final.flow.result,{kind:'abnormal',reason:'裁判判定异常结束'});assert.equal(final.flow.proposedResult,null);assert.equal(final.dispute!.status,'closed');assert.equal(JSON.stringify(final).includes('内部完整裁决不应发布'),false);
  const ruling=final.dispute!.ruling!.steps.at(-1) as {result:{kind:string}};assert.equal(ruling.result.kind,'abnormal');
});
test('裁判恢复将使结果报告失效时，确认计划整份拒绝且不部分恢复',async t=>{
  const {app,service}=await setup(t); const game=await create(app);await ready(app,game);const match=service.match(game.match.id);
  const report=await command(app,game,'A',{kind:'report_result',result:{kind:'win',winner:'A',reason:'待核验'}});if(report.status!=='committed')throw Error('report');
  await command(app,game,'B',{kind:'object',targetEventId:report.eventId,reason:'报告有问题',evidenceRefs:[report.eventId]});
  const dispute=match.meta.dispute!;
  await match.command('A',{requestId:randomUUID(),revision:match.state.revision,command:{kind:'respond',response:{kind:'defend',disputeId:dispute.id,reason:'交由裁判',evidenceRefs:[report.eventId]}}});
  const revision=match.state.revision, records=match.records.length;
  await assert.rejects(()=>match.applyJudge({verdict:'uphold',explanation:'无效的恢复后确认',evidenceRefs:[report.eventId],ruleRefs:['规则基准'],steps:[{kind:'restore',targetEventId:report.eventId},{kind:'end_match',result:{kind:'confirm_reported_result',reportEventId:report.eventId}}]}),/当前或恢复后的候选状态中无效/);
  assert.equal(match.state.revision,revision);assert.equal(match.records.length,records);assert.equal(match.state.flow.phase,'result_pending');assert.equal(match.meta.dispute!.status,'awaiting_judge');assert.equal(match.meta.revoked[report.eventId],undefined);
  await assert.rejects(()=>match.applyJudge({verdict:'uphold',explanation:'不存在的确认引用',evidenceRefs:[report.eventId],ruleRefs:['规则基准'],steps:[{kind:'end_match',result:{kind:'confirm_reported_result',reportEventId:'不存在的报告'}}]}),/确认引用/);
});
test('同一AI对手双席位建局直接拒绝，不产生对局或策略总结副作用',async t=>{
  let calls=0;const {app,service}=await setup(t,()=>({async generate(){calls++;throw Error('本场景不应调用模型');}}));
  const opponent=(await app.inject({method:'POST',url:'/api/opponents',payload:{name:'同一个AI',deck,strategy:'仅本人的策略'}})).json<OpponentRecord>();
  const duplicate=await app.inject({method:'POST',url:'/api/matches',payload:{mode:'ai_ai',players:[{name:'甲',kind:'ai',opponentId:opponent.id},{name:'乙',kind:'ai',opponentId:opponent.id}],autoRun:true}});
  assert.equal(duplicate.statusCode,400);assert.equal(duplicate.json<{error:{code:string}}>().error.code,'DUPLICATE_AI_OPPONENT');assert.equal(service.matches.size,0);assert.equal(service.drivers.size,0);assert.equal(calls,0);assert.equal((await service.opponents.get(opponent.id)).strategies.length,1);
  const independent=(await app.inject({method:'POST',url:'/api/opponents/import',payload:opponent})).json<OpponentRecord>();
  const accepted=await app.inject({method:'POST',url:'/api/matches',payload:{mode:'ai_ai',players:[{name:'甲',kind:'ai',opponentId:opponent.id},{name:'乙',kind:'ai',opponentId:independent.id}]}});assert.equal(accepted.statusCode,200,accepted.body);assert.equal(calls,0);
});
test('debug恢复到建组后移牌前，pause/resume续推原摆放并保留新分支独立任务ID',async t=>{
  let calls=0;const {app,service}=await setup(t,()=>({async generate(){calls++;throw Error('机械准备不应请求模型');}}));const game=await create(app);const match=service.match(game.match.id);
  await command(app,game,match.state.flow.choice!.playerId,{kind:'choose_first',firstPlayer:'A'});
  await command(app,game,'A',{kind:'initial_placement',active:{zoneId:'A:hand',index:0},bench:[{zoneId:'A:hand',index:1}]});
  const move=match.records.find(record=>record.request?.command.kind==='move'&&'destination'in record.request.command&&record.request.command.destination.container.kind==='group'&&record.request.command.destination.container.position.zoneId==='A:active')!;
  const before=match.records[match.records.indexOf(move)-1]!;const oldIds=new Set(match.records.flatMap(record=>record.request?[record.request.requestId]:[]));const recordCount=match.records.length;
  const groupRef=before.state.zones['A:active']!.contents.items[0]!;assert.equal(before.state.groups[groupRef.id]!.stack.length,0);assert.ok(before.meta.tasks.length);
  const restored=await app.inject({method:'POST',url:`/api/matches/${game.match.id}/debug`,payload:{kind:'restore',targetEventId:move.event!.A.id}});assert.equal(restored.statusCode,200,restored.body);
  assert.equal(match.meta.runtime.status,'paused');assert.equal(match.state.groups[groupRef.id]!.stack.length,0);assert.deepEqual(match.meta.bonusCards,before.meta.bonusCards);assert.ok(match.meta.tasks.length);const pendingIds=match.meta.tasks.map(task=>`task:${task.id}`);for(const id of pendingIds)assert.equal(oldIds.has(id),false);
  const duplicate=await command(app,game,'A',{kind:'initial_placement',active:{zoneId:'A:hand',index:0},bench:[]});assert.equal(duplicate.status,'rejected');assert.deepEqual(match.meta.tasks.map(task=>`task:${task.id}`),pendingIds);
  const control=(action:string)=>app.inject({method:'POST',url:`/api/matches/${game.match.id}/control`,payload:{action}});
  assert.equal((await control('pause')).statusCode,202);assert.equal((await control('resume')).statusCode,202);for(let i=0;i<100&&service.drivers.has(game.match.id);i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(match.state.groups[groupRef.id]!.stack.length,1);assert.equal(match.state.setup.placed.A,true);assert.equal(match.state.flow.choice!.kind,'initial_placement');assert.equal(match.state.flow.choice!.playerId,'B');assert.equal(match.meta.tasks.length,0);assert.equal(calls,0);assert.ok(match.records.length>recordCount);assert.ok(match.meta.revoked[move.event!.A.id]);
  for(const id of pendingIds)assert.equal(match.records.filter(record=>record.request?.requestId===id).length,1);
  await command(app,game,'B',{kind:'initial_placement',active:{zoneId:'B:hand',index:0},bench:[]});assert.equal(match.state.flow.phase,'turn');
});
test('AI对手各入口严格校验类型和未知字段，非法输入不会落盘',async t=>{
  const {app,service}=await setup(t);
  for(const input of [{name:{bad:true},deck},{name:7,deck},{deck,strategy:{}},{deck,unknown:true},{deck,strategies:[]}]){const response=await app.inject({method:'POST',url:'/api/opponents',payload:input});assert.equal(response.statusCode,400,response.body);}
  assert.equal((await service.opponents.list()).length,0);
  const saved=(await app.inject({method:'POST',url:'/api/opponents',payload:{name:'合法',deck,strategy:''}})).json<OpponentRecord>();
  for(const input of [{name:{}},{strategy:[]},{extra:'unknown'}]){const response=await app.inject({method:'PUT',url:`/api/opponents/${saved.id}`,payload:input});assert.equal(response.statusCode,400,response.body);}
  assert.deepEqual(await service.opponents.get(saved.id),saved);
  const badArchives:Record<string,unknown>[]=[{...saved,name:{}},{...saved,extra:true},{...saved,strategies:'bad'},{...saved,strategies:[{...saved.strategies[0]!,version:2}]},{...saved,strategies:[{...saved.strategies[0]!,source:{kind:'match',matchId:'m',playerId:'robot'}}]},{...saved,strategies:[{...saved.strategies[0]!,evidenceRefs:[42]}]},{...saved,strategies:[{...saved.strategies[0]!,previousVersion:1}]}];
  for(const input of badArchives){const response=await app.inject({method:'POST',url:'/api/opponents/import',payload:input});assert.equal(response.statusCode,400,response.body);}
  assert.equal((await service.opponents.list()).length,1);assert.deepEqual(await service.opponents.get(saved.id),saved);
});
test('建局严格拒绝robot、错误name/autoRun和未知字段，第二席错误无首席隐式对手副作用',async t=>{
  const {app,service}=await setup(t);const valid={mode:'human_ai',players:[{name:'人类',kind:'human',deck},{name:'AI',kind:'ai',deck}]};
  const invalid:Record<string,unknown>[]=[{...valid,players:[valid.players[0],{name:'机器人',kind:'robot',deck}]},{...valid,autoRun:'true'},{...valid,players:[{name:{bad:true},kind:'human',deck},valid.players[1]]},{...valid,extra:true},{...valid,players:[{...valid.players[0],extra:true},valid.players[1]]},{...valid,players:[valid.players[0]]}];
  for(const input of invalid){const response=await app.inject({method:'POST',url:'/api/matches',payload:input});assert.equal(response.statusCode,400,response.body);}
  const noBasic={cards:[{card:{kind:'energy',name:'火能量',subtype:'basic',energyType:'火'},count:60}]};
  const secondInvalid=await app.inject({method:'POST',url:'/api/matches',payload:{mode:'ai_ai',players:[{name:'甲',kind:'ai',deck},{name:'乙',kind:'ai',deck:noBasic}]}});assert.equal(secondInvalid.statusCode,400);assert.equal(service.matches.size,0);assert.equal((await service.opponents.list()).length,0);assert.equal(service.drivers.size,0);
});
test('裁判只读计划验证不产生授权或副作用，并将不可执行计划反馈给模型重试',async t=>{
  let calls=0;const {app,service}=await setup(t,()=>({async generate(request){assert.equal(request.role,'judge');calls++;const input=JSON.parse(request.input[0]!.content as string) as {facts:{dispute:{targetEventId:string}}};const id=input.facts.dispute.targetEventId;return{id:`judge-plan-${calls}`,model:'test',output:[],calls:[{callId:`judge-plan-call-${calls}`,name:'submit_result',arguments:JSON.stringify({verdict:'uphold',explanation:'验证候选计划',evidenceRefs:[id],ruleRefs:['规则基准'],steps:calls===1?[{kind:'restore',targetEventId:id},{kind:'end_match',result:{kind:'confirm_reported_result',reportEventId:id}}]:[{kind:'end_match',result:{kind:'abnormal',reason:'无法确认原报告'}}]})}],usage:null};}}));
  const game=await create(app);await ready(app,game);const match=service.match(game.match.id);const report=await command(app,game,'A',{kind:'report_result',result:{kind:'win',winner:'A',reason:'待核验'}});if(report.status!=='committed')throw Error('report');await command(app,game,'B',{kind:'object',targetEventId:report.eventId,reason:'需裁定',evidenceRefs:[report.eventId]});const dispute=match.meta.dispute!;
  await match.command('A',{requestId:randomUUID(),revision:match.state.revision,command:{kind:'respond',response:{kind:'defend',disputeId:dispute.id,reason:'请判断',evidenceRefs:[report.eventId]}}});
  const before=JSON.stringify({state:match.state,meta:match.meta,records:match.records});assert.throws(()=>match.validateJudge({verdict:'uphold',explanation:'无效计划',evidenceRefs:[report.eventId],ruleRefs:['规则基准'],steps:[{kind:'restore',targetEventId:report.eventId},{kind:'end_match',result:{kind:'confirm_reported_result',reportEventId:report.eventId}}]}),/候选状态中无效/);assert.equal(JSON.stringify({state:match.state,meta:match.meta,records:match.records}),before);
  service.wake(match);for(let i=0;i<100&&service.drivers.has(game.match.id);i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,2);assert.equal(match.state.flow.result!.kind,'abnormal');assert.equal(match.meta.revoked[report.eventId],undefined);assert.equal(match.meta.dispute!.status,'closed');
});
