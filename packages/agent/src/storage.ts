import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PlayerSession, SessionStore, TraceSink } from './types.ts';

/** 精确凭证替换加常见字段屏蔽；调用方只应提交无认证字段的请求正文。 */
export class SecretRedactor {
  #secrets = new Set<string>();
  add(secret: string | undefined): void { if (secret && secret.length >= 8) this.#secrets.add(secret); }
  clean<T>(value: T): T {
    let text = JSON.stringify(value, (key, item: unknown) =>
      /^(authorization|access_token|refresh_token|id_token|api_key|account_id)$/i.test(key) ? '[REDACTED]' : item,
    );
    for (const secret of this.#secrets) text = text.replaceAll(secret, '[REDACTED]');
    return JSON.parse(text) as T;
  }
}

/** 同目录原子替换；首版只允许单进程写该数据目录。 */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(tmp, path);
  const dir = await open(dirname(path), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

export interface JsonlTraceOptions {
  streamBatchBytes?: number;
  streamFlushIntervalMs?: number;
}

/** 流片段按大小／时间批量同步；其他事件是持久屏障，返回前保存全部前缀。 */
export class JsonlTrace implements TraceSink {
  readonly path: string;
  readonly redactor: SecretRedactor;
  #tail: Promise<void> = Promise.resolve();
  #buffer: string[] = [];
  #bufferBytes = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #fault: unknown = null;
  readonly options: Required<JsonlTraceOptions>;
  constructor(path: string, redactor = new SecretRedactor(), options: JsonlTraceOptions = {}) {
    this.path = path; this.redactor = redactor;
    this.options = { streamBatchBytes: options.streamBatchBytes ?? 65_536, streamFlushIntervalMs: options.streamFlushIntervalMs ?? 100 };
    if (Object.values(this.options).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('TRACE_OPTIONS_INVALID');
  }
  async append(event: Record<string, unknown>): Promise<void> {
    if (this.#fault) throw this.#fault;
    // 入队时固定内容和时间，避免调用方随后修改对象影响实际记录。
    const line = JSON.stringify(this.redactor.clean({ at: new Date().toISOString(), ...event })) + '\n';
    this.#buffer.push(line); this.#bufferBytes += Buffer.byteLength(line);
    if (event.kind !== 'model_stream' || this.#bufferBytes >= this.options.streamBatchBytes) return this.flush();
    if (!this.#timer) {
      this.#timer = setTimeout(() => { this.#timer = null; void this.flush().catch(() => {}); }, this.options.streamFlushIntervalMs);
      this.#timer.unref();
    }
  }
  flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#fault) return Promise.reject(this.#fault);
    if (!this.#buffer.length) return this.#tail.then(() => { if (this.#fault) throw this.#fault; });
    const content = this.#buffer.join(''); this.#buffer = []; this.#bufferBytes = 0;
    const task = this.#tail.then(async () => {
      if (this.#fault) throw this.#fault;
      await mkdir(dirname(this.path), { recursive: true });
      const file = await open(this.path, 'a', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally { await file.close(); }
    }).catch(error => { this.#fault ??= error; throw error; });
    this.#tail = task.catch(() => {});
    return task;
  }
}

export class FileSessionStore implements SessionStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  #path(matchId: string, playerId: string): string {
    return join(this.directory, createHash('sha256').update(JSON.stringify([matchId, playerId])).digest('hex') + '.json');
  }
  async load(matchId: string, playerId: string): Promise<PlayerSession | null> {
    let raw: string;
    try { raw = await readFile(this.#path(matchId, playerId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const session = JSON.parse(raw) as PlayerSession;
    if (session.schemaVersion !== 1 || session.matchId !== matchId || session.playerId !== playerId || !Array.isArray(session.messages) || !Array.isArray(session.observations)) {
      throw new Error('CONTEXT_INVALID: 上下文版本或席位不匹配');
    }
    return session;
  }
  async save(session: PlayerSession): Promise<void> { await atomicJson(this.#path(session.matchId, session.playerId), session); }
}

export class MemorySessionStore implements SessionStore {
  #values = new Map<string, PlayerSession>();
  async load(matchId: string, playerId: string): Promise<PlayerSession | null> {
    const value = this.#values.get(JSON.stringify([matchId, playerId]));
    return value ? structuredClone(value) : null;
  }
  async save(session: PlayerSession): Promise<void> {
    this.#values.set(JSON.stringify([session.matchId, session.playerId]), structuredClone(session));
  }
}
