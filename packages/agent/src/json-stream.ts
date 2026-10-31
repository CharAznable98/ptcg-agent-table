type State = 'value' | 'valueOrEnd' | 'key' | 'keyOrEnd' | 'colon' | 'commaOrEnd';
interface Frame { kind: 'object' | 'array'; state: State }

/** 只判定 JSON 前缀是否仍可能合法，允许跨任意片段的字符串、转义和数字。 */
export class JsonPrefix {
  #frames: Frame[] = [];
  #done = false;
  #string: { key: boolean; escape: boolean; unicode: number } | null = null;
  #literal = '';
  #number = '';
  #fail(): never { throw new Error('INVALID_JSON_PREFIX'); }
  #valueDone() {
    const frame = this.#frames.at(-1);
    if (frame) frame.state = 'commaOrEnd'; else this.#done = true;
  }
  push(delta: string): void {
    for (let index = 0; index < delta.length; index++) {
      const char = delta[index]!;
      if (this.#string) {
        const token = this.#string;
        if (token.unicode) { if (!/[0-9a-fA-F]/.test(char)) this.#fail(); token.unicode--; continue; }
        if (token.escape) { if (!/^["\\/bfnrtu]$/.test(char)) this.#fail(); token.escape = false; if (char === 'u') token.unicode = 4; continue; }
        if (char.charCodeAt(0) < 32) this.#fail();
        if (char === '\\') { token.escape = true; continue; }
        if (char === '"') { this.#string = null; if (token.key) this.#frames.at(-1)!.state = 'colon'; else this.#valueDone(); }
        continue;
      }
      if (this.#literal) {
        if (char !== this.#literal[0]) this.#fail();
        this.#literal = this.#literal.slice(1);
        if (!this.#literal) this.#valueDone();
        continue;
      }
      if (this.#number) {
        if (/[0-9eE+\-.]/.test(char)) {
          this.#number += char;
          if (!/^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(this.#number)) this.#fail();
          // 指数前的小数部分必须已有数字，前导零和重复符号也不能成为合法前缀。
          if (/\.[eE]/.test(this.#number)) this.#fail();
          continue;
        }
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.#number)) this.#fail();
        this.#number = ''; this.#valueDone(); index--; continue;
      }
      if (/^[\t\n\r ]$/.test(char)) continue;
      const frame = this.#frames.at(-1);
      if (!frame && this.#done) this.#fail();
      if (frame?.state === 'key' || frame?.state === 'keyOrEnd') {
        if (char === '}' && frame.state === 'keyOrEnd') { this.#frames.pop(); this.#valueDone(); continue; }
        if (char !== '"') this.#fail();
        this.#string = { key: true, escape: false, unicode: 0 }; continue;
      }
      if (frame?.state === 'colon') { if (char !== ':') this.#fail(); frame.state = 'value'; continue; }
      if (frame?.state === 'commaOrEnd') {
        if (char === (frame.kind === 'object' ? '}' : ']')) { this.#frames.pop(); this.#valueDone(); continue; }
        if (char !== ',') this.#fail();
        frame.state = frame.kind === 'object' ? 'key' : 'value'; continue;
      }
      if (char === ']' && frame?.kind === 'array' && frame.state === 'valueOrEnd') { this.#frames.pop(); this.#valueDone(); continue; }
      if (char === '{') this.#frames.push({ kind: 'object', state: 'keyOrEnd' });
      else if (char === '[') this.#frames.push({ kind: 'array', state: 'valueOrEnd' });
      else if (char === '"') this.#string = { key: false, escape: false, unicode: 0 };
      else if (char === '-' || /[0-9]/.test(char)) this.#number = char;
      else if ('tfn'.includes(char)) this.#literal = ({ t: 'rue', f: 'alse', n: 'ull' } as Record<string, string>)[char]!;
      else this.#fail();
    }
  }
}

/** 极端周期重复仍可能是合法字符串前缀，须独立于语法检测。 */
export class ToolArgumentStream {
  #json = new JsonPrefix();
  #tail = '';
  #sinceCheck = 0;
  push(delta: string): void {
    this.#json.push(delta);
    this.#tail = (this.#tail + delta).slice(-8192);
    this.#sinceCheck += delta.length;
    if (this.#sinceCheck < 32) return;
    this.#sinceCheck = 0;
    for (let width = 1; width <= 16 && width * 512 <= this.#tail.length; width++) {
      const unit = this.#tail.slice(-width);
      if (this.#tail.endsWith(unit.repeat(512))) throw new Error('REPETITIVE_JSON_STREAM');
    }
  }
}
