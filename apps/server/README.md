# PTCG 后端

`node apps/server/src/index.ts` 启动 Fastify，默认 `127.0.0.1:3001`。配置 `PORT`、`HOST`、`PTCG_DATA_DIR`、`PTCG_SYSTEM_DIR`；数据目录只能由单一服务进程写入。

`buildApp({dataDir,systemDir,rulesDir,modelFactory})` 可注入到集成测试，默认从根目录 `rules/` 读取规则。HTTP 路由见 [app.ts](./src/app.ts)，请求与响应类型见[共享协议](../../packages/protocol/src/index.ts)。对局无需访问凭证；HTTP 命令通过 `playerId` 指定人类席位，AI 席位只由服务内部操作。

单局 `journal.jsonl` 每条同步落盘，包含原始请求、执行者、原始反馈、完整状态与当时三个视角的观察。尾部撕裂保留原件后截断，中段损坏拒绝恢复。每次重启恢复为暂停；玩家上下文独立保存在 `contexts/`，牌桌回滚时继续保留。`agent-trace.jsonl` 保存去凭证的模型调用轨迹。

提示词配置 `system/prompts.json` 在建局时冻结；模型引用配置 `system/agent.json`，缺省读取 `system/agent.example.json`。模型连接器从本地凭证文件或环境变量读取认证值。`run`、`resume`、`step` 返回 202 后后台推理，`pause` 取消新操作。人类阶段等待玩家提交操作。裁判在异议被辩护时运行，正常结果由对手确认，结束后各 AI 以自身观察生成并保存新策略版本。

`node --test apps/server/test/*.test.ts` 执行服务端测试，模型端口通过依赖注入提供。

## 手动评估接口

- `POST /api/evaluations`：选择双方 `{opponentId, version}` 与 `evaluatedPlayer`，运行版本 A 并保存开始前场景。
- `GET /api/evaluations`、`GET /api/evaluations/:id`：只读状态和结果。
- `POST /api/evaluations/:id/comparisons`：仅传 `{version}`，手动复用起点运行被评估席位的版本 B。

参评策略须有适配当前卡组、规则的完整计划。评估跳过赛后写回；普通对局学习保留。随机状态只保存在服务端日志，不进入玩家观察。
