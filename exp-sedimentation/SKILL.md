---
name: exp-sedimentation
description: 经验沉淀与教训记录的作业规范，适用于经验沉淀、教训记录、记忆库建设、任务收尾：开工先查经验库、收工把踩坑与验证结论写成条目、长会话兜底补录、定期体检拆片。
---

# exp-sedimentation · 经验沉淀作业规范

> 一句话目标：把「下个项目还会用上」的事实，在**当轮**写成条目，并让未来的自己能按索引命中、按行号取回。
> 格式地基（三层布局、条目 `- [YYYY-MM-DD] **短标题** —— 结论`、slug 规则）先读
> [references/data-model.md](references/data-model.md)；单条 ≤400 字、标题不带冒号、一条只讲一件事。

## 第 1 步 · 开工先查

- 用任务关键词（框架/工具/文件名/报错码/用户原话里的名词）匹配分片索引的关键词行。
- 命中 → 按**行号** read 对应条目正文再动手；没命中就开工，不要整库通读、不要凭片名臆测正文。
- 项目层 `projects/<slug>/MEMORY.md` 随 cwd 自动生效，项目专属细节先看这里。
- 要点详见 [references/pipeline.md](references/pipeline.md) 第 ① 节。

## 第 2 步 · 收工沉淀（同一轮内完成，不许留到“以后”）

- 判定标准：踩坑与根因、验证过的命令/参数/路径、方案取舍、环境事实、用户偏好 → 记；
  过程叙述、可从仓库推出的内容、临时状态、流水账 → 不记。
- 落盘二选一：`node tools/exp-lite.mjs save --domain <key> --title "短标题" --insight "结论"`，
  或直接按 ENTRY 格式 write/edit 对应分片（先 read 再写、先查重）。
- 红线：绝不写密钥/token/密码，只写“凭据放在哪里”；记现状不记变迁史。
- 本轮结束前回复末尾回报：**本轮沉淀 N 条**（没有就写“本轮无需沉淀”）。
- 判定标准、红线、查重与回报话术：见 [references/discipline.md](references/discipline.md)。

## 第 3 步 · 兜底提炼（会话超长 / 当轮漏记时）

- 优先零 LLM 成本：会话日志按 zstd 多帧解压提取事实（digest 流水线），或让当前 agent 自己总结本会话。
- 批量补录仍走同一 ENTRY 格式与同一红线；补录后回报补录条数。
- 完整兜底流程：见 [references/pipeline.md](references/pipeline.md) 第 ③ 节。

## 第 4 步 · 体检拆片（定期 / 大量写入后）

- `node tools/exp-lite.mjs check`：查条目格式、日期合法性、单条 >400 字、单片 >12000 字、重复标题。
- 单片超 12000 字符 → 按子主题拆片，新片首行写新关键词注释，**原片索引首行关键词同步更新**。
- 拆片后用 `node tools/exp-lite.mjs index` 复查索引，确认条目标题与行号仍能命中。
- 体检与拆片细则：见 [references/pipeline.md](references/pipeline.md) 第 ④ 节。

## 自动化组件（可选，不影响以上四步执行）

- 插件 `dsh-exp-memory` 提供索引注入、回合末提醒、写入守卫、审计；与 skill 的分工与安装两条路：
  见 [references/plugin-setup.md](references/plugin-setup.md)。
- 无插件降级：把 [references/discipline.md](references/discipline.md) 内容放进 AGENTS.md / 系统提示，靠纪律触发。
