/** 只报告是否泄漏及文件位置；绝不将被比对的认证值写入输出。 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const authPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
const auth: unknown = JSON.parse(await readFile(authPath, 'utf8'));
const secrets = new Set<string>();
function collect(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:access_token|refresh_token|id_token|account_id|OPENAI_API_KEY)$/i.test(key) && typeof item === 'string' && item.length >= 8) secrets.add(item);
    else collect(item);
  }
}
collect(auth);
if (!secrets.size) throw new Error('没有取得可比对的本地认证值，不能宣称已检查');
let scannedFiles = 0;
const findings: string[] = [];
async function scan(directory: string): Promise<void> {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/\.(?:jsonl?|log|md|tap|txt)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8'); scannedFiles++;
      if ([...secrets].some(secret => text.includes(secret))) findings.push(path);
    }
  }
}
await scan('artifacts'); await scan('data');
const report = { checkedAt: new Date().toISOString(), scannedFiles, passed: findings.length === 0, findings };
await writeFile('artifacts/full-validation/2026-10-29-integration/secret-scan.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (findings.length) process.exitCode = 1;
