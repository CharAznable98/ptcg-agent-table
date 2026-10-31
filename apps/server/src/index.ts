import { pathToFileURL } from 'node:url';
import { buildApp } from './app.ts';
export { buildApp } from './app.ts';
export { GameService } from './service.ts';
export { MatchRuntime } from './match.ts';

export async function startServer(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const app = await buildApp({ logger: true, ...(process.env.PTCG_DATA_DIR ? { dataDir: process.env.PTCG_DATA_DIR } : {}), ...(process.env.PTCG_SYSTEM_DIR ? { systemDir: process.env.PTCG_SYSTEM_DIR } : {}) });
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? '127.0.0.1' });
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startServer();
