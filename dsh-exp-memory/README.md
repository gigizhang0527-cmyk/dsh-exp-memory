# dsh-exp-memory

> 给 DeepSeek Harness（DSH）的**经验沉淀插件**：把跨会话经验存在纯 markdown 里，只把**实时生成的索引**注入提示词；**回合末自动提醒**当前 Agent 沉淀本回合经验（走独立收尾回合）；**写入守卫**把关格式、凭据红线与防覆盖。零额外 LLM 后台成本，可 git、可手改、可离线迁移。
>
> 配套作业规范 skill：`exp-sedimentation`（记什么 / 何时记 / 怎么记），可独立分发给任意 Agent。

## 它解决什么

每个会话窗口都是独立失忆的。经验要跨窗口沉淀，需要同时解决四件事：

| 环节 | 本插件的做法 |
| --- | --- |
| 沉淀触发 | **回合末自动提醒**（`turn/end` 门控 → `agent.followup()` 独立收尾回合，可配置 every / cooldown / minTools） |
| 存储组织 | `~/.dsh/exp-memory/`：`topics/exp-<领域>.md` 全局分片 + `projects/<slug>/MEMORY.md` 项目层 |
| 跨窗口召回 | 只注入**索引**（片名 · 条数 · 最新日期 · 关键词 + 条目行号），正文按行号 `read`；预算阶梯收缩**绝不整层归零** |
| 质量守卫 | `tools/pre-execute` 规则引擎：条目格式 / 日期合法性 / 八类凭据扫描 / 整文件覆写防删史 / bash 改写转人工 |

## 记忆文件布局

```
~/.dsh/exp-memory/                 # 默认根目录，config.memoryDir 可改（可指向 ~/.dsh/memory 接管现有库）
  topics/exp-<domain>.md           # 全局分片：首行 <!-- 片名 · 关键词… -->，条目 - [YYYY-MM-DD] **短标题** —— 结论
  projects/<slug>/MEMORY.md        # 项目层：slug 与 ~/.dsh/sessions 目录名一致（Windows 中文路径 ~XXXX 转义）
  settings.json                    # 运行开关（改完即生效）
  audit.log                        # 写入审计 JSONL（>2MB 轮转 .1）
```

## 安装

**桌面端 Electron（desktop profile）**：设置 → 插件 → 安装本地/市场包（桌面端运行期由应用插件管理器管理，命令行硬装可能报 already-installed）。

**CLI（web profile）**：

```bash
dsh plugin --profile web add dsh-exp-memory     # npm 发布后
# 或源码 link：把本目录路径写进 profile 的 package.json 依赖 "dsh-exp-memory": "link:../../dsh-exp-memory"
# 再在 profile 的 cordis.patch.yml 末尾追加：
#   - insert: [{ id: exp-memory, name: 'dsh-exp-memory', config: {} }]
# 然后 pnpm install 并重启 dsh web
```

装完重启后验证：① 新会话系统提示里出现「全局记忆 · 索引模式：N 片 / M 条」；② `GET /exp-memory/diagnostics` 返回 seams 统计；③ `node tests/probe.mjs` 66 项全绿。

## 配置（`config` 写在 cordis.patch.yml；或 `POST /exp-memory/settings {patch}`，头 `x-exp-memory: 1`）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `memoryDir` | `~/.dsh/exp-memory` | 记忆根目录（可指向 `~/.dsh/memory` 接管现有库） |
| `injectMode` | `index` | `index` 索引注入 / `full` 全文（超限自动回退索引） |
| `indexBudget` | `12000` | 索引字符预算（0 = 不限制全量逐条） |
| `maxChars` | `24000` | 正文上限（full 模式闸门 / 项目层 clamp） |
| `discipline` | `true` | 注入末尾附加记忆纪律块 |
| `autoDistill` | `true` | 回合末自动提醒沉淀 |
| `every` | `1` | 每 N 个有效工作回合最多提醒一次 |
| `cooldownMin` | `0` | 两次提醒最短间隔（分钟） |
| `minTools` | `1` | 触发回合所需最少工具调用数 |
| `reminderPrompt` | 内置中文 | 自定义提醒词（`<MEM>` 会被替换为记忆根路径） |
| `skipSubagents` | `true` | 跳过子代理回合 |
| `writeGuard` | `rules` | `rules` 规则引擎 / `off` 关闭 |
| `audit` | `true` | 写入审计 audit.log |

## 工作原理（依赖的 DSH seam）

- `ctx.systemPrompt.section({ text })` —— 函数式文本，每次组装现读文件，写完即生效；
- `ctx.on("tools/pre-execute")` —— 写入守卫，deny/ask 决策直接回到模型面前；钩子故障放行不误伤；
- `ctx.on("tools/post-execute")` —— 写入审计 + read 命中记忆文件附读取提醒（按行号引用、禁臆测）；
- `ctx.on("session/event")` + `agent/created` —— 回合状态机（`turn/start` / `tool/call` / `turn/end`），提醒走 `agent.followup()` **独立收尾回合**（同回合 steer 会折叠原任务答案，实测教训）；无该 API 时降级 `agent.inject()`；
- `wctx.webServer.register({ kind: "prefix", path: "/exp-memory" })` —— 内容核对与设置路由。

兼容 `>=0.1.7-rc.1`：`sessionProjections` / `agent.followup` 缺失时逐级降级，不抛错。**不往会话日志写自定义事件**（会导致会话无法重开），状态只落自己的目录。Windows 路径从第一行就安全（反斜杠归一化、大小写不敏感比较、HOME→USERPROFILE 兜底、slug `~XXXX` 转义与 `~/.dsh/sessions` 对齐）。

## 验证

```bash
node tests/probe.mjs    # 66 项断言，全部在系统临时目录跑，不碰真实数据
```

覆盖：slug 推导（含中文 Windows 路径）、条目解析、日期规则、凭据扫描（只报模式名不回显值）、索引预算阶梯（每片保底线索）、`{{` 转义、原子写、项目层目录/单文件两形态、守卫八条规则、提醒门控全分支、收尾回合不递归、假 ctx 装配回放（注入文本 + 钩子行为）。

## 从现有记忆库迁移

现有 `~/.dsh/memory/topics/*.md` 直接拷进 `<MEM>/topics/` 即可（条目格式一致）；或把 `memoryDir` 配成 `~/.dsh/memory` 让本插件接管现有库（**两个记忆插件不要同时注入**，会重复）。slug 规则与 `@jipika/dsh-memory` 的 Windows 补丁版一致，项目层目录可原样复用。

## 发布清单（上架前）

- [ ] `npm publish`（包名唯一性自查）；`files` 已含 locale/icon/cordis.patch.yml
- [ ] 1024Store：往目录仓库（imsai-sh/dsh-1024store）按指引提交条目，静态审查后自动上架
- [ ] dshbase：提 PR 进目录（ylwl1997/dshbase），CI 干净 profile 实测 `dsh plugin add` 得「实测可装」徽章
- [ ] README 双语段落、截图（设置面板 v0.2 后补）
- [ ] 已知未做：设置 UI 面板（v0.2）、BM25/向量召回（刻意不做，索引+行号够用）

## License

MIT
