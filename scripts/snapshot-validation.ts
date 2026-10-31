import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { loadPrompts } from '../packages/agent/src/prompts.ts';

const root = resolve(import.meta.dirname, '..');
const files: string[] = [];
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    if (directory === 'rules' && entry.name === 'sources') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:ts|tsx|css|html|json|md)$/.test(entry.name)) files.push(path);
  }
}
for (const directory of ['packages', 'apps', 'examples', 'scripts', 'rules']) await collect(directory);
files.push('package.json', 'package-lock.json', 'tsconfig.json', 'system/prompts.json', 'system/agent.example.json');
const id = new Date().toISOString().replaceAll(':', '-');
const directory = join(root, 'artifacts/full-validation', id);
await mkdir(directory, { recursive: true });
const hashes = Object.fromEntries(await Promise.all(files.sort().map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
await writeFile(join(directory, 'source-manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, promptVersion: (await loadPrompts()).version, files: hashes }, null, 2) + '\n');
console.log(relative(root, directory));
