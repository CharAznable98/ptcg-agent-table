import { createHmac, randomBytes } from 'node:crypto';
import type { Entropy } from '../../../packages/protocol/src/index.ts';

/** 随机流与牌桌版本分别持久化；身份生成不会消耗洗牌或投币随机流。 */
export interface RandomState { format: 'scoped-hmac-v1'; seed: string; counters: Record<string, number> }
export class ReplayEntropy implements Entropy {
  readonly state: RandomState;
  constructor(state?: RandomState) {
    this.state = structuredClone(state ?? { format: 'scoped-hmac-v1', seed: randomBytes(32).toString('hex'), counters: {} });
    if (this.state.format !== 'scoped-hmac-v1' || !/^[a-f0-9]{64}$/.test(this.state.seed)
      || Object.values(this.state.counters).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('INVALID_RANDOM_STATE');
  }
  snapshot(): RandomState { return structuredClone(this.state); }
  #bytes(stream: string): Buffer {
    const counter = this.state.counters[stream] ?? 0;
    if (!Number.isSafeInteger(counter + 1)) throw new Error('RANDOM_STREAM_EXHAUSTED');
    this.state.counters[stream] = counter + 1;
    return createHmac('sha256', this.state.seed).update(JSON.stringify([stream, counter])).digest();
  }
  uuid(): string {
    const bytes = this.#bytes('identity'); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString('hex').slice(0, 32);
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  #integer(stream: string, max: number): number {
    if (!Number.isSafeInteger(max) || max < 1 || max > 0x100000000) throw new Error('INVALID_RANDOM_BOUND');
    const limit = Math.floor(0x100000000 / max) * max;
    for (;;) { const value = this.#bytes(stream).readUInt32BE(); if (value < limit) return value % max; }
  }
  integer(max: number): number { return this.#integer('random:default', max); }
  scoped(purpose: string): Entropy {
    return { uuid: () => this.uuid(), integer: max => this.#integer(`random:${purpose}`, max) };
  }
}
