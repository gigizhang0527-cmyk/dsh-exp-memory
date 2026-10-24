# 自动化组件：插件 dsh-exp-memory 的安装、配置与降级方案

> 本 skill（exp-sedimentation）是**作业规范**，任何 agent 拿到就能照做；
> 插件 `dsh-exp-memory` 是**自动化组件**，把规范里的召回、提醒、守卫变成机制。两者分工见 §3。

## 1. 插件提供什么

| 能力 | 说明 | 对应规范 |
| --- | --- | --- |
| 索引注入 | 每轮把记忆库**索引**（片级行 + 条目标题与行号）注入提示词，超预算按每片最新 N 条阶梯收缩，绝不整层归零 | [pipeline.md](pipeline.md) ① 开工先查 |
| 回合末 followup 提醒 | worked turn 结束后发独立收尾回合，提醒“回顾本回合 → 提炼条目 → 落盘 → 回报”，带冷却与频次门控 | [pipeline.md](pipeline.md) ② 收工沉淀 |
| 写入守卫 | 写记忆文件前拦截：格式非法、日期非法/未来、疑似凭据（八类）、覆写使既有条目变少 → deny；bash 重定向改记忆文件 → ask | [discipline.md](discipline.md) §3 红线 |
| 审计 | 写入落盘后记 audit.log（JSONL，超 2MB 轮转 .1）；read 记忆文件时附读取提醒（条目数/字符数、按行号引用） | [data-model.md](data-model.md) |

## 2. 安装（两条路）

### 路 A · 桌面端（Electron，desktop profile）

1. 打开 DSH 桌面端 → **设置 → 插件**。
2. 安装 `dsh-exp-memory`（插件市场搜索，或从本地包安装）。
3. 安装完成后**重启 DSH**（插件重装后必须重启才生效）。
4. 验证：新会话开头提示词里出现经验库索引（片级行），说明注入已生效。

> 说明：桌面端按设置里的插件入口安装；桌面端与 CLI 的插件清单不互通，两边用要各装一次。

### 路 B · CLI（`dsh web`，web profile）

```powershell
dsh plugin --profile web add <包名或包路径>
```

- 装完同样重启对应进程再验证。
- 插件清单与状态用 `dsh plugin --profile web` 子命令查看（列表/升级/移除都带 `--profile`）。
- 升级后如果项目层注入失效，重跑经验库工具的 `patch` 并重启（见本机 `~/.dsh/AGENTS.md` 维护约定）。

### 配置项（config 或 HTTP settings 合并覆盖）

`enabled` / `memoryDir` / `injectMode`（full|index）/ `indexBudget` / `maxChars` / `discipline` /
`autoDistill` / `every` / `cooldownMin` / `minTools` / `reminderPrompt` / `skipSubagents` / `writeGuard` / `audit`

- 改动即时生效（settings.json 由插件自持）。
- 无 followup API 的宿主自动降级 `inject()`；无 sessionProjections 的宿主降级事件扫描，只计数不重扫日志。

## 3. 插件与 skill 的分工

| | 插件 dsh-exp-memory | skill exp-sedimentation |
| --- | --- | --- |
| 管什么 | **召回与守卫**：把索引送进上下文、回合末催沉淀、写入前拦红线、写入后审计 | **触发与内容标准**：何时记、记什么、不记什么、条目怎么写、怎么查重拆片 |
| 依赖 | 需要宿主（DSH）与安装 | 纯文本规范，任何 agent 可执行 |
| 失效后果 | 索引不注入、提醒不触发（内容仍可手写） | 没有内容标准，容易记成流水账/踩红线 |

一句话：**插件管“机制”，skill 管“标准”**；插件的守卫规则本身就是 skill 纪律的机器化版本。

## 4. 无插件的纯规格降级方案

没有 DSH / 不方便装插件时，skill 照样可用：

1. 把 [discipline.md](discipline.md) 的全文（或 §1~§7 精简版）放进目标 agent 的 `AGENTS.md` / 系统提示。
2. 在系统提示里固定两条硬规则：
   - 开工先读记忆库索引并按行号读正文（[pipeline.md](pipeline.md) ①）；
   - 收工当轮必须沉淀并在末尾回报“本轮沉淀 N 条”（[pipeline.md](pipeline.md) ② + [discipline.md](discipline.md) §7）。
3. 记忆库用 `tools/exp-lite.mjs` 管理（`init/save/check/index`），红线靠写前自查 + `save` 的凭据扫描兜住。
4. 定期手动跑 `check` 做体检（[pipeline.md](pipeline.md) ④）。

**代价（要接受）**：

- 没有索引自动注入 → 全靠 agent 自觉去查，可能漏查；
- 没有回合末提醒 → 漏记率明显上升（接受漏记风险，靠兜底提炼批量补录）；
- 没有写入守卫 → 格式漂移、重复条目、红线事故只能靠 `check` 事后发现。

降级方案下建议把兜底提炼（[pipeline.md](pipeline.md) ③）设为固定周期动作，用零 LLM 会话摘要补漏。
