import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, MemorySessionStore, loadDefaultPrompts, loadPrompts, parsePrompts } from '../src/index.ts';
import type { MatchPort, ModelGateway, ModelRequest } from '../src/types.ts';

test('提示词版本涵盖四角色、工具及反馈，忽略JSON字段顺序和外部指定的version', async () => {
  const original = await loadPrompts();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(parsePrompts({ ...reordered, version: 'forged-version' }).version, original.version);
  for (const changed of [
    { ...original, judge: original.judge + '新增指令' },
    { ...original, toolDescriptions: { ...original.toolDescriptions, move: '更新工具说明' } },
    { ...original, feedback: { ...original.feedback, playerToolRequired: '更新纠错提示' } },
  ]) assert.notEqual(parsePrompts(changed).version, original.version);
  const missingTool = structuredClone(original); delete missingTool.toolDescriptions.move;
  assert.throws(() => parsePrompts(missingTool), /PROMPT_TOOL_DESCRIPTION_MISSING/);
  const missingFeedback = structuredClone(original); delete missingFeedback.feedback.invalidArgumentsJson;
  assert.throws(() => parsePrompts(missingFeedback), /PROMPT_FEEDBACK_MISSING/);
  assert.throws(() => parsePrompts({ ...original, player: '' }), /STRUCTURED_OUTPUT_INVALID/);
});

test('独立JSON配置保存后重新加载，既有bundle不随文件更新，出厂配置独立保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ptcg-prompts-'));
  try {
    const file = join(directory, 'prompts.json');
    const defaults = await loadDefaultPrompts();
    await writeFile(file, JSON.stringify(defaults));
    const frozen = await loadPrompts(file);
    await writeFile(file, JSON.stringify({ ...defaults, summary: '下一局专用总结' }));
    const next = await loadPrompts(file);
    assert.equal(frozen.summary, defaults.summary);
    assert.equal(next.summary, '下一局专用总结');
    assert.notEqual(next.version, frozen.version);
    assert.deepEqual(await loadDefaultPrompts(), defaults);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('运行模块使用配置内纠错与工具描述，并隔离调用方后续修改', async () => {
  const prompts = await loadDefaultPrompts();
  prompts.player = '自定义玩家正文';
  prompts.feedback.playerToolRequired = '配置里的唯一工具提醒';
  prompts.toolDescriptions.submit_result = '配置里的结构化提交说明';
  const requests: ModelRequest[] = [];
  let finished = false;
  const port: MatchPort = {
    async observe(matchId, playerId) { return { matchId, playerId, revision: finished ? 1 : 0, cursor: '1', status: finished ? 'finished' : 'active', snapshot: {}, observations: [{ id: 'observed', revision: 0, data: {} }], tools: [{ name: 'next', description: 'next', effect: 'command', inputSchema: Type.Object({}) }] }; },
    async execute() { finished = true; return { status: 'committed', revision: 1, data: {} }; },
  };
  const model: ModelGateway = { async generate(request) {
    requests.push(request);
    if (request.role !== 'player') {
      const input = JSON.parse(request.input[0]!.content as string);
      const args = JSON.stringify(input.stage === 'facts_extract' ? { facts: [] } : { baseVersion: 1, changes: [], changeSummary: '无变更' });
      return { id: 'summary', model: 'test', output: [], calls: [{ callId: 'summary', name: 'submit_result', arguments: args }], usage: null };
    }
    if (requests.length === 1) return { id: 'no-tool', model: 'test', output: [], calls: [], usage: null };
    return { id: 'next', model: 'test', output: [], calls: [{ callId: 'next', name: 'next', arguments: '{}' }], usage: null };
  } };
  const runtime = new AgentRuntime({ model, match: port, store: new MemorySessionStore(), trace: { async append() {} }, prompts });
  prompts.player = '不应进入本局';
  prompts.summary = '不应进入本局';
  prompts.feedback.playerToolRequired = '不应进入本局';
  await runtime.create({ matchId: 'configured', playerId: 'A', deck: {}, strategy: { version: 1, content: '' }, rules: '本局冻结规则' });
  assert.equal((await runtime.activate('configured', 'A')).status, 'finished');
  assert.match(requests[0]!.instructions, /自定义玩家正文/);
  assert.doesNotMatch(requests[0]!.instructions, /不应进入本局/);
  assert.match(JSON.stringify(requests[1]!.input), /配置里的唯一工具提醒/);
  await runtime.summarize('configured', 'A', { version: 1, content: '' });
  assert.equal(requests.at(-1)!.tools[0]!.description, '配置里的结构化提交说明');
  assert.doesNotMatch(requests.at(-1)!.instructions, /不应进入本局/);
});
