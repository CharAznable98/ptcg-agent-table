import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFactGroups, type ReviewStructured, type ReviewStage } from '../src/strategy-review.ts';
import { contextBytes, userMessage } from '../src/context.ts';
import { parseStructured, type ReviewFact } from '../src/schema.ts';
import type { TSchema } from '@sinclair/typebox';
import type { Observation } from '../src/types.ts';

const fact = (id: string, conflictKey = id): ReviewFact => ({ id, kind: 'event', status: 'unresolved', statement: '检查完整来源', subjectRefs: [], conflictKey, evidenceRefs: [id], publicRefs: [], relatedEntryIds: [] });
const source = (id: string, size: number): Observation => ({ id, revision: 1, data: { observed: id, content: 'x'.repeat(size) } });

test('超过常规预算但不超过硬上限的不可拆命题单独核验，且不混入普通批次', async () => {
  const observations = [source('small-a', 10), source('large', 4500), source('small-b', 10)];
  const requests: { ids: string[]; bytes: number; evidence: string[] }[] = [];
  const structured: ReviewStructured = async <T>(_stage: ReviewStage, input: any, schema: TSchema, validate?: (value: T) => void | Promise<void>) => {
    requests.push({ ids: input.facts.map((item: ReviewFact) => item.id), bytes: contextBytes([userMessage(input)]), evidence: input.relatedObservations.map((item: Observation) => item.id) });
    const value = parseStructured<T>(schema, { assessments: input.facts.map((item: ReviewFact) => ({ factId: item.id, status: 'supported', evidenceRefs: item.evidenceRefs, publicRefs: [], explanation: '依据完整原件' })) });
    await validate?.(value); return value;
  };
  const reviewed = await reviewFactGroups({ facts: [fact('small-a'), fact('large'), fact('small-b')], observations, currentPublicInPlayFacts: [], fixed: {}, budget: 1800, maxGroupBudget: 8000, structured, trace: { async append() {} } });
  assert.deepEqual(requests.map(request => request.ids), [['small-a'], ['large'], ['small-b']]);
  assert.ok(requests[1]!.bytes > 1800 && requests[1]!.bytes <= 8000);
  assert.deepEqual(requests[1]!.evidence, ['large']);
  assert.ok(requests.filter(request => !request.ids.includes('large')).every(request => request.bytes <= 1800));
  assert.ok(reviewed.every(item => item.status === 'supported'));
});

test('真正超过硬预算保持未决且不截证；旧调用默认硬预算等于常规预算', async () => {
  for (const maxGroupBudget of [undefined, 3000]) {
    let called = false;
    const reviewed = await reviewFactGroups({ facts: [fact('oversized')], observations: [source('oversized', 6000)], currentPublicInPlayFacts: [], fixed: {}, budget: 1800, ...(maxGroupBudget ? { maxGroupBudget } : {}), structured: async () => { called = true; throw new Error('不应截断后调用'); }, trace: { async append() {} } });
    assert.equal(called, false);
    assert.equal(reviewed[0]!.status, 'unresolved');
    assert.match(reviewed[0]!.assessment.explanation, new RegExp(`超过 ${maxGroupBudget ?? 1800} 字节`));
  }
});
