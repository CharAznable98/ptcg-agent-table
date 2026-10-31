import type { ModelItem, Observation } from './types.ts';
import { contextBytes, userMessage } from './context.ts';

export interface ReviewPage { observations: Observation[]; toolHistory: ModelItem[] }

/** 每个事实都进入一个有界页；极大单条保留可还原的 JSON 分片，不静默截断。 */
export function reviewPages(observations: Observation[], toolHistory: ModelItem[], base: ModelItem, maxBytes: number): ReviewPage[] {
  const pages: ReviewPage[] = [];
  let page: ReviewPage = { observations: [], toolHistory: [] };
  const size = (candidate: ReviewPage) => contextBytes([userMessage({ ...base, ...candidate })]);
  const add = (field: keyof ReviewPage, item: Observation | ModelItem) => {
    const candidate = { ...page, [field]: [...page[field], item] } as ReviewPage;
    if (size(candidate) <= maxBytes) { page = candidate; return; }
    if (page.observations.length || page.toolHistory.length) { pages.push(page); page = { observations: [], toolHistory: [] }; }
    const singleton = { ...page, [field]: [item] } as ReviewPage;
    if (size(singleton) <= maxBytes) { page = singleton; return; }
    const text = JSON.stringify(item);
    let offset = 0, part = 0;
    while (offset < text.length) {
      let low = offset + 1, high = text.length, end = offset;
      const fragment = (until: number) => ({ ...('id' in item ? { id: item.id, revision: item.revision } : {}), fragment: { part, jsonText: text.slice(offset, until), final: until === text.length } });
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (size({ ...page, [field]: [fragment(middle)] } as ReviewPage) <= maxBytes) { end = middle; low = middle + 1; } else high = middle - 1;
      }
      if (end === offset) throw new Error('REVIEW_FIXED_INPUT_EXCEEDS_BUDGET');
      // 避免在 UTF-16 代理对中间切断中文扩展字符／emoji。
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      if (end === offset) throw new Error('REVIEW_FIXED_INPUT_EXCEEDS_BUDGET');
      pages.push({ ...page, [field]: [fragment(end)] } as ReviewPage); offset = end; part++;
    }
  };
  for (const event of observations) add('observations', event);
  for (const item of toolHistory) add('toolHistory', item);
  if (page.observations.length || page.toolHistory.length) pages.push(page);
  return pages;
}
