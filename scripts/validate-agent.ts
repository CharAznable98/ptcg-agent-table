import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { AgentRuntime, EnvironmentCredentials, FileSessionStore, HttpModelGateway, JsonlTrace, LocalCodexCredentials, SecretRedactor, StrategyRepository, atomicJson, loadPrompts, loadModelConfig, createModel } from '../packages/agent/src/index.ts';
import type { Json, MatchPort, ModelItem, Observation, PlayerFrame, ToolRequest } from '../packages/agent/src/types.ts';
import { TableFixture } from '../packages/agent/test/table-fixture.ts';

const root = resolve(import.meta.dirname, '..');
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID().slice(0, 6);
const directory = join(root, 'artifacts/agent-validation', runId);
await mkdir(directory, { recursive: true });
const sourceFiles = [join(root, 'package-lock.json'), join(root, 'scripts/validate-agent.ts'), join(root, 'system/agent.example.json'), ...(await allFiles(join(root, 'packages/agent')))];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path.slice(root.length + 1), createHash('sha256').update(await readFile(path)).digest('hex')])));
await atomicJson(join(directory, 'source-manifest.json'), sourceHashes);
const redactor = new SecretRedactor();
const trace = new JsonlTrace(join(directory, 'trace.jsonl'), redactor);
const credentials = new LocalCodexCredentials(undefined, redactor);
const config = await loadModelConfig(join(root, 'system/agent.example.json'));
assert.equal(config.model, 'gpt-6.1-terra'); assert.equal(config.reasoningEffort, 'medium'); assert.equal(config.fast, false);
const model = createModel(config, trace, redactor);
const prompts = await loadPrompts();
const rules = await readFile(join(root, 'rules/规则基准.md'), 'utf8');
const storeDirectory = join(directory, 'contexts');
const store = new FileSessionStore(storeDirectory);
const memory = new StrategyRepository(join(directory, 'opponents'), trace);
const deck: Json = { name: 'Agent 集成验证卡组（合成测试卡，不是官方卡）', cards: [
  { card: { name: '验证种子（合成测试卡）', kind: 'pokemon', hp: 60, types: ['grass'], stage: '基础', abilities: [], attacks: [{ name: '硬币叶片', energyCost: [{ type: 'grass', count: 1 }], damageText: '20+', text: '投掷一枚硬币，正面造成60点伤害，反面造成20点伤害。' }], weaknesses: [], resistances: [], retreatCost: 1 }, count: 1 },
  { card: { name: '基本草能量', kind: 'energy', subtype: 'basic', energyType: 'grass' }, count: 59 },
] };
const cases: { name: string; passed: boolean; evidence: unknown }[] = [];
async function passed(name: string, evidence: unknown): Promise<void> { cases.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); await atomicJson(join(directory, 'progress.json'), { runId, cases }); }
const options = (match: MatchPort) => ({ model, match, store: new FileSessionStore(storeDirectory), trace, prompts });

async function allFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? allFiles(join(path, e.name)) : [join(path, e.name)]))).flat();
}

