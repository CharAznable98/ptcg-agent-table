# 游戏内核

`src/index.ts` 导出 `createGame`、`executeCore`、`projectTable`、`resolveSelection`、`findCardPosition`、`CoreError` 及共享协议类型。内核执行结构化原子操作，卡牌效果和对局流程由调用方通过命令表达。

## 提交与权限

`executeCore` 不修改输入对象；`changed=true` 时新版本为输入版本加一，否则版本不变。版本匹配、请求幂等、持久化、历史观察与实际提交由后端负责。失败抛出带 `code` 的 `CoreError`，不会部分提交。

玩家普通命令必须持有操作权。结果确认只允许被请求的席位；未结束时任意玩家可认输。`choose_first`、初始摆放、补抽、追加备战、`object`、`respond` 通过后端运行服务执行。

私有 `system_progress` 更新强类型 `flow`／`setup`；`system_restore` 恢复本局完整状态，并保持版本递增，两者供服务内部调用。系统 `setup`、`disposition`、`debug` 用途分别限制可执行的命令；裁判 `disposition` 通过 `confirm_result` 确认当前有效的既有报告。

## 操作语义

1. 移动先定位双方容器，再按移出后的长度校验目标下标。指定下标集合按源顺序执行；批量仅接受同源单卡。批量放入槽位从目标下标连续占位，任一占位冲突则整批拒绝。跨区域清除单卡可见范围覆盖，其他状态保留。
2. 洗牌使用注入的 `Entropy` 进行 Fisher–Yates，仅改变选中位置；不返回排列。区域序列从顶到底；组 `stack` 从底到顶。空组必须显式创建与移除。
3. 投币结果为 `{mode:'coins'|'until_tails',coins:('heads'|'tails')[]}`。固定数量默认一枚；连续模式至首次反面，最多1000次，未达到时整次抛 `RANDOM_LIMIT_EXCEEDED`。随机选择默认一个位置，无放回，结果为 `{mode:'selection',positions:Position[]}`。
4. 查看／展示的 `result` 只有 `{count}`，实际牌面只在 `reveals` 中；查看仅发给调用席位，展示发给双方。信息提供会增加版本，持续可见范围不变。合法空选择为 `changed=false`，不产生随机或牌面信息。
5. 设置区域状态仅允许非空 `visibility`，用于修改默认范围；其他状态字段有明确目标类型。回合、检查、临时操作权、结果均显式执行，恢复包括这些流程字段。

## 投影与随机

玩家视图使用位置，不包含卡牌／资料／组 UUID。隐藏对象不提供牌面、原归属、标记或全隐藏组形态；所有成员均隐藏的组折叠为一个隐藏占位。卡牌部分可读的组保留可见成员及其余成员的隐藏位置。准备选择的敏感资料仅提供给请求席位。仅本人初始完整卡组作为 `ownDeck` 返回，内部 `setup` 不返回。

默认随机源为 Node.js `crypto.randomInt`／`randomUUID`；服务端可注入熵用于记录和测试，注入方负责随机公平性与隐藏排列的访问隔离。历史日志与回放复用已提交的随机结果。

## 验证

运行 `node --test packages/game-core/test/*.test.ts`，检查原子操作、流程、严格选择、不可变输入、批量原子性、槽位、组状态、随机记录、权限投影及恢复。
