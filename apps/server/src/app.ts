import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadDefaultPrompts } from '../../../packages/agent/src/prompts.ts';
import type { MatchCommandInput, CreateMatchInput, DeckData, Viewer } from '../../../packages/protocol/src/index.ts';
import { ApiError } from './storage.ts';
import { GameService, type ServiceOptions } from './service.ts';

export interface AppOptions extends ServiceOptions { service?: GameService; staticDir?: string; logger?: boolean }
const body = <T>(request: FastifyRequest): T => request.body as T;
const param = (request: FastifyRequest, key = 'id'): string => (request.params as Record<string,string>)[key]!;
function query(request: FastifyRequest): Record<string,string> { return request.query as Record<string,string>; }
function viewer(request: FastifyRequest, fallback: Viewer): Viewer { const value = query(request).viewer ?? fallback; if (!['A','B','omniscient'].includes(value)) throw new ApiError('INVALID_VIEWER', '无效牌桌视角'); return value as Viewer; }
function requiredObject(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('INVALID_BODY', '请求体必须是 JSON 对象'); }
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance & { gameService: GameService }> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  const streams = new Set<ServerResponse>();
  const service = options.service ?? new GameService(options); await service.init();
  app.decorate('gameService', service);
  await app.register(cors, { origin: false, allowedHeaders: ['content-type'], methods: ['GET','POST','PUT','DELETE','OPTIONS'] });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof ApiError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500;
    const code = error instanceof ApiError ? error.code : statusCode === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR';
    void reply.code(statusCode).send({ error: { code, message: statusCode >= 500 && !(error instanceof ApiError) ? '服务内部错误；现场保存在服务端记录中' : (error as Error).message } });
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/assets/card-back.png', async (_request, reply) => {
    let image: Buffer;
    try { image = await readFile(join(service.dataDir, 'assets', 'card-back.png')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError('NOT_FOUND', '未配置卡背图片', 404); throw error; }
    return reply.type('image/png').header('Cache-Control', 'no-cache').send(image);
  });
  app.get('/api/decks', async () => ({ decks: await service.decks.list() }));
  app.post('/api/decks', async request => { requiredObject(request.body); return service.saveDeck(body<{deck:unknown}>(request).deck); });
  app.get('/api/decks/:id', request => service.decks.get(param(request)));
  app.put('/api/decks/:id', async request => { requiredObject(request.body); return service.saveDeck(body<{deck:unknown}>(request).deck, param(request)); });
  app.delete('/api/decks/:id', async request => { await service.decks.remove(param(request)); return { ok: true }; });
  app.get('/api/decks/:id/export', async request => (await service.decks.get(param(request))).deck);
  app.get('/api/opponents', async () => ({ opponents: await service.opponents.list() }));
  app.post('/api/opponents', async request => { requiredObject(request.body); return service.createOpponent(body(request)); });
  app.post('/api/opponents/import', request => service.importOpponent(request.body));
  app.get('/api/opponents/:id', request => service.opponents.get(param(request)));
  app.put('/api/opponents/:id', async request => { requiredObject(request.body); return service.updateOpponent(param(request), body<{name?:string;deck?:DeckData;strategy?:string}>(request)); });
  app.delete('/api/opponents/:id', async request => { await service.opponents.remove(param(request)); return { ok: true }; });
  app.get('/api/opponents/:id/export', request => service.opponents.get(param(request)));
  app.get('/api/settings/prompts/default', () => loadDefaultPrompts());
  app.get('/api/settings/prompts', () => service.prompts());
  app.put('/api/settings/prompts', request => service.savePrompts(request.body));
  app.get('/api/settings/model', () => service.modelConfig());
  app.put('/api/settings/model', request => service.saveModel(request.body));
  app.post('/api/settings/model/test', () => service.testModel());
  app.get('/api/rules', async () => ({ rules: service.rules }));
  app.get('/api/evaluations', async () => ({ evaluations: await service.evaluations.list() }));
  app.post('/api/evaluations', request => { requiredObject(request.body); return service.evaluations.create(request.body); });
  app.get('/api/evaluations/:id', request => service.evaluations.get(param(request)));
  app.post('/api/evaluations/:id/comparisons', request => { requiredObject(request.body); return service.evaluations.compare(param(request),request.body); });
  app.get('/api/matches', async () => ({ matches: [...service.matches.values()].map(match => match.summary()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) }));
  app.post('/api/matches', async request => { requiredObject(request.body); return service.createMatch(body<CreateMatchInput>(request)); });
  app.get('/api/matches/:id', async request => { const match = service.match(param(request)); const view = viewer(request, match.defaultViewer()); match.assertViewer(view); return match.view(view); });
  app.post('/api/matches/:id/commands', async request => {
    const match = service.match(param(request)); requiredObject(request.body);
    const { playerId, ...input } = body<MatchCommandInput>(request);
    const receipt = await match.command(match.humanPlayer(playerId), input); service.wake(match); return receipt;
  });
  app.get('/api/matches/:id/history', async request => { const match = service.match(param(request)); const view = viewer(request, match.defaultViewer()); match.assertViewer(view); const q = query(request); return match.history(view, q.after, q.limit === undefined ? undefined : Number(q.limit)); });
  app.get('/api/matches/:id/replay', async request => { const match = service.match(param(request)); const view = viewer(request, match.defaultViewer()); match.assertViewer(view, true); return match.view(view, Number(query(request).index ?? 0)); });
  app.get('/api/matches/:id/events', async (request, reply) => {
    const match = service.match(param(request)); const view = viewer(request, match.defaultViewer()); match.assertViewer(view); let cursor = query(request).after ?? '0';
    reply.hijack(); streams.add(reply.raw); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = () => {
      if (reply.raw.destroyed) return;
      const history = match.history(view, cursor); cursor = history.cursor;
      for (const entry of history.entries) reply.raw.write(`event: observation\nid: ${entry.sequence}\ndata: ${JSON.stringify(entry)}\n\n`);
      reply.raw.write(`event: change\ndata: ${JSON.stringify({ revision: match.state.revision, cursor })}\n\n`);
    };
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15_000); heartbeat.unref();
    match.changes.on('change', write); reply.raw.on('close', () => { streams.delete(reply.raw); clearInterval(heartbeat); match.changes.off('change', write); }); write();
  });
  app.post('/api/matches/:id/control', async (request, reply) => { const match = service.match(param(request)); requiredObject(request.body); const result = await service.control(match, body<{action:string}>(request).action); return reply.code(202).send(result); });
  app.post('/api/matches/:id/debug', async request => {
    const match = service.match(param(request)); requiredObject(request.body); const input = body<{kind:'restore';targetEventId:string}|{kind:'abort';reason:string}>(request);
    if (input.kind !== 'restore' && input.kind !== 'abort') throw new ApiError('INVALID_DEBUG', '无效调试操作');
    if (service.drivers.has(match.state.id)) throw new ApiError('RUNTIME_RUNNING', '请先暂停 AI 再调试', 409);
    await match.debug(input); const view = match.defaultViewer(); return match.view(view);
  });
  app.get('/api/matches/:id/export', async request => { const match = service.match(param(request)); if (match.meta.mode === 'human_ai' && match.state.flow.phase !== 'finished') throw new ApiError('HIDDEN_INFORMATION', '人机对局结束后才能导出完整记录', 403); return { schemaVersion: 1, match: match.summary(), records: match.records }; });
  const staticDir = resolve(options.staticDir ?? 'apps/web/dist');
  if (existsSync(staticDir)) { const { default: staticPlugin } = await import('@fastify/static'); await app.register(staticPlugin, { root: staticDir }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } }) : reply.sendFile('index.html')); }
  app.addHook('preClose', async () => { service.cancel(); for (const stream of streams) stream.end(); streams.clear(); });
  app.addHook('onClose', async () => service.close());
  return app as unknown as FastifyInstance & { gameService: GameService };
}
