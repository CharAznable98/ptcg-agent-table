# 新映射与卡牌字段核验

已有索引未覆盖、原记录变更或需要本地卡面补录时阅读。常规转换直接执行 skill 中的命令。

## 快照与目录

转换器先检查 `data/import-cache/duanxr/latest.json` 及对应数据文件；存在时校验散列并复用。缓存缺失或使用 `--refresh` 时，通过 GitHub 的 `commits/main` 获取最新提交；API 返回 403/429 时改用 `git ls-remote` 查询远端 HEAD。两条路径都不克隆上游仓库，之后只下载该提交的原始文件：

```text
https://raw.githubusercontent.com/duanxr/PTCG-CHS-Datasets/<commit>/ptcg_chs_infos.json
```

`<commit>` 是本次实际取得的提交 SHA。缓存位于 `data/import-cache/duanxr/<commit>/`，包含数据、来源元数据及本次用到的卡图；不克隆上游仓库，不批量下载全部图片，不提交这些缓存。网络或上游请求失败时保留明确错误，不用其他数据源或旧映射猜测结果。

`verified-mappings.json` 只保存身份与来源索引，顶层数据散列保留原核验来源。英文原始记录从 `englishReference.commit` 对应的 `cards/en/<set-id>.json` 下载，缓存到同一缓存根目录的 `english/<commit>/`，逐条检查 `reference.sha256`。使用新简中快照时逐条检查源记录和原卡图：未变更的条目可以复用；变更的条目进入待核验，不为了通过而只修改散列。所有输出 `imageUrl` 和来源记录固定到本次实际提交。

如需使用已有数据文件，传 `--dataset /path/to/ptcg_chs_infos.json`；转换器读取同目录 `source.json` 的提交与散列，或识别内置映射原始快照。其他手工文件同时传入 `--dataset-commit <commit>`，明确其真实来源。`--cache-dir` 可指定另一处本地缓存。

## 查找新卡

1. 读取输入英文系列和编号对应的真实卡牌；可以使用 Pokémon 官方卡面或 PokemonTCG/pokemon-tcg-data 的具体记录作为身份参考。核对完整名称、HP、阶段、招式、特性、费用等，不能只看物种或名称翻译。
2. 在 duanxr 中查询简中候选，进一步读取原卡图：

```sh
python3 .agents/skills/ptcg-live-to-json/scripts/convert.py search \
  --dataset /path/to/ptcg_chs_infos.json --name '奥利纽' --limit 10
```

查询输出商品、卡号、源 ID、卡图路径、记录指纹和效果字段。同一 `id`、同名甚至相同卡号都可能包含不同式样，按所选记录和卡图区分。`search` 不代表该候选已经可用于转换。

3. 只下载需要核对的卡图。将原图、散列及补录依据留在本次审计目录。无法确认版本或缺少简中牌面信息时保留待办，不能把英文说明文机翻填入输出。
4. 在本次独立 catalog 中补条目，再用 `--catalog /path/to/catalog.json` 重跑；确认可复用后才回填仓库默认目录。所有条目都解决后再交付 JSON。

目录条目的字段如下，可参考内置条目组装，不要把样例字段当成事实：

| 字段 | 内容 |
| --- | --- |
| `input` | 英文 `set`、`number`、对应真实 `name`；`aliases` 只记录已确认的导出别名，例如省略 Basic 的基本能量名 |
| `source` | 简中 `name`、商品 `set`、完整 `number`、`id`、`image` 和选定源记录的 `sha256`；需要时补已核验的基本能量 `energyType` |
| `reference` | 仅保存英文记录 `id` 和该原始 JSON 记录的 `sha256`；运行时获取并核验完整字段，不将卡牌原文嵌入仓库。集合码通过顶层 `englishReference.sets` 核对 |
| `supplements` | 只保留从简中卡图确认的 `evolvesFrom` 身份关系，不放规则框原文 |
| `requiredSupplements` | 需要 `rulesText` 或 `prependRulesText` 时仅保存其 UTF-8 文本散列；原文放在本地缓存 |
| `reviewed` / `evidence` | 真正完成核验后才设 `reviewed: true`；记录固定提交的上游数据 URL、原卡图 URL 及图像散列，不填写本机验收路径 |

