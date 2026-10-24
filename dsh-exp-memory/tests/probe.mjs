// tests/probe.mjs —— dsh-exp-memory 离线自检（临时目录，不碰真实数据）
// 运行：node tests/probe.mjs   全绿 exit 0，任何失败 exit 1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);

const {
  slugOf, parseEntries, validDate, scanSecrets, renderGlobalIndex, renderProjectLayer,
  neutralizePromptVars, writeAtomic, readText,
} = await import(`file://${path.join(PKG, "lib", "store.js")}`.replace(/\\/g, "/"));
const { runWriteRules, bashTouchesMemory, buildWritePayload, isMemoryPath } = await import(
  `file://${path.join(PKG, "lib", "guard.js")}`.replace(/\\/g, "/")
);
const { evaluateTurn, TurnTracker, DEFAULT_REMINDER } = await import(
  `file://${path.join(PKG, "lib", "reminder.js")}`.replace(/\\/g, "/")
);
const plugin = await import(`file://${path.join(PKG, "index.js")}`.replace(/\\/g, "/"));

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}
function section(name) {
  console.log(`\n${name}`);
}

// ── 临时记忆目录 ────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "exp-memory-probe-"));
const MEM = `${TMP}/.dsh/exp-memory`.replace(/\\/g, "/");
fs.mkdirSync(`${MEM}/topics`, { recursive: true });
fs.mkdirSync(`${MEM}/projects`, { recursive: true });

section("store：slug / 日期 / 条目解析");
ok(slugOf("D:\\Projects\\机器学习") === "--D-Projects-~673A~5668~5B66~4E60--", "slug Windows 中文路径 → ~XXXX 转义");
ok(slugOf("/Users/me/code/repo") === "--Users-me-code-repo--", "slug POSIX 路径");
ok(slugOf("C:\\Users\\you\\.dsh") === "--C-Users-you-.dsh--", "slug 盘符去冒号");
const today = "2026-10-23";
ok(validDate("2026-10-23", today) === true, "今天合法");
ok(validDate("2026-10-24", today) === false, "未来日期非法");
ok(validDate("2026-02-30", today) === false, "不存在的日期非法");
ok(validDate("2026-1-2", today) === false, "非 ISO 格式非法");
const parsed = parseEntries("# 片\n\n- [2026-10-20] **标题A** —— 内容\n- [2026-10-21] 标题B —— 内容\n");
ok(parsed.length === 2, "条目解析数量");
ok(parsed[0].line === 3 && parsed[0].title === "标题A", "条目行号与粗体标题提取");
ok(parsed[1].title.startsWith("标题B"), "无粗体时取行首为标题");

section("store：凭据扫描（只报模式名不回显值）");
const hits = scanSecrets("密码 password=dummyvalue123\n正常文字\nsk-dummykey123456789012345\n");
ok(hits.length === 2, "命中 2 处");
ok(hits.every((h) => !JSON.stringify(h).includes("dummyvalue123")), "不回显值");
ok(scanSecrets("干净内容 - [2026-10-23] **x** —— y").length === 0, "干净文本无误报");

