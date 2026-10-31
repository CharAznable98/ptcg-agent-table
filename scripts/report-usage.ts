import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { UsageAccumulator } from '../packages/agent/src/usage.ts';

const args = process.argv.slice(2), target = args[0];
if (!target || target.startsWith('--')) throw new Error('用法：npm run report:usage -- <matchId、对局目录或轨迹JSONL> [--output 输出目录]');
let trace = resolve(target);
try { const info = await stat(trace); if (info.isDirectory()) { try { await stat(join(trace, 'agent-trace.jsonl')); trace = join(trace, 'agent-trace.jsonl'); } catch { trace = join(trace, 'original/agent-trace.jsonl'); } } }
catch { trace = resolve('data/matches', target, 'agent-trace.jsonl'); }
const index = args.indexOf('--output');
if (index >= 0 && !args[index + 1]) throw new Error('--output 需要目录');
const output = resolve(index < 0 ? join('artifacts/token-usage', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')) : args[index + 1]!);
const accumulator = new UsageAccumulator(); let malformedLines = 0;
for await (const line of createInterface({ input: createReadStream(trace), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  try { accumulator.add(JSON.parse(line)); } catch { malformedLines++; }
}
const report = { generatedAt: new Date().toISOString(), source: trace, malformedLines, ...accumulator.report() };
const number = (value: number | null) => value === null ? '未知' : value.toLocaleString('en-US');
const percent = (value: number | null) => value === null ? '未知' : (value * 100).toFixed(2) + '%';
const labels: Record<string, string> = { player: '玩家', compactor: '压缩', summary: '赛后复盘', judge: '裁判' };
const row = (label: string, value: ReturnType<UsageAccumulator['report']>['totals']) => `| ${label} | ${value.attempts} | ${number(value.inputTokens)} | ${number(value.outputTokens)} | ${number(value.cachedInputTokens)} | ${number(value.uncachedInputTokens)} | ${percent(value.cacheTokenHitRate)} | ${value.cacheHitRequests}/${value.cacheUsageRequests} |`;
const markdown = [
  '# 模型 Token 用量', '', `来源：${trace}`, '',
  '| 角色 | 请求尝试 | 输入（含缓存） | 输出 | 缓存输入 | 未缓存输入 | 输入缓存命中率 | 命中请求／缓存已报告请求 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(report.byRole).map(([role, total]) => row(labels[role] ?? role, total)), row('合计', report.totals), '',
  '按席位合计，包含该席位的压缩与复盘：', '',
  '| 席位 | 请求尝试 | 输入（含缓存） | 输出 | 缓存输入 | 未缓存输入 | 输入缓存命中率 | 命中请求／缓存已报告请求 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(report.byPlayer).map(([player, total]) => row(player === 'unassigned' ? '未绑定席位' : player, total)), '',
  '缓存写入单列统计（属于输入，不能额外相加）：', '',
  '| 角色 | 缓存写入 token | 普通输入（扣除缓存读取和写入） | 写入字段已报告请求 |',
  '|---|---:|---:|---:|',
  ...[...Object.entries(report.byRole), ['合计', report.totals] as const].map(([role, total]) => `| ${labels[role] ?? role} | ${number(total.cacheWriteInputTokens)} | ${number(total.ordinaryInputTokens)} | ${total.coverage.cacheWrite.reported}/${total.attempts} |`), '',
  `完成 ${report.totals.completed}，失败 ${report.totals.failed}，待完成 ${report.totals.pending}。`,
  `输入 usage 已报告 ${report.totals.coverage.input.reported}/${report.totals.attempts}；输出 ${report.totals.coverage.output.reported}/${report.totals.attempts}；缓存 ${report.totals.coverage.cached.reported}/${report.totals.attempts}。`, '',
  '缓存读取和缓存写入均属于输入，推理 token 属于输出，均不额外相加。未缓存输入包含写入，普通输入只对输入、缓存读取和写入三项完整的请求计算。所有 token 数来自服务端 usage；不根据字节数估算。缺失字段不当作零，表中合计仅含已报告部分。缓存命中率只以同时报告输入和缓存的请求计算，未缓存输入也只统计这些请求。HTTP重试按attempt分开，流式与最终返回的同一次usage只计一次。usage字段不代表当前凭证的实际账单。', '',
  `记录解析失败行数 ${malformedLines}；统计异常 ${report.issues.length}。每请求、每玩家及字段覆盖率详见 usage.json。`, '',
].join('\n');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'usage.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(join(output, '用量统计.md'), markdown);
console.log(markdown); console.log('REPORT ' + output);
