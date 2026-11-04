# PTCG 后端

`node apps/server/src/index.ts` 启动 Fastify，默认 `127.0.0.1:3001`。配置 `PORT`、`HOST`、`PTCG_DATA_DIR`、`PTCG_SYSTEM_DIR`；数据目录只能由单一服务进程写入。

`buildApp({dataDir,systemDir,rulesDir,modelFactory})` 可注入到集成测试，默认从根目录 `rules/` 读取规则。HTTP 路由见 [app.ts](./src/app.ts)，请求与响应类型见[共享协议](../../packages/protocol/src/index.ts)。对局无需访问凭证；HTTP 命令通过 `playerId` 指定人类席位，AI 席位只由服务内部操作。

单局 `journal.jsonl` 每条同步落盘，包含原始请求、执行者、原始反馈、完整状态与当时三个视角的观察。尾部撕裂保留原件后截断，中段损坏拒绝恢复。AI 运行在重启后恢复为暂停；玩家上下文独立保存在 `contexts/`，牌桌回滚时继续保留。`agent-trace.jsonl` 保存去凭证的模型调用轨迹。

提示词配置 `system/prompts.json` 在建局时冻结；模型引用配置 `system/agent.json`，缺省读取 `system/agent.example.json`。模型连接器从本地凭证文件或环境变量读取认证值。`run`、`resume`、`step` 返回 202 后后台推理，`pause` 取消新操作。人类阶段等待玩家提交操作。裁判在异议被辩护时运行，正常结果由对手确认，结束后各 AI 以自身观察生成并保存新策略版本。

`node --test apps/server/test/*.test.ts` 执行服务端测试，模型端口通过依赖注入提供。

## 人类执行接口

- `POST /api/matches/:id/actions/activate`：以 `{playerId}` 激活实时牌桌的强制回合开始处理，幂等返回该席位的 `HumanActionView | null`，状态码 202。
- `POST /api/matches/:id/actions`：提交席位、请求 ID、牌桌版本及明确的操牌意图，返回 202 后后台执行。
- `GET /api/matches/:id/actions/current?playerId=A`：读取本席位行动进度及待完成的人类选择。
- `POST /api/matches/:id/actions/:actionId/choice`：提交选择 ID 与选项、数量或顺序；同请求幂等。
- `POST /api/matches/:id/actions/:actionId/control`：`retry`、`repair`、`cancel` 分别继续修正、复核和停止；`manual` 显式进入手动修正。已成功步骤保留，`requiresResolution` 为真时须先完成结算或回滚，再提交新行动。

`HumanActionController` 独立于 AI 对手决策循环。每局每个人类席位保存独立的行动上下文、待定请求和写锁，临时交权按席位往返。选择牌面从本席位实际观察和授权查看结果投影。新事件的 `action` 标识供前端聚合，原子命令与恢复点保留。

`set_state` 可用 `field: {key: "slotCount", value: 8}` 调整槽位区域的物理长度（0–1000）。扩容补空槽；缩容前尾部须为空，否则拒绝且不改变牌桌。选牌、移出卡牌组及结算顺序由调用方决定；该命令不自动弃牌或判断卡文。

每次新的人类行动使用当前人类代理配置，按内容散列保存到 `human-action-config-<hash>.json`；已有行动沿用各自保存的配置，旧配置文件和本局 AI 提示词保持原版本。行动状态在 `human-actions/` 中持久保存；重启后运行中的动作等待显式继续，已请求的人类选择继续保留。`human-agent-trace.jsonl` 留存脱敏的真实模型请求与反馈。

进入人类回合后自动处理开局抽牌和开始时点，遇到游戏抉择再请求玩家。没有需解释效果的固定顶抽由系统执行，其他情况交执行代理处理；恢复后按有效历史判断是否已抽牌。`execute_sequence` 将已确定的机械步骤合并为一次模型请求，后端仍逐条校验、保存和反馈；查看、随机、洗牌或临时交权后停止后续步骤，避免使用过时位置或未知结果。

服务启动只恢复并监听旧对局，不主动推进闲置对局。全部 GET 接口保持只读；前端打开实时人类牌桌时发送一次 `actions/activate`，新局的真实回合变化继续自动处理。服务重启时中断的行动仍需显式 `retry`，激活不会替换或暗中继续该行动。

`node scripts/validate-human-actions.ts` 使用配置的真实模型连接验证合成操牌、选择、纠错、交权与检查场景；运行原件和散列写入新的本地 `artifacts/` 目录。

## 手动评估接口

- `POST /api/evaluations`：选择双方 `{opponentId, version}` 与 `evaluatedPlayer`，运行版本 A 并保存开始前场景。
- `GET /api/evaluations`、`GET /api/evaluations/:id`：只读状态和结果。
- `POST /api/evaluations/:id/comparisons`：仅传 `{version}`，手动复用起点运行被评估席位的版本 B。

参评策略须有适配当前卡组、规则的完整计划。评估跳过赛后写回；普通对局学习保留。随机状态只保存在服务端日志，不进入玩家观察。