section("store：索引渲染与预算阶梯（绝不整层归零）");
const shards = Array.from({ length: 10 }, (_, i) => ({
  name: `exp-s${i}`,
  file: `${MEM}/topics/exp-s${i}.md`,
  keywords: `kw${i}`,
  count: 20,
  size: 20000,
  latest: "2026-10-22",
  entries: Array.from({ length: 20 }, (_, j) => ({ line: j + 3, date: "2026-10-22", title: `条目${i}-${j}`, len: 60 })),
}));
const big = renderGlobalIndex(shards, 12000, "全局记忆");
ok(big.length <= 12000, `预算内（${big.length} ≤ 12000）`);
ok((big.match(/^## exp-s/gm) ?? []).length === 10, "每片都保留片级线索");
ok(/更早 \d+ 条在第 \d+–\d+ 行/.test(big), "收缩时给出更早条目行号区间");
const zero = renderGlobalIndex(shards, 0);
ok((zero.match(/条目0-/g) ?? []).length === 20, "indexBudget=0 全量逐条");
ok(renderGlobalIndex([], 100) === "", "空库返回空串");

section("store：{{ 转义 / 原子写 / 项目层");
ok(!neutralizePromptVars("a {{var}} b").includes("{{"), "注入文本拆开 {{");
writeAtomic(`${MEM}/topics/exp-a.md`, "# exp-a · 测试关键词\n\n- [2026-10-20] **老条目** —— 内容\n");
ok(readText(`${MEM}/topics/exp-a.md`).includes("老条目"), "原子写可读回");
const projDir = `${MEM}/projects/${slugOf("E:\\DeepSeek\\插件")}`;
fs.mkdirSync(projDir, { recursive: true });
writeAtomic(`${projDir}/MEMORY.md`, "# 项目记忆\n\n- [构建](build.md) —— 构建经验\n");
writeAtomic(`${projDir}/build.md`, "---\ntitle: 构建\n---\n正文");
const projBody = renderProjectLayer("E:\\DeepSeek\\插件", `${MEM}/projects`, 24000);
ok(projBody.includes("索引 (MEMORY.md)"), "项目层目录形式注入索引");
ok(projBody.includes("未被索引登记的正文") === false, "已登记正文不算孤儿");
writeAtomic(`${projDir}/orphan.md`, "正文");
ok(renderProjectLayer("E:\\DeepSeek\\插件", `${MEM}/projects`, 24000).includes("orphan.md"), "孤儿正文被列出");

section("guard：写入规则引擎");
const good = runWriteRules(
  { path: `${MEM}/topics/exp-a.md`, oldText: readText(`${MEM}/topics/exp-a.md`), newText: `${readText(`${MEM}/topics/exp-a.md`)}- [2026-10-23] **新经验** —— 结论\n`, added: ["- [2026-10-23] **新经验** —— 结论"], removed: [] },
  MEM,
  today,
);
ok(good.decision === "allow", "合法新条目放行");
ok(runWriteRules({ path: `${MEM}/audit.log`, oldText: "", newText: "x", added: ["x"], removed: [] }, MEM, today).decision === "deny", "内部资产拒绝");
ok(runWriteRules({ path: `${MEM}/topics/exp-a.md`, oldText: "", newText: "", added: ["- 今天干了很多事"], removed: [] }, MEM, today).decision === "deny", "条目格式非法拒绝");
ok(runWriteRules({ path: `${MEM}/topics/exp-a.md`, oldText: "", newText: "", added: ["- [2026-11-01] **未来** —— x"], removed: [] }, MEM, today).decision === "deny", "未来日期拒绝");
ok(runWriteRules({ path: `${MEM}/topics/exp-a.md`, oldText: "", newText: "", added: ["- [2026-10-23] **x** —— token=dummytoken123"], removed: [] }, MEM, today).decision === "deny", "凭据红线拒绝");
const shrink = runWriteRules(
  { path: `${MEM}/topics/exp-a.md`, oldText: readText(`${MEM}/topics/exp-a.md`), newText: "# 空\n", added: [], removed: ["- [2026-10-20] **老条目** —— 内容"] },
  MEM,
  today,
);
ok(shrink.decision === "deny", "整文件覆写删条目拒绝");
const idxOk = runWriteRules(
  { path: `${projDir}/MEMORY.md`, oldText: "", newText: "", added: ["- [构建](build.md) —— 构建经验"], removed: [] },
  MEM,
  today,
);
ok(idxOk.decision === "allow", "项目层索引行放行");
const stale = runWriteRules(
  { path: `${MEM}/topics/exp-a.md`, oldText: "", newText: "", added: ["- [2026-10-23] **状态** —— 某工具已卸载，不再使用"], removed: [] },
  MEM,
  today,
);
ok(stale.decision === "allow" && (stale.notes ?? []).length > 0, "过时陈述放行但留痕");
ok(bashTouchesMemory(`echo x >> ${MEM}/topics/exp-a.md`, MEM) === true, "bash 重定向改记忆 → ask 判定");
ok(bashTouchesMemory("echo hello", MEM) === false, "无关命令不拦");
ok(isMemoryPath(`C:\\Users\\a\\.dsh\\exp-memory\\topics\\x.md`, "C:/Users/a/.dsh/exp-memory") === true, "Windows 反斜杠路径识别");
ok(isMemoryPath(`${MEM}/projects`, MEM) === true, "根下路径识别");

section("reminder：门控与状态机");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 1 }, {}, 0).remind === true, "满足条件 → 提醒");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 1, isDistillRound: true }, {}, 0).remind === false, "收尾回合不递归");
ok(evaluateTurn({ outcome: "idle", toolCalls: 0, workedSinceRemind: 1 }, {}, 0).remind === false, "idle 回合跳过");
ok(evaluateTurn({ outcome: "worked", toolCalls: 0, workedSinceRemind: 1 }, {}, 0).remind === false, "无工具调用跳过");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 1, isSubagent: true }, {}, 0).remind === false, "subagent 跳过");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 1, sedimentedThisTurn: true }, {}, 0).remind === false, "已沉淀不再提醒");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 0 }, { every: 2 }, 0).remind === false, "every 节流");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 1 }, { cooldownMin: 10, }, 60000).remind === true, "无历史提醒不冷却");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 1, lastRemindAt: 0 }, { cooldownMin: 10 }, 60000).remind === false, "冷却期内跳过（lastRemindAt=0）");
ok(evaluateTurn({ outcome: "worked", toolCalls: 2, workedSinceRemind: 1 }, { autoDistill: false }, 0).remind === false, "autoDistill 关闭");

