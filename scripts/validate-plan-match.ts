import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { GameService } from '../apps/server/src/service.ts';
import { atomicJson } from '../packages/agent/src/index.ts';

// 仅由显式验收命令调用，在冻结副本隔离的数据目录清空并初始化。
const root=resolve(import.meta.dirname,'..'), ids=process.argv.slice(2);
assert.equal(ids.length,2);
const service=new GameService({dataDir:join(root,'data'),systemDir:join(root,'system'),rulesDir:join(root,'rules')});
await service.init();
const config = await service.modelConfig();
assert.equal(config.model,'gpt-6.1-terra'); assert.equal(config.reasoningEffort,'medium'); assert.equal(config.fast,false);
const startedAt=new Date().toISOString(), originals=await Promise.all(ids.map(id=>service.opponents.get(id)));
await atomicJson(join(root,'strategies-before-reset.json'),originals);
const records=await Promise.all(originals.map(async original=>{
 const start=Date.now();const fresh=await service.createOpponent({deck:original.deck,name:original.name??'AI'});
 const reset={...fresh,id:original.id};await service.opponents.save(reset);await service.opponents.remove(fresh.id);
 console.log(JSON.stringify({kind:'strategy_initialized',id:original.id,traceId:fresh.id,elapsedMs:Date.now()-start,characters:reset.strategies[0]!.policy!.plan!.length}));
 return {opponentId:original.id,traceId:fresh.id,elapsedMs:Date.now()-start,strategy:reset.strategies[0]!};
}));
await atomicJson(join(root,'strategy-initialization.json'),{startedAt,completedAt:new Date().toISOString(),records});
await service.close();
const { validateOneMatch } = await import('./validate-match.ts');
await validateOneMatch(root,ids);