let compatibleServer: ReturnType<typeof createServer> | null = null;
try {
  const opponentA = await memory.create(deck);
  const opponentB = await memory.create({ name: 'B 验证卡组（合成测试卡）', cards: [
    { card: { name: '验证靶子（合成测试卡）', kind: 'pokemon', hp: 60, types: ['colorless'], stage: '基础', abilities: [], attacks: [], weaknesses: [], resistances: [], retreatCost: 1 }, count: 1 },
    { card: { name: '对手隐藏测试牌', kind: 'trainer', subtype: 'item', text: '这是合成测试卡，不在本片段使用。' }, count: 1 },
    { card: { name: '基本草能量', kind: 'energy', subtype: 'basic', energyType: 'grass' }, count: 58 },
  ] });
  const table = new TableFixture('late-game-fragment', trace, { stale: true, disconnectAfterCoin: true });
  let agent = new AgentRuntime(options(table));
  for (const [playerId, opponent] of [['A', opponentA], ['B', opponentB]] as const) {
    await agent.create({ matchId: table.matchId, playerId, deck: opponent.deck, strategy: await memory.latest(opponent.id), rules });
  }
  console.log('RUN 真实 Terra 多步对战片段，注入一次版本冲突及投币提交后断连');
  let restarted = false;
  for (let activation = 0; activation < 6 && !table.finished; activation++) {
    const playerId = table.operator;
    const outcome = await agent.activate(table.matchId, playerId);
    await trace.append({ kind: 'validation_activation', playerId, outcome });
    if (outcome.status === 'aborted') {
      assert.match(outcome.reason ?? '', /SIMULATED_DISCONNECT_AFTER_COMMIT/);
      assert.equal(restarted, false);
      assert.ok((await store.load(table.matchId, playerId))?.pending);
      // 新 Runtime 与新文件读取对象，故意不沿用旧对象内存。
      agent = new AgentRuntime(options(table)); restarted = true;
      console.log('RESUME 从磁盘恢复 pending，沿用投币原请求 ID');
    }
  }
  assert.equal(table.finished, true, '晚局片段必须经对手确认结束');
  assert.equal(table.reported?.winner, 'A');
  assert.equal(table.randomCalls, 1, '提交后断连不得重复产生投币结果');
  assert.equal(restarted, true); assert.equal(table.injectedStale, true);
  const committed = table.journal.filter(e => e.receipt.status === 'committed');
  const coinIndex = committed.findIndex(e => e.request.tool === 'coin');
  const damageIndex = committed.findIndex(e => e.request.tool === 'set_damage');
  const declaration = committed.findIndex(e => e.request.tool === 'declare');
  assert.ok(declaration >= 0 && coinIndex > declaration && damageIndex > coinIndex);
  const damage = committed[damageIndex]!.request.arguments as { damageCounters: number };
  assert.equal(damage.damageCounters, 4 + (table.coinResult === 'heads' ? 6 : 2), '必须按服务端真实投币结果计算累计伤害');
  assert.equal(table.zones.A_prizes?.filter(Boolean).length, 0);
  assert.equal(table.zones.B_active?.filter(Boolean).length, 0);
  assert.equal(table.zones.B_discard?.length, 1);
  const active = table.zones.A_active?.[0];
  assert.ok(active && 'attached' in active && active.attached.length === 1, '附能必须实际移动能量，而非只宣告');
  await atomicJson(join(directory, 'table-commands.json'), table.journal);
  await passed('真实多步对战片段、投币分支、拒绝反馈与断连续行', { commands: committed.length, coin: table.coinResult, randomCalls: table.randomCalls, restarted, rejected: table.journal.filter(e => e.receipt.status === 'rejected').length });

  console.log('RUN 真实赛后总结、版本发布和下局快照');
  for (const [playerId, opponent] of [['A', opponentA], ['B', opponentB]] as const) {
    const latest = await memory.latest(opponent.id);
    const update = await agent.summarize(table.matchId, playerId, latest);
    const input = { opponentId: opponent.id, matchId: table.matchId, playerId, baseVersion: latest.version, update };
    const saved = await memory.publish(input);
    const retry = await new StrategyRepository(join(directory, 'opponents'), trace).publish(input);
    assert.equal(saved.version, 2); assert.equal(retry.version, 2);
    assert.equal((await memory.read(opponent.id)).strategies.length, 2);
    await agent.create({ matchId: 'next-match', playerId, deck: opponent.deck, strategy: await memory.latest(opponent.id), rules });
    assert.equal((await store.load('next-match', playerId))?.strategy.version, 2);
    assert.equal((await store.load(table.matchId, playerId))?.strategy.version, 1);
  }
  await passed('真实赛后记忆总结、版本幂等与新旧局策略隔离', { opponents: 2, latestVersions: [2, 2], oldMatchVersions: [1, 1] });

  console.log('RUN 回滚后信息保留、真实模型压缩与重载后的记忆使用');
  let recalled = false;
  const recallEvents: Observation[] = [
    { id: 'look-e1', revision: 1, data: { kind: 'look', cardName: '回滚后仍记得的验证卡-913', positionAtRevision: { zoneId: 'A_deck', index: 0 } } },
    { id: 'restore-e2', revision: 2, data: { kind: 'rollback', revokedEventIds: ['look-e1'], message: '牌桌状态已恢复，但实际见过的信息保留；当前牌库已重新洗牌，旧位置失效。' } },
  ];
  const recall: MatchPort = {
    async observe(matchId, playerId, after): Promise<PlayerFrame> { return { matchId, playerId, revision: 2, cursor: '2', status: recalled ? 'waiting' : 'active',
      snapshot: { task: '在这个记忆验证片段中，调用 record_seen 报告你曾看到的卡名，并说明旧位置是否仍可直接使用。当前牌库牌面不可见。', deck: [{ hidden: true }] },
      observations: after ? [] : recallEvents, tools: [{ name: 'record_seen', effect: 'read', description: '只记录已有知识，不查看隐藏牌或修改牌桌。', inputSchema: Type.Object({ cardName: Type.String(), oldPositionStillValid: Type.Boolean() }, { additionalProperties: false }) }] }; },
    async execute(request: ToolRequest) {
      const args = request.arguments as { cardName: string; oldPositionStillValid: boolean };
      assert.equal(args.cardName, '回滚后仍记得的验证卡-913'); assert.equal(args.oldPositionStillValid, false); recalled = true;
      return { status: 'read', revision: 2, data: { recorded: true } };
    },
  };
  let recallAgent = new AgentRuntime(options(recall));
  await recallAgent.create({ matchId: 'rollback-context', playerId: 'A', deck, strategy: await memory.latest(opponentA.id), rules });
  // 先给同一个席位送达观察，再压缩并完全重新读取上下文。
  const context = (await store.load('rollback-context', 'A'))!;
  context.observations = recallEvents; context.cursor = '2';
  context.messages = [{ role: 'user', content: JSON.stringify({ observations: recallEvents }) }];
  await store.save(context);
  await recallAgent.compact('rollback-context', 'A');
  recallAgent = new AgentRuntime(options(recall));
  assert.equal((await recallAgent.activate('rollback-context', 'A')).status, 'waiting');
  assert.equal((await store.load('rollback-context', 'A'))?.strategy.version, 2);
  await passed('真实压缩、磁盘重载及回滚后已见信息保留', { recalled, compactions: (await store.load('rollback-context', 'A'))?.compactions });

  console.log('RUN 真实裁判：先攻首回合支援者违规与已撤销查看的信息后果');
  const judgeOne = await agent.judge({ matchId: 'judge-first-turn', disputeId: 'd-first-turn',
    facts: { currentTurn: 'A先攻最初回合', target: { id: 'supporter-e1', action: 'A从手牌使用支援者', overrideEffect: null }, objection: '先攻最初回合不能使用支援者', judgeOnlySecret: 'JUDGE_ONLY_coral_7241' },
    evidenceIds: ['supporter-e1'], ruleRefs: ['规则基准.md#5.1'], validRestoreTargets: ['supporter-e1'], zones: [], rules });
  assert.equal(judgeOne.verdict, 'uphold'); assert.ok(judgeOne.steps.some(s => s.kind === 'restore' && s.targetEventId === 'supporter-e1'));
  const judgeTwo = await agent.judge({ matchId: 'judge-information', disputeId: 'd-information',
    facts: { oldEvents: [{ id: 'wrong-move-e10', revoked: true }, { id: 'peek-e11', revoked: true, action: '无任何卡文授权，擅自查看了对手整个牌库顺序' }],
      current: { activeHistoryHead: 'active-e30', deckSize: 3 }, objection: '状态虽已恢复，但牌库顺序已泄露，要求洗牌或判异常结束', response: '承认未经允许查看，但主张状态回滚已经足够' },
    evidenceIds: ['wrong-move-e10', 'peek-e11', 'active-e30'], ruleRefs: ['规则基准.md#3', '规则基准.md#9'], validRestoreTargets: ['active-e30'], zones: [{ zoneId: 'B_deck', size: 3 }], rules });
  assert.equal(judgeTwo.verdict, 'uphold'); assert.ok(judgeTwo.steps.some(s => s.kind === 'shuffle' || s.kind === 'end_match'));
  assert.ok(!judgeTwo.steps.some(s => s.kind === 'restore'));
  await atomicJson(join(directory, 'judge-decisions.json'), { firstTurn: judgeOne, information: judgeTwo });
  await passed('真实裁判按需介入、规则引用与旧分支恢复拒绝', { disputes: 2, verdicts: [judgeOne.verdict, judgeTwo.verdict] });

  console.log('RUN OpenAI 兼容 Chat Completions HTTP 接口，以真实 Terra 作上游');
  const compatibilityKey = 'local-validation-key-' + randomUUID();
  process.env.PTCG_VALIDATION_COMPAT_KEY = compatibilityKey;
  redactor.add(compatibilityKey);
  let upstreamCalls = 0;
  // 此桥仅属于验证，不是产品新增服务，也不冒充独立第三方模型服务。
  compatibleServer = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, `Bearer ${compatibilityKey}`);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; reasoning_effort: string; service_tier: string; messages: ModelItem[]; tools: { function: { name: string; description: string; parameters: ReturnType<typeof Type.Object> } }[]; tool_choice: { function: { name: string } } };
      assert.equal(body.model, 'gpt-6.1-terra'); assert.equal(body.reasoning_effort, 'medium'); assert.equal(body.service_tier, 'default');
      const reply = await model.generate({ role: 'summary', sessionId: 'compatibility-upstream', instructions: String(body.messages[0]!.content), input: body.messages.slice(1),
        tools: body.tools.map(t => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters, effect: 'read' })), toolChoice: body.tool_choice.function.name });
      upstreamCalls++;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: reply.id, model: reply.model, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: reply.calls.map(c => ({ id: c.callId, type: 'function', function: { name: c.name, arguments: c.arguments } })) } }], usage: reply.usage }));
    } catch { res.writeHead(500); res.end(JSON.stringify({ error: { code: 'VALIDATION_BRIDGE_FAILED' } })); }
  });
  await new Promise<void>(resolve => compatibleServer!.listen(0, '127.0.0.1', resolve));
  const address = compatibleServer.address(); assert.ok(address && typeof address !== 'string');
  const compat = new HttpModelGateway({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credentials: new EnvironmentCredentials('PTCG_VALIDATION_COMPAT_KEY', redactor), protocol: 'chat_completions', model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, trace, redactor });
  const compatReply = await compat.generate({ role: 'summary', sessionId: 'compatible-client', instructions: '只使用 submit_result 返回输入中指定的值。', input: [{ role: 'user', content: '请返回 confirmed=true。' }],
    tools: [{ name: 'submit_result', description: '确认协议验证', inputSchema: Type.Object({ confirmed: Type.Boolean() }, { additionalProperties: false }), effect: 'read' }], toolChoice: 'submit_result' });
  assert.equal(JSON.parse(compatReply.calls[0]!.arguments).confirmed, true); assert.equal(upstreamCalls, 1);
  await new Promise<void>((resolve, reject) => compatibleServer!.close(error => error ? reject(error) : resolve())); compatibleServer = null;
  delete process.env.PTCG_VALIDATION_COMPAT_KEY;
  await passed('OpenAI 兼容接口真实 HTTP 与真实 Terra 推理往返', { protocol: 'chat_completions', upstream: 'same real Terra; local validation bridge', upstreamCalls });

  const events = (await readFile(trace.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  const starts = events.filter(e => e.kind === 'model_started');
  const finishes = events.filter(e => e.kind === 'model_finished');
  for (const event of starts) {
    const request = event.request as Record<string, unknown>;
    assert.equal(request.model, 'gpt-6.1-terra'); assert.equal(request.service_tier, 'default');
    assert.equal(request.reasoning_effort ?? (request.reasoning as { effort?: string })?.effort, 'medium');
    const sessionId = String(event.sessionId);
    for (const [playerId, otherSecret] of [['A', table.privateNotes.B], ['B', table.privateNotes.A]] as const) {
      const ownSession = await store.load(table.matchId, playerId);
      if (sessionId === ownSession?.sessionId || sessionId === `summary:${ownSession?.sessionId}`) {
        assert.ok(!JSON.stringify(request).includes(otherSecret)); assert.ok(!JSON.stringify(request).includes('JUDGE_ONLY_coral_7241'));
      }
    }
  }
  const roleCounts = Object.fromEntries(['player', 'judge', 'summary', 'compactor'].map(role => [role, finishes.filter(e => e.role === role).length]));
  assert.ok(roleCounts.player! >= 6 && roleCounts.judge! >= 2 && roleCounts.summary! >= 2 && roleCounts.compactor! >= 1);
  const authRaw = JSON.parse(await readFile(credentials.path, 'utf8')) as { tokens: Record<string, string> };
  for (const file of await allFiles(directory)) {
    const content = await readFile(file, 'utf8');
    for (const secret of Object.values(authRaw.tokens)) if (secret && secret.length >= 8) assert.ok(!content.includes(secret), '证据文件不得包含本地凭证');
  }
  const realInferences = finishes.filter(e => (e.response as Record<string, unknown>).status === 'completed');
  const recallContext = (await store.load('rollback-context', 'A'))!;
  const nextMatchRequest = starts.find(e => e.sessionId === recallContext.sessionId && e.role === 'player')?.request as { input: ModelItem[] };
  assert.equal(JSON.parse(String(nextMatchRequest.input[0]!.content)).initialStrategy.version, 2, '最新版策略须实际送入下一局的模型输入');
  for (const [path, hash] of Object.entries(sourceHashes)) assert.equal(createHash('sha256').update(await readFile(join(root, path))).digest('hex'), hash, '验证期间不得改变运行代码');
  const realInferenceRoleCounts = Object.fromEntries(['player', 'judge', 'summary', 'compactor'].map(role => [role, realInferences.filter(e => e.role === role).length]));
  await passed('所有真实请求模型／思考强度／服务等级、席位隔离与凭证扫描', { gatewayRequests: starts.length, completedGatewayRequests: finishes.length, realInferences: realInferences.length, gatewayRoleCounts: roleCounts, realInferenceRoleCounts, nextMatchActuallyUsedVersion: 2, credentialLeaks: 0 });
  const manifest = { schemaVersion: 1, runId, status: 'passed', completedAt: new Date().toISOString(), model: 'gpt-6.1-terra', reasoningEffort: 'medium', fast: false, serviceTier: 'default',
    node: process.version, promptVersion: prompts.version, rulesSet: 'cn-official-2026-10-27', rulesSha256: createHash('sha256').update(rules).digest('hex'),
    scriptSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), cases,
    scope: 'agent module integration; synthetic late-game fragment and targeted cases, not the complete PTCG game or UI',
    limitations: ['本地凭证当前验证文件存储；凭证只读，不代为旋转共享刷新令牌。', 'OpenAI 兼容接口通过本机 HTTP 桥连接真实 Terra 验证，未声称验证任意第三方服务。', '该结果证明所列场景的 agent 闭环，不证明穷尽卡文正确性或策略强度提升。'] };
  await atomicJson(join(directory, 'manifest.json'), manifest);
  await writeFile(join(directory, 'README.md'), `# Agent 真实验证记录\n\n运行：\`${runId}\`。结果：通过。模型：GPT-6.1 Terra，medium，default 服务（非 fast）。\n\n` +
    cases.map((c, i) => `${i + 1}. ${c.name}：通过。`).join('\n') +
    '\n\n详见 [manifest.json](./manifest.json)、[完整脱敏轨迹](./trace.jsonl)、[牌桌命令](./table-commands.json)及[裁判决定](./judge-decisions.json)。\n\n验证使用合成测试卡与独立牌桌端口，未实现或验收完整游戏。兼容接口使用本机 HTTP 桥连接真实 Terra，非独立第三方供应商验证。\n');
  console.log(`EVIDENCE ${directory}`);
} catch (error) {
  const safe = redactor.clean(error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { error: String(error) });
  await atomicJson(join(directory, 'manifest.json'), { schemaVersion: 1, runId, status: 'failed', at: new Date().toISOString(), cases, error: safe });
  console.error('VALIDATION_FAILED', safe);
  console.error(`EVIDENCE ${directory}`);
  process.exitCode = 1;
} finally {
  compatibleServer?.close();
  delete process.env.PTCG_VALIDATION_COMPAT_KEY;
}