源记录指纹按如下形式计算；查询工具已输出同一算法的结果：

```python
hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':')).encode()).hexdigest()
```

## 源字段的非直觉含义

| duanxr 字段 | 本项目字段与注意事项 |
| --- | --- |
| `abilityItemList` | 招式 `attacks`，不是特性；费用查 `dict.ability_cost` 并计数，伤害保留字符串；无印刷伤害数字不改成 0 |
| `cardFeatureItemList` | 特性 `abilities`；名称与完整说明均保留 |
| `evolveText` | 进化阶段；数据中没有显式进化来源时，`evolvesFrom` 必须从所选简中卡图补录，不能从名字或英文卡补规则 |
| `ruleText` / `specialCard` | 完整说明文及机制标签；`ruleText` 可能漏掉太晶、ACE SPEC 等独立说明框，需结合原图核对 |
| `weakness*` / `resistance*` / `retreatCost` | 弱点、抗性与印刷撤退费用；缺抗性与抗性 -30 不能混用；撤退为 0 也必须保留 |

字面字符串 `none` 是源占位值，转为空文本；`|` 为源数据的框分隔符，输出空行。确认是零能量招式后才接受空费用数组。动态费用代码 `12`（`+`）等当前无法直接表示的情况会阻止转换，需要核对卡面并扩展表示，不能输出虚构能量类型。

基本/特殊能量保持分支。特殊能量只记录完整说明文，不把条件性供能提前折算成无条件属性/数量。规则框原文放 `rulesText`，机制标识放 `tags`；不在名称里混入来源编号、罕贵度或投入张数。

用户指定的卡图式样优先；未指定时可以选已证实效果相同的简中印刷，记录对应关系。国际编号与简中编号不是同一体系，不声称是同一印刷；同名重印兼容、勘误和目标日期合法性另外按本地规则依据核对。

## 输出与验证边界

### 本地卡图补录

首次使用缺少规则框原文的索引条目时，转换器仍会取得并校验卡图，然后在 `pending.json` 给出 `cardImage`、`sourceSha256`、`imageSha256`、`requiredSupplements` 和 `supplementsFile`。读取实际原图后，将核对的原文合并到该本地文件，保留已有条目：

```json
{
  "cards": {
    "<pending.sourceSha256>": {
      "imageSha256": "<pending.imageSha256>",
      "fields": {
        "rulesText": "<从该卡图逐字核对的规则框文本>"
      }
    }
  }
}
```

`fields` 只填写该条目要求的 `rulesText`／`prependRulesText`，包括原文的空格与换行；转换器同时检查原图与文本散列。散列不符时先核对具体卡图和逐字内容，不能为通过而改写索引。确需修订索引时应留存新的实际核验证据。该文件位于被忽略的缓存中，卡文不回填到仓库。

实际结构以 `packages/protocol/src/cards.ts` 为准。输出只能含现有协议允许的字段，来源元数据保存在 `conversion.json`，不要往卡组 JSON 加私有 UUID、卡池或自造元数据字段。

技能、映射和离线测试均不读取本机验收目录。原图优先从本地缓存读取，缺失时从 GitHub 下载并检查核验散列。审计记录写入上游 URL 与散列；独立交付审计包时，可从缓存复制本次使用的原图，不把完整上游数据或代码复制进本仓库。

`convert.py` 会保留每条输入的数量、顺序和完整牌面字段，执行所指定英文卡的结构数值交叉核对。说明文语义仍需原卡图核验，不能把数值相同当成效果相同。

`verify.ts` 使用当前前端解析器、后端 Schema 和隔离 API 验证，之后才可选做明确要求的正式导入。非 60 张规格在两个脚本中保持相同 `--expected-total`。这是格式及导入链路验证，不代表完整 AI 实战或赛事合法性认证。脚本遇到未支持的源字段时先完善转换并补对应验证，不用默认值掩盖缺失。

维护脚本或目录后，可从仓库根目录运行以下离线检查；Python 测试使用完全合成的数据与模拟下载，HTTP 测试仅使用非官方合成练习卡组及临时服务，不访问正式资料库：

```sh
python3 .agents/skills/ptcg-live-to-json/scripts/test_convert.py
node --test .agents/skills/ptcg-live-to-json/scripts/verify.test.ts
```
