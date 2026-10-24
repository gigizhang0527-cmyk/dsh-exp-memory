# dsh-exp-memory · 跨会话经验沉淀

> 给 DeepSeek Harness（DSH）的**经验沉淀系统**：插件（自动化）+ skill（作业规范）。
> 让每天开的不同任务窗口不再各自失忆——踩过的坑、验证过的命令、方案取舍，跨会话沉淀、按需召回。
> 纯本地、纯 markdown、零额外 LLM 后台成本、可 git 追踪。

## 解决什么

Agent 每个会话都是独立失忆的。经验要跨窗口沉淀需要同时解决四件事，本项目各给一套：

| 环节 | 做法 | 在哪 |
| --- | --- | --- |
| 沉淀触发 | 回合末自动提醒（`turn/end` 门控 → 独立收尾回合） | 插件 |
| 存储组织 | `topics/` 全局分片 + `projects/<slug>/` 项目层 | 插件 + skill |
| 跨窗口召回 | 只注入**索引**（片名·条数·关键词·行号），正文按需读 | 插件 |
| 质量守卫 | 写入守卫：格式/日期/八类凭据/防覆写删史 | 插件 |
| 何时记·记什么 | 作业纪律（值得记 vs 不记、红线、查重、收工即写） | skill |

## 仓库结构

```
dsh-exp-memory/       插件包（npm 可发布形态，MIT，零运行时依赖）
exp-sedimentation/    skill 分发包（给任意 agent 用，非 DSH 也通用）
install.mjs           一键安装脚本（node >=18，跨 Windows/macOS/Linux）
安装指南.md            完整安装文档（三条路线 + 记忆库迁移 + 验收 + 回滚 + FAQ）
```

## 快速开始

**方式一 · 一键脚本（推荐）**

```bash
git clone https://github.com/<你的用户名>/dsh-exp-memory.git
cd dsh-exp-memory
node install.mjs        # 装插件 + 复制 skill，幂等可重复跑
# 然后完全退出并重开 DSH（插件只在启动时加载）
```

**方式二 · 只要经验沉淀方法（零插件，任意 agent）**

把 `exp-sedimentation/` 拷到目标 agent 的技能目录（DSH 是 `~/.agents/skills/`），
或直接把 `exp-sedimentation/SKILL.md` 当提示词附件。详见 [exp-sedimentation/README.md](exp-sedimentation/README.md)。

完整安装（含 npm 发布、桌面端/CLI 差异、记忆库迁移、验收、回滚）见 **[安装指南.md](安装指南.md)**。

## 依赖的 DSH 能力

`systemPrompt.section`（函数式索引注入）· `tools/pre-execute`（写入守卫）·
`tools/post-execute`（审计+读取提醒）· `session/event` + `agent.followup()`（回合末提醒）·
`webServer.register`（诊断路由）。兼容 DSH `>=0.1.7-rc.1`，缺失的 API 自动降级不抛错。

## 设计取舍

- **不指向量检索、不调用模型**：检索 = 索引 + 行号 + `read`，零成本、可离线、可 diff。
- **只注入索引**：记忆再长，提示词开销恒定；预算收缩按每片配额，绝不整层归零。
- **提醒走独立收尾回合**：不用同回合 steer（会折叠原任务答案），收尾回合不递归。
- **不往会话日志写自定义事件**：避免会话无法重开；状态只落自己的目录。
- **Windows 路径从第一行就安全**：反斜杠归一化、slug `~XXXX` 转义、HOME→USERPROFILE 兜底。

## 隐私

记忆就是本地 markdown 文件，不上传、不联网、不落第二份数据。**任何情况下不要把密钥写进记忆**——
它会随每次请求离开本机。写入守卫内置八类凭据扫描兜底。

## License

MIT