const tr = new TurnTracker({});
ok(tr.feed("a", { type: "turn/start" }) === null, "turn/start 无判定");
ok(tr.feed("a", { type: "tool/call" }) === null, "tool/call 计数");
const v1 = tr.feed("a", { type: "turn/end" });
ok(v1?.remind === true, "首个有效回合即提醒（every=1）");
tr.dispatched("a", 1000);
const v2 = tr.feed("a", { type: "turn/start" });
ok(v2 === null, "收尾回合开始");
const v3 = tr.feed("a", { type: "turn/end" });
ok(v3?.remind === false, "收尾回合不再递归");
const v4 = tr.feed("a", { type: "turn/start" });
tr.markSedimented("a");
const v5 = tr.feed("a", { type: "turn/end" });
ok(v5?.remind === false && /已沉淀/.test(v5?.reason ?? ""), "收尾回合之后恢复正常且已沉淀跳过");

section("plugin：假 ctx 装配（回放注入与钩子）");
const sections = [];
const hooks = {};
const fakeCtx = {
  effect(fn) {
    try {
      fn();
    } catch {
      /* ignore */
    }
    return () => {};
  },
  systemPrompt: {
    section(s) {
      sections.push(s);
      return () => {};
    },
  },
  on(ev, cb) {
    (hooks[ev] ??= []).push(cb);
    return () => {};
  },
  inject() {
    /* webServer 缺席 */
  },
};
plugin.apply(fakeCtx, { memoryDir: MEM, indexBudget: 12000 });
ok(sections.length === 1 && sections[0].name === "exp-memory:long-term", "systemPrompt.section 注册");
const text = sections[0].text({ agent: { session: { header: { cwd: "E:\\DeepSeek\\插件" } } } });
ok(text.includes("全局记忆") && text.includes("exp-a"), "注入包含全局片索引");
ok(text.includes("项目记忆") || text.includes("MEMORY.md"), "注入包含项目层");
ok(text.includes("exp-memory 纪律"), "注入包含纪律块");
ok(!text.includes("{{"), "注入无 {{ 残留");

ok((hooks["tools/pre-execute"] ?? []).length === 1, "pre-execute 钩子注册");
ok((hooks["tools/post-execute"] ?? []).length === 1, "post-execute 钩子注册");
ok((hooks["session/event"] ?? []).length === 1, "session/event 跟踪注册");

const pre = hooks["tools/pre-execute"][0];
const denyRes = await pre(
  { name: "write", arguments: { path: `${MEM}/topics/exp-a.md`, content: "# x\n- 乱写的条目\n" } },
  () => "NEXT",
);
ok(denyRes?.kind === "deny", "坏条目写入被 deny");
const allowRes = await pre(
  { name: "write", arguments: { path: `${MEM}/topics/exp-a.md`, content: `${readText(`${MEM}/topics/exp-a.md`)}- [2026-10-23] **探针条目** —— probe\n` } },
  () => "NEXT",
);
ok(allowRes === "NEXT", "合法写入放行到下游");
const post = hooks["tools/post-execute"][0];
const readNote = await post(
  { name: "read", arguments: { path: `${MEM}/topics/exp-a.md` } },
  { isError: false },
  async () => ({ content: [{ type: "text", text: "正文内容" }] }),
);
ok(Array.isArray(readNote.additionalContexts) && JSON.stringify(readNote.additionalContexts).includes("读取提醒"), "read 命中记忆经 additionalContexts 附读取提醒");
ok(readNote.additionalContexts[0].role === "user" && readNote.additionalContexts[0].content[0].type === "text", "附加消息与官方 createUserMessage 同构");
const ev = hooks["session/event"][0];
ev({ id: "s1" }, { type: "turn/start" });
ev({ id: "s1" }, { type: "tool/call" });
const shouldRemind = ev({ id: "s1" }, { type: "turn/end" });
ok(shouldRemind === undefined || shouldRemind === null, "事件处理不抛错");
ok(fs.existsSync(`${MEM}/audit.log`), "审计日志生成");

section("plugin：导出面");
ok(plugin.name === "exp-memory" && Array.isArray(plugin.inject), "name / inject 导出");
ok(typeof DEFAULT_REMINDER === "string" && DEFAULT_REMINDER.includes("经验沉淀"), "默认提醒词");

// 清理
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
