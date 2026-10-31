import { mkdir, writeFile } from 'node:fs/promises';
import { loadPrompts } from '../packages/agent/src/prompts.ts';

const config = await loadPrompts();
const roles = [
  ['player', '玩家对战', '持有操作权或收到准备／异议回应／结果确认请求时，每次决定下一个工具；waiting、finished 不调用。', '创建席位时正文与本地规则拼入 instructions。input 包含 playerId、本人完整卡组、开局策略，以及当前可读快照、增量观察、已有摘要和消息／工具反馈。一次恰好一个工具；实际可用工具由当前阶段限定。'],
  ['judge', '独立裁判', '具体异议经一次辩护进入裁判阶段，宿主显式调用 judge；没有主动检查或定时审查。', '正文与本局冻结规则拼入 instructions。独立 input 为 JudgeCase：facts、证据标识、规则标识、有效恢复锚点和区域范围；当前 rules 字段也出现在 input 中。强制 submit_result，输出 verdict、explanation、evidenceRefs、ruleRefs、steps。完整 explanation 内部留档，玩家只读经投影的裁决。'],
  ['summary', '赛后长期策略总结', '宿主在正式结束后调用 summarize；要求该席位无 pending 工具。生成候选后，宿主按最新版策略进行版本检查和发布。', '独立 input 为 matchId、playerId、latestStrategy、ownDeck、该席位 observations、toolHistory 和最终可读 snapshot（字段名 result）。强制 submit_result，输出完整 strategy、changeSummary、evidenceRefs；不自动增加对手隐藏信息或私有策略。'],
  ['compactor', '局内上下文压缩', '玩家下一次推理前，动态消息超过默认 80,000 UTF-8 字节；也可显式调用 compact。有 pending 时不压缩，回滚本身不触发压缩。', '独立 input 为 previousSummary、该席位累计 observations、toolHistory、maxSummaryBytes。当前不直接传入全部 messages、当前 snapshot 或开局策略。强制 submit_result，输出 text、evidenceRefs；默认整个摘要对象不超过 12,000 UTF-8 字节。保留最近两轮消息和完整原观察／工具轨迹，不更新长期策略。'],
] as const;
const blocks = roles.map(([key, title, when, input]) => `## ${title}（${key}）\n\n**使用时机：**${when}\n\n**完整正文：**\n\n\`\`\`text\n${config[key].trimEnd()}\n\`\`\`\n\n**实际输入与输出：**${input}\n`);
const tools = Object.entries(config.toolDescriptions).map(([name, description]) => `### \`${name}\`\n\n${description}\n`).join('\n');
const document = `# Prompt 审核清单\n\n更新日期：2026-10-29。由 \`npm run docs:prompts\` 根据当前配置生成。版本：\`${config.version}\`。\n\n实际配置是 [system/prompts.json](../../system/prompts.json)，默认副本是 [system/prompts.example.json](../../system/prompts.example.json)。包含 **4 套角色正文、${Object.keys(config.toolDescriptions).length} 条工具说明、${Object.keys(config.feedback).length} 条反馈／请求文本**。本次配置化保留四份角色正文原文。\n\n每局由宿主保存完整配置快照，创建该局独立 AgentRuntime；恢复该局也使用同一快照。更新文件只影响之后创建的对局。Responses 使用 instructions；兼容 Chat Completions 使用首条 system 消息。不加载 Codex 运行时或其内置提示词。\n\n${blocks.join('\n')}\n## 工具说明（也会发送给模型）\n\n玩家工具名及参数 Schema 来自共享结构化命令；后端按阶段筛选。下列说明均可配置，只有当前可用工具才发送。裁判／总结／压缩只收到 submit_result 及各自 Schema。Schema 是程序约束，修改自然语言不会扩大权限。\n\n${tools}\n## 反馈与连接测试文本\n\n以下为完整配置原文。playerToolCountInvalid 在多个工具调用时反馈；playerToolRequired 在零工具调用时反馈；invalidArgumentsJson、toolUnavailable 用于参数／阶段错误；structuredToolRequired 用于三类专用任务未恰好调用一次 submit_result。两个 Heading 用于拼接规则正文；modelTest 两项只用于设置页连接测试。\n\n\`\`\`json\n${JSON.stringify(config.feedback, null, 2)}\n\`\`\`\n\nAjv 参数错误、JSON 解析错误和游戏端执行收据属于动态反馈，按实际错误返回，不是额外静态角色模板。默认专用结构化任务最多尝试 3 次；玩家连续 3 次失败会中止运行并留记录，不判胜负。\n\n## 动态资料与历史验证边界\n\n规则正文来自本局冻结的本地记录，卡文来自所用 JSON 卡组；牌桌、历史观察、随机结果、策略版本和工具反馈来自实际运行。它们与固定 prompt 分开保存。双方不自由聊天，裁判论证不会直接放进玩家输入。\n\n旧 [Markdown 模板目录](../../packages/agent/prompts/) 与 [原 Agent 模块验证报告](../verification/2026-10-29-Agent模块实际验证.md) 保留对应当时的源码和轨迹，不作为当前 JSON 配置已通过完整游戏验收的证明。原验证脚本的连接探针、晚局 task、record_seen 工具及单元测试占位文本只在测试中使用；见 [validate-agent.ts](../../scripts/validate-agent.ts) 与 [table-fixture.ts](../../packages/agent/test/table-fixture.ts)，不会自动注入正式对局。\n`;
const output = new URL('../docs/architecture/Prompt审核清单.md', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, document);
console.log(`Prompt 审核清单已更新：${config.version}`);
