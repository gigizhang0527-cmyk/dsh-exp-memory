# exp-sedimentation · 分发与安装说明

> 可分发的经验沉淀 skill 包：告诉任意 agent **何时记、记什么、怎么记**，
> 并附零依赖工具 `tools/exp-lite.mjs` 管理记忆库。纯文本 + 单文件脚本，不依赖任何宿主。

## 1. 包内容

| 文件 | 作用 |
| --- | --- |
| [SKILL.md](SKILL.md) | 工作流索引：开工先查 → 收工沉淀 → 兜底提炼 → 体检拆片（frontmatter 的 `name` 不可改） |
| [references/data-model.md](references/data-model.md) | 数据模型：三层目录、首行注释、条目格式、slug 推导、索引行格式 |
| [references/discipline.md](references/discipline.md) | 记忆纪律：值得记/不值得记、红线、记现状、查重、回报 |
| [references/pipeline.md](references/pipeline.md) | 四步闭环全流程 + 常见坑 |
| [references/plugin-setup.md](references/plugin-setup.md) | 自动化组件（插件 dsh-exp-memory）安装配置与纯规格降级 |
| [tools/exp-lite.mjs](tools/exp-lite.mjs) | 零依赖 Node CLI：init / save / check / index |

## 2. 安装方式（三选一）

### 方式 A · DSH 技能目录（推荐）

把整个 `exp-sedimentation/` 文件夹拷到目标 agent 的技能目录：

- DSH：`~/.agents/skills/`（Windows 即 `C:\Users\<你>\.agents\skills\`）；
- 目录名随意，但 **SKILL.md 里的 `name: exp-sedimentation` 不能改**（frontmatter name 必须是
  ASCII kebab-case，技能表按它显示与路由）。

```powershell
Copy-Item -Recurse "exp-sedimentation" "$env:USERPROFILE\.agents\skills\exp-sedimentation"
```

### 方式 B · 提示词附件（任意 agent）

不支持技能目录的 agent：把 `SKILL.md` + `references/` 的内容直接粘进系统提示 / AGENTS.md，
或作为附件随任务发给 agent；`tools/exp-lite.mjs` 可留可省（省了就按 references 里的格式手工 write/edit）。

### 方式 C · 只装工具

只想管理记忆库、不需要作业规范：拷走 `tools/exp-lite.mjs` 单文件即可（node ≥ 18，零依赖）。

## 3. 验证安装

1. **新会话技能表**里应出现 `exp-sedimentation`（方式 A）；方式 B 则看系统提示里是否已带上规范。
2. 跑一遍工具四步（在任意临时目录）：

```powershell
node tools/exp-lite.mjs init  --root "$env:TEMP\exp-demo"
node tools/exp-lite.mjs save  --root "$env:TEMP\exp-demo" --domain demo --title "示例条目" --insight "示例结论：写共享文件先 read 再 edit。"
node tools/exp-lite.mjs check --root "$env:TEMP\exp-demo"
node tools/exp-lite.mjs index --root "$env:TEMP\exp-demo"
```

预期：四步 exit 0，`index` 打印出 `topics/exp-demo.md` 的片级行与条目标题、行号。
清理：`Remove-Item -Recurse "$env:TEMP\exp-demo"`。

3. 抽查红线：`save --insight "token=abc"` 应报“凭据红线命中”并以 exit 2 拒绝写入。

## 4. 使用约定（给被分发的 agent）

- 记忆根目录默认 `<cwd>/.exp-memory/`，可用 `--root` 指到别处（多项目共享库就指到统一目录）。
- 条目格式与红线以 `references/data-model.md`、`references/discipline.md` 为准；skill 的 SKILL.md 只做路由。
- 想要自动化召回/提醒/写入守卫，再装插件 `dsh-exp-memory`（见
  [references/plugin-setup.md](references/plugin-setup.md)）；不装也能按纯规格跑，只是接受漏记风险。

## 5. 许可与边界

- 本 skill 包为纯文本规范 + 零依赖脚本，可整体拷贝分发，改 frontmatter 的 `name` 以外的内容随意。
- 不包含任何凭据；接入真实记忆库前请确认根目录指向正确。
