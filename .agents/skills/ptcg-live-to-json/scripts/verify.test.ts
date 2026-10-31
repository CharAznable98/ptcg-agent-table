import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildApp } from '../../../../apps/server/src/app.ts';

const helper=fileURLToPath(new URL('./verify.ts',import.meta.url));
async function run(args: string[]) {
  const child=spawn(process.execPath,[helper,...args],{stdio:['ignore','pipe','pipe']});
  let output='';
  for (const stream of [child.stdout,child.stderr]) stream.on('data',part=>{output+=part.toString();});
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  return {code,output};
}

test('正式导入参数在隔离 HTTP 服务中支持创建、复用和同名冲突保护',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'ptcg-skill-http-'));
  const app=await buildApp({dataDir:join(temp,'data'),systemDir:join(temp,'system'),logger:false});
  try {
    const address=await app.listen({host:'127.0.0.1',port:0});
    const deck=JSON.parse(await readFile(fileURLToPath(new URL('../../../../examples/decks/合成练习卡组.json',import.meta.url)),'utf8'));
    const source=join(temp,'deck.json');
    await writeFile(source,JSON.stringify(deck));
    const previous=structuredClone(deck); previous.name='原有记录';
    const old=await app.inject({method:'POST',url:'/api/decks',payload:{deck:previous}});
    assert.equal(old.statusCode,200);
    const oldRecord=old.json();
    for (const action of ['created','reused']) {
      const report=join(temp,action+'.json');
      const result=await run([source,'--report',report,'--import-url',address]);
      assert.equal(result.code,0,result.output);
      const evidence=JSON.parse(await readFile(report,'utf8'));
      assert.equal(evidence.status,'passed');
      assert.equal(evidence.liveImport.action,action);
      assert.equal(evidence.liveImport.after,2);
      assert.equal(evidence.liveImport.previousRecordsPreserved,true);
    }
    const before=JSON.parse((await app.inject('/api/decks')).body);
    deck.cards[0].card.name+='（不同内容）';
    await writeFile(source,JSON.stringify(deck));
    const report=join(temp,'conflict.json');
    const conflict=await run([source,'--report',report,'--import-url',address]);
    assert.equal(conflict.code,1,conflict.output);
    assert.match(JSON.parse(await readFile(report,'utf8')).error,/同名但内容不同/);
    assert.deepEqual(JSON.parse((await app.inject('/api/decks')).body),before);
    assert.deepEqual((await app.inject('/api/decks/'+oldRecord.id+'/export')).json(),previous);
    const refusal=await run([source,'--report',report,'--import-url',address]);
    assert.equal(refusal.code,1,'已有验证报告不可覆盖');
    assert.deepEqual(JSON.parse((await app.inject('/api/decks')).body),before);
  } finally {
    await app.close();
    await rm(temp,{recursive:true,force:true});
  }
});
