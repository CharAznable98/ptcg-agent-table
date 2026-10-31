/** 独立浏览器故障验收入口：不接触正式验收对局，只让每席首次总结失败。 */
import { resolve } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { createModel } from '../packages/agent/src/index.ts';

if (process.env.PTCG_ENABLE_FAULT_VERIFICATION !== '1') throw new Error('仅限显式启用的浏览器故障验收');
const injected = new Set<string>();
const app = await buildApp({
  dataDir: resolve('data/browser-summary-retry'),
  systemDir: resolve('data/browser-summary-retry/system'),
  modelFactory(config, trace) {
    const upstream = createModel(config, trace, trace.redactor);
    return { async generate(request) {
      if (request.role === 'summary' && !injected.has(request.sessionId)) {
        injected.add(request.sessionId);
        await trace.append({ kind: 'verification_fault_injected', role: request.role, sessionId: request.sessionId, reason: '首次总结故障，用于验证网页重试入口' });
        throw new Error('验收注入：首次总结临时失败；可点击重试策略总结');
      }
      return upstream.generate(request);
    } };
  },
});
await app.listen({ host: '127.0.0.1', port: 3002 });
console.log('独立总结重试验收：http://127.0.0.1:3002；数据目录 data/browser-summary-retry');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
