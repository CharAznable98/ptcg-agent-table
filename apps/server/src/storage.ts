import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from '../../../packages/agent/src/storage.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) { super(message); this.code = code; this.statusCode = statusCode; }
}
export const clone = <T>(value: T): T => structuredClone(value);
export const now = (): string => new Date().toISOString();
export const uid = (): string => randomUUID();
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export class JsonRepository<T extends { id: string }> {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  path(id: string): string { if (!/^[\w-]+$/.test(id)) throw new ApiError('INVALID_ID', '无效的资源标识'); return join(this.directory, `${id}.json`); }
  async list(): Promise<T[]> {
    await mkdir(this.directory, { recursive: true });
    return Promise.all((await readdir(this.directory)).filter(name => name.endsWith('.json')).sort().map(name => readJson<T>(join(this.directory, name)).then(value => value!)));
  }
  async get(id: string): Promise<T> { const value = await readJson<T>(this.path(id)); if (!value) throw new ApiError('NOT_FOUND', '资源不存在', 404); return value; }
  async save(value: T): Promise<T> { await atomicJson(this.path(value.id), value); return clone(value); }
  async remove(id: string): Promise<void> { await this.get(id); const { unlink } = await import('node:fs/promises'); await unlink(this.path(id)); }
}

/** 单进程每局串行写入。最后一条撕裂记录先留原件再截断；中段损坏拒绝启动。 */
export class Journal<T> {
  readonly path: string;
  constructor(path: string) { this.path = path; }
  async read(): Promise<T[]> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const lines = raw.split('\n');
    const records: T[] = [];
    let validLength = 0; let repaired = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line && i === lines.length - 1) break;
      try { records.push(JSON.parse(line) as T); validLength += Buffer.byteLength(line) + 1; }
      catch {
        if (i < lines.length - 2 || (i === lines.length - 2 && lines.at(-1) !== '')) throw new ApiError('JOURNAL_CORRUPT', '日志中段损坏，已停止恢复', 500);
        await writeFile(`${this.path}.torn-${Date.now()}`, raw, { mode: 0o600 }); repaired = true;
        const file = await open(this.path, 'r+'); try { await file.truncate(validLength); await file.sync(); } finally { await file.close(); }
        break;
      }
    }
    if (raw && !raw.endsWith('\n') && !repaired) { const file = await open(this.path, 'a'); try { await file.writeFile('\n'); await file.sync(); } finally { await file.close(); } }
    return records;
  }
  async append(value: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, 'a', 0o600);
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  }
}
export { atomicJson };
