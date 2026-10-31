import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { atomicJson } from '../packages/agent/src/storage.ts';

// 复制实际导入的项目源码再执行。后续工作树改动不会进入本次模型调用。
const source = resolve(import.meta.dirname, '..'), [kind, ...opponents] = process.argv.slice(2);
assert.ok(['context', 'match', 'plan-match', 'replay-match', 'throughput', 'summary', 'regressions'].includes(kind ?? ''), '用法: node scripts/freeze-validation.ts context|throughput|match [对手A ID] [对手B ID] 或 summary <已完成对局目录>');
const target = join(source, 'artifacts/frozen-validation', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + kind + '-' + randomUUID().slice(0, 8));
async function files(folder: string): Promise<string[]> {
  return (await Promise.all((await readdir(join(source, folder), { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]))).flat();
}
const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'system/agent.json', 'system/agent.example.json', 'system/prompts.json', 'system/prompts.example.json',
  ...(await Promise.all(['packages/agent', 'packages/protocol', 'packages/game-core', 'apps/server/src', 'rules', 'scripts'].map(files))).flat()];
const digest = async (root: string) => Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
const before = await digest(source);
await mkdir(dirname(target), { recursive: true }); await mkdir(target);
for (const path of paths) { await mkdir(dirname(join(target, path)), { recursive: true }); await copyFile(join(source, path), join(target, path)); }
assert.deepEqual(await digest(source), before, '复制期间源码变化，请重新冻结');
assert.deepEqual(await digest(target), before);
await symlink(join(source, 'node_modules'), join(target, 'node_modules'), 'dir');
let childArguments = opponents;
if (kind === 'summary' || kind === 'regressions') {
  assert.equal(opponents.length, 1);
  const original = resolve(opponents[0]!), matchId = original.split(/[\\/]/).at(-1)!;
  assert.match(matchId, /^[a-zA-Z0-9_-]{1,128}$/);
  async function inputFiles(folder: string): Promise<string[]> {
    const output: string[] = [];
    for (const entry of await readdir(join(original, folder), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), '对局输入不得含链接');
      const path = join(folder, entry.name);
      if (entry.isDirectory()) output.push(...await inputFiles(path));
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(path);
    }
    return output;
  }
  const inputs = ['journal.jsonl', ...(kind === 'regressions' ? ['agent-trace.jsonl'] : []), ...await inputFiles('contexts')];
  if (kind === 'regressions') for (const entry of await readdir(join(original,'../../opponents'))) {
    if (entry.endsWith('.json')) { await mkdir(join(target,'data/opponents'),{recursive:true}); await copyFile(join(original,'../../opponents',entry),join(target,'data/opponents',entry)); }
  }
  for (const path of inputs) assert.ok((await lstat(join(original, path))).isFile(), '输入必须为常规文件');
  const inputHashes = async (directory: string) => Object.fromEntries(await Promise.all(inputs.map(async path => [path, createHash('sha256').update(await readFile(join(directory, path))).digest('hex')])));
  const originalBefore = await inputHashes(original), copied = join(target, 'data/matches', matchId);
  for (const path of inputs) { await mkdir(dirname(join(copied, path)), { recursive: true }); await copyFile(join(original, path), join(copied, path)); }
  assert.deepEqual(await inputHashes(original), originalBefore, '复制期间原局输入发生变化');
  assert.deepEqual(await inputHashes(copied), originalBefore);
  await atomicJson(join(target, 'summary-input-manifest.json'), { sourceMatchDirectory: original, copiedAt: new Date().toISOString(), files: originalBefore });
  childArguments = [matchId];
} else if (kind === 'replay-match') {
  assert.equal(opponents.length,1);
  const original=resolve(opponents[0]!), journal=await readFile(join(original,'journal.jsonl'),'utf8');
  const initial=JSON.parse(journal.split('\n',1)[0]!);
  assert.equal(initial.kind,'init');assert.equal(initial.meta.randomness?.format,'scoped-hmac-v1');
  const records=[];
  for(const player of initial.state.players) {
    const opponent=JSON.parse(await readFile(join(original,'../../opponents',player.opponentId+'.json'),'utf8'));
    const version=opponent.strategies.find((version: {version:number})=>version.version===initial.meta.strategies[player.id].version);
    assert.equal(version.version,1,'性能回放必须使用清空初始化的v1');assert.ok(version.policy.plan.trim());
    assert.deepEqual(version.policy,initial.meta.strategies[player.id].policy);
    opponent.strategies=[version]; records.push(opponent);
    await atomicJson(join(target,'data/opponents',opponent.id+'.json'),opponent);
  }
  assert.equal(createHash('sha256').update(await readFile(join(original,'journal.jsonl'))).digest('hex'),createHash('sha256').update(journal).digest('hex'),'原局必须已经完成且复制期间不变');
  await atomicJson(join(target,'scenario-input.json'),{sourceMatchDirectory:original,sourceJournalHash:createHash('sha256').update(journal).digest('hex'),initial:{state:initial.state,meta:initial.meta},opponents:records});
  childArguments=[];
} else for (const id of opponents) {
  assert.match(id, /^[a-zA-Z0-9_-]{1,128}$/); const path = join('data/opponents', id + '.json');
  await mkdir(dirname(join(target, path)), { recursive: true }); await copyFile(join(source, path), join(target, path));
}
await atomicJson(join(target, 'source-manifest.json'), { capturedAt: new Date().toISOString(), sourceRoot: source, node: process.version, dependencies: '共享已安装node_modules；版本由package-lock锁定', files: before });
console.log('FROZEN ' + target);
const entry = kind === 'regressions' ? 'validate-regressions.ts' : kind === 'summary' ? 'validate-summary.ts' : kind === 'replay-match' ? 'validate-replay-match.ts' : kind === 'plan-match' ? 'validate-plan-match.ts' : kind === 'match' ? 'validate-match.ts' : kind === 'context' ? 'validate-context-policy.ts' : 'validate-throughput.ts';
const child = spawn(process.execPath, [join(target, 'scripts', entry), ...childArguments], { cwd: target, stdio: 'inherit' });
const code = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1)); });
const after = await digest(target); await atomicJson(join(target, 'source-manifest-after.json'), after);
assert.deepEqual(after, before, '冻结副本不得发生源码/规则/提示词漂移');
process.exitCode = code;
