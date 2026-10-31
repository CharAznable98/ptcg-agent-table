import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 对照跨重启时也必须使用相同执行实现，避免把代码变化当成策略收益。 */
export async function runtimeFingerprint(): Promise<string> {
  const root = resolve(import.meta.dirname, '../../..');
  async function files(relative: string): Promise<string[]> {
    const entries = await readdir(join(root,relative),{withFileTypes:true});
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(relative,entry.name)) : entry.name.endsWith('.ts') ? [join(relative,entry.name)] : []))).flat();
  }
  const paths = ['package-lock.json', ...(await Promise.all(['packages/protocol/src','packages/agent/src','packages/game-core/src','apps/server/src'].map(files))).flat()].sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(await readFile(join(root,path))).update('\0');
  return hash.digest('hex');
}
