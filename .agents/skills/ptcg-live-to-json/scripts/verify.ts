import assert from 'node:assert/strict';
import { readFile, mkdir, open, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDeck } from '../../../../apps/web/src/validation.ts';
import { DeckSchema } from '../../../../packages/protocol/src/cards.ts';
import { validationError } from '../../../../packages/agent/src/schema.ts';
import { buildApp } from '../../../../apps/server/src/app.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const argv = process.argv.slice(2);
const file = argv.shift();
if (!file) throw new Error('用法：node verify.ts deck.json [--report 新报告.json] [--expected-total 60] [--import-url http://127.0.0.1:3001]');
const options: Record<string,string> = {};
for (let index=0;index<argv.length;index+=2) {
  const key=argv[index]!; const value=argv[index+1];
  if (!['--report','--expected-total','--import-url'].includes(key) || !value || key in options) throw new Error('无效或重复的参数：'+key);
  options[key]=value;
}
const deckPath=resolve(file);
const raw=await readFile(deckPath,'utf8');
const deck=parseDeck(raw);
assert.equal(validationError(DeckSchema,deck),null);
const expected=Number(options['--expected-total']??60);
assert.ok(Number.isInteger(expected)&&expected>0,'期望张数必须是正整数');
assert.equal(deck.cards.reduce((sum,entry)=>sum+entry.count,0),expected,'卡组张数不符');
const basicPokemon=deck.cards.filter(entry=>entry.card.kind==='pokemon'&&entry.card.stage==='基础').reduce((sum,entry)=>sum+entry.count,0);
assert.ok(basicPokemon>0,'卡组没有基础宝可梦');
const outputSha256=createHash('sha256').update(raw).digest('hex');
let base: URL | undefined;
if (options['--import-url']) {
  base=new URL(options['--import-url']);
  assert.ok(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash,'导入地址应为不含凭证或查询参数的应用根地址');
}
const reportPath=resolve(options['--report']??deckPath+'.verification.json');
await mkdir(dirname(reportPath),{recursive:true});
const reportFile=await open(reportPath,'wx');
const report: Record<string,unknown>={
  verifiedAt:new Date().toISOString(),deckPath,name:deck.name,entries:deck.cards.length,totalCards:expected,
  basicPokemon,frontendParser:'passed',backendSchema:'passed',outputSha256,modelRequests:0,
  schemaSha256:createHash('sha256').update(await readFile(fileURLToPath(new URL('../../../../packages/protocol/src/cards.ts',import.meta.url)))).digest('hex'),
};
async function remote(path: string, payload?: unknown) {
  const response=await fetch(base!.href.replace(/\/$/,'')+path,{
    method:payload===undefined?'GET':'POST',
    ...(payload===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),
    signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('应用接口失败：'+path+' HTTP '+response.status);
  return response.json();
}
let temp: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  temp=await mkdtemp(join(tmpdir(),'ptcg-skill-check-'));
  app=await buildApp({dataDir:join(temp,'data'),systemDir:join(temp,'system'),logger:false});
  const saved=await app.inject({method:'POST',url:'/api/decks',payload:{deck}});
  assert.equal(saved.statusCode,200,saved.body);
  const exported=await app.inject('/api/decks/'+saved.json().id+'/export');
  assert.equal(exported.statusCode,200); assert.deepEqual(exported.json(),deck);
  const game=await app.inject({method:'POST',url:'/api/matches',payload:{mode:'local',players:[{name:'甲',kind:'human',deck},{name:'乙',kind:'human',deck}]}});
  assert.equal(game.statusCode,200,game.body);
  report.isolatedApi={importStatus:200,exportStatus:200,roundTrip:'exact',localMatchStatus:200};
  if (base) {
    const before=(await remote('/api/decks')).decks;
    const existing=before.find((record: any)=>canonical(record.deck)===canonical(deck));
    if (!existing && before.some((record: any)=>record.deck.name===deck.name)) throw new Error('存在同名但内容不同的卡组；未覆盖，请改用明确的新名称或按用户已有替换授权另行处理');
    report.liveImport={baseUrl:base.href,attemptedCreate:!existing};
    const stored=existing??await remote('/api/decks',{deck});
    const exportedLive=await remote('/api/decks/'+stored.id+'/export');
    assert.deepEqual(exportedLive,deck);
    const after=(await remote('/api/decks')).decks;
    assert.equal(after.filter((record: any)=>canonical(record.deck)===canonical(deck)).length,1,'出现同内容重复记录');
    assert.ok(before.every((record: any)=>after.some((item: any)=>item.id===record.id&&canonical(item)===canonical(record))),'原有记录发生变化');
    report.liveImport={baseUrl:base.href,id:stored.id,action:existing?'reused':'created',roundTrip:'exact',before:before.length,after:after.length,previousRecordsPreserved:true};
  }
  report.status='passed';
} catch (error) {
  report.status='failed'; report.error=(error as Error).message;
  process.exitCode=1;
} finally {
  if(app) await app.close();
  if(temp) await rm(temp,{recursive:true,force:true});
  await reportFile.writeFile(JSON.stringify(report,null,2)+'\n'); await reportFile.close();
}
console.log(JSON.stringify(report,null,2));
