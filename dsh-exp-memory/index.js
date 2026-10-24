// dsh-exp-memory —— 经验沉淀插件：索引注入召回 + 回合末自动提醒沉淀 + 写入守卫 + 审计
// 零运行时依赖、零后台 LLM；记忆正文是纯 markdown，可 git、可手改、可迁移。
// 兼容 DSH >= 0.1.7（0.2.x 的 sessionProjections / agent.followup 缺失时自动降级）。
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  defaultMemDir,
  homeOf,
  neutralizePromptVars,
  parseEntries,
  readShards,
  readText,
  renderGlobalIndex,
  renderProjectLayer,
  slash,
  writeAtomic,
  SHARD_WARN_CHARS,
} from "./lib/store.js";
import { bashTouchesMemory, buildWritePayload, isMemoryPath, runWriteRules } from "./lib/guard.js";
import { DEFAULT_REMINDER, TurnTracker } from "./lib/reminder.js";
import { makeHandler } from "./lib/routes.js";

export const name = "exp-memory";
export const inject = ["systemPrompt"];

const DEFAULTS = {
  enabled: true,
  memoryDir: "", // 空 = ~/.dsh/exp-memory
  injectMode: "index", // index | full
  indexBudget: 12000,
  maxChars: 24000,
  discipline: true,
  autoDistill: true,
  every: 1,
  cooldownMin: 0,
  minTools: 1,
  reminderPrompt: "",
  skipSubagents: true,
  writeGuard: "rules", // rules | off
  audit: true,
};

export function apply(ctx, config = {}) {
  // 记忆根目录解析顺序：config.memoryDir → 环境变量 EXP_MEMORY_DIR → 默认 ~/.dsh/exp-memory。
  // settings.json 住在解析出的根目录里，所以根目录本身不能再从 settings.json 读（会自递归）。
  const memRoot = () =>
    slash(config.memoryDir || process.env.EXP_MEMORY_DIR || defaultMemDir()).replace(/\/+$/, "");
  const settings = () => ({ ...DEFAULTS, ...(readSettingsFile() ?? {}), ...stripEmpty(config) });

  const tracker = new TurnTracker({});
  const agents = new Map();
  const diag = { sessionEvents: 0, reminders: 0, lastVerdicts: [] };

  // ── 1) 注入召回：全局分片索引 + 项目层 + 记忆纪律块 ───────────────────────
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "exp-memory:long-term",
        order: 1,
        text: (context) => {
          try {
            const cfg = settings();
            if (cfg.enabled === false) return "";
            const root = memRoot();
            const blocks = [];
            const shards = readShards(`${root}/topics`);
            if (shards.length > 0) {
              if (cfg.injectMode === "full") {
                const full = renderFull(shards, cfg.maxChars);
                if (full) blocks.push(neutralizePromptVars(`${full}\n\n<!-- 写入本层：往上面某一片追加一行（- [YYYY-MM-DD] 事实），或在同一目录新建主题文件 -->`));
              } else {
                const body = renderGlobalIndex(shards, cfg.indexBudget, `全局记忆 · ${root}`);
                if (body) blocks.push(neutralizePromptVars(`${body}\n\n<!-- 写入本层：往上面某一片追加一行（- [YYYY-MM-DD] 事实），或在同一目录新建主题文件 -->`));
              }
            }
            const cwd = context?.agent?.session?.header?.cwd ?? context?.cwd;
            if (typeof cwd === "string" && cwd.length > 0) {
              const body = renderProjectLayer(cwd, `${root}/projects`, cfg.maxChars);
              if (body) blocks.push(neutralizePromptVars(body));
            }
            if (cfg.discipline !== false && blocks.length > 0) blocks.push(disciplineBlock(root));
            return blocks.join("\n\n");
          } catch (error) {
            return `<!-- exp-memory 注入失败：${String(error?.message ?? error).slice(0, 200)} -->`;
          }
        },
      }),
    "exp-memory: memory index section",
  );

  // ── 2) 写入守卫（tools/pre-execute）────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.on("tools/pre-execute", async (exec, next) => {
        try {
          const cfg = settings();
          if (cfg.writeGuard === "off") return next();
          const root = memRoot();
          let decided = null;

          if (exec?.name === "write" || exec?.name === "edit") {
            const payload = buildWritePayload(exec.name, exec?.arguments);
            if (payload && isMemoryPath(payload.path, root)) {
              decided = runWriteRules(payload, root);
            }
          } else if ((exec?.name === "bash" || exec?.name === "pwsh") && bashTouchesMemory(exec?.arguments?.command, root)) {
            decided = {
              decision: "ask",
              reason: "exp-memory write-guard：这条 shell 命令看起来会改动记忆文件（重定向/tee/sed -i/Out-File）。请确认；能用 write/edit 工具时优先用工具——会经过格式与敏感信息校验。",
            };
          }

          if (!decided) return next();
          if (cfg.audit !== false) {
            audit(root, {
              event: "pre-execute",
              tool: exec.name,
              path: exec?.arguments?.path ?? exec?.arguments?.file_path ?? null,
              decision: decided.decision,
              ...(decided.reason ? { reason: decided.reason.slice(0, 400) } : {}),
              ...(decided.notes?.length ? { notes: decided.notes.slice(0, 4) } : {}),
            });
          }
          if (decided.decision === "deny") return { kind: "deny", reason: decided.reason };
          if (decided.decision === "ask") return { kind: "ask", ...(decided.reason ? { reason: decided.reason } : {}) };
          return next();
        } catch {
          return next(); // 钩子故障放行不误伤
        }
      }),
    "exp-memory: write-guard pre-execute hook",
  );

  // ── 3) 审计 + 读取提醒（tools/post-execute）───────────────────────────────
  ctx.effect(
    () =>
      ctx.on("tools/post-execute", async (exec, result, next) => {
        const downstream = await next();
        try {
          const cfg = settings();
          const root = memRoot();
          const p = exec?.arguments?.path ?? exec?.arguments?.file_path ?? "";

          if ((exec?.name === "write" || exec?.name === "edit") && !result?.isError && p && isMemoryPath(p, root)) {
            const payload = buildWritePayload(exec.name, exec?.arguments);
            const added = payload ? payload.added.length : 0;
            const removed = payload ? payload.removed.length : 0;
            if (cfg.audit !== false) audit(root, { event: "post-write", tool: exec.name, path: slash(p), added, removed });
            tracker.cfg = settings();
            // 记忆写入对所有在册 agent 一并打标：agentId 命名空间可能与 exec/事件不一致
            tracker.markSedimented(agentIdOf(exec));
            tracker.markSedimented("main");
            for (const k of tracker.agents.keys()) tracker.markSedimented(k);
            // 落盘后再校一遍条目格式：不回滚，只附提醒让模型自修
            if (payload) {
              const bad = payload.added.filter((l) => /^\s*-\s/.test(l) && !/^\s*-\s\[\d{4}-\d{2}-\d{2}\]\s/.test(l) && slash(p).split("/").pop() !== "MEMORY.md");
              if (bad.length > 0) {
                return withContext(downstream, `exp-memory：本次新增 ${bad.length} 行疑似条目但格式不是 \`- [YYYY-MM-DD] 事实\`，请就地修正。`);
              }
            }
          }

          if (exec?.name === "read" && p && isMemoryPath(p, root)) {
            const text = readText(p);
            const entries = parseEntries(text).length;
            return withContext(
              downstream,
              `exp-memory 读取提醒：${slash(p)}（${entries} 条 / ${text.length} 字符）。引用按行号精确定位；不要凭索引标题臆测未读内容；发现过时条目就地修正。`,
            );
          }
          return downstream;
        } catch {
          return downstream;
        }
      }),
    "exp-memory: audit & read-reminder post-execute hook",
  );

  // ── 4) 回合末自动提醒沉淀（session/event + agent.followup）────────────────
  ctx.effect(
    () =>
      ctx.on("session/event", (session, event) => {
        try {
          diag.sessionEvents += 1;
          tracker.cfg = settings();
          const agentId = agentIdOf(session ?? event);
          const out = tracker.feed(agentId, event);
          if (out) {
            diag.lastVerdicts.unshift({ at: new Date().toISOString(), agentId, ...out, state: undefined });
            diag.lastVerdicts = diag.lastVerdicts.slice(0, 20);
          }
          if (out?.remind) dispatchReminder(agentId);
        } catch {
          /* 跟踪故障不影响会话 */
        }
      }),
    "exp-memory: turn-end reminder tracking",
  );

  ctx.effect(
    () =>
      ctx.on("agent/created", (agent) => {
        try {
          const id = agentIdOf(agent);
          agents.set(id, agent);
          tracker.setSubagent(id, Boolean(agent?.isSubagent) || agent?.kind === "subagent");
        } catch {
          /* ignore */
        }
      }),
    "exp-memory: agent registry",
  );

  function dispatchReminder(agentId) {
    const cfg = settings();
    if (cfg.autoDistill === false) return;
    const text = String(cfg.reminderPrompt || DEFAULT_REMINDER).replace(/<MEM>/g, memRoot());
    const agent = agents.get(agentId) ?? agents.get("main") ?? [...agents.values()][0];
    try {
      if (agent && typeof agent.followup === "function") {
        tracker.dispatched(agentId, Date.now());
        agent.followup(text);
        diag.reminders += 1;
        return;
      }
      if (agent && typeof agent.inject === "function") {
        tracker.dispatched(agentId, Date.now());
        agent.inject(text);
        diag.reminders += 1;
        return;
      }
      // 无可用通道：不打标，等下一回合再试（最多按 every 节流）
    } catch {
      /* dispatch 失败不打断会话 */
    }
  }

  // ── 5) HTTP 路由（核对注入内容 / 读写设置）────────────────────────────────
  ctx.inject(["webServer"], (wctx) => {
    ctx.effect(
      () =>
        wctx.webServer.register({
          kind: "prefix",
          path: "/exp-memory",
          handler: makeHandler({
            settings,
            patchSettings: (patch) => {
              const cur = readSettingsFile() ?? {};
              const next = { ...cur, ...stripEmpty(patch) };
              writeAtomic(`${memRoot()}/settings.json`, `${JSON.stringify(next, null, 2)}\n`);
              return settings();
            },
            listTargets: () => {
              const root = memRoot();
              const shards = readShards(`${root}/topics`).map((s) => s.name);
              let projects = [];
              try {
                projects = fs.readdirSync(`${root}/projects`).filter((n) => n.startsWith("--")).sort();
              } catch {
                /* 无项目层 */
              }
              return { global: shards, projects };
            },
            readTarget: (target, file) => {
              const root = memRoot();
              const safe = String(file ?? "").replace(/[\\/]/g, "");
              if (target === "global") {
                const path = safe ? `${root}/topics/${safe}` : `${root}/topics`;
                if (!safe) return { ok: true, text: readShards(`${root}/topics`).map((s) => `${s.name}\t${s.file}\t${s.count} 条`).join("\n") };
                return { ok: true, text: readText(path), path: slash(path) };
              }
              const slug = String(target ?? "");
              if (!/^--[A-Za-z0-9\u4e00-\u9fff._~ -]+--$/.test(slug)) return { ok: false, error: "bad target" };
              const path = safe ? `${root}/projects/${slug}/${safe}` : `${root}/projects/${slug}/MEMORY.md`;
              return { ok: true, text: readText(path), path: slash(path) };
            },
            diagnostics: () => ({
              version: "0.1.0",
              home: homeOf(),
              memRoot: memRoot(),
              seams: { sessionEvents: diag.sessionEvents, agents: agents.size, reminders: diag.reminders },
              lastVerdicts: diag.lastVerdicts,
            }),
          }),
        }),
      "exp-memory: routes",
    );
  });

  // ── 内部小工具 ────────────────────────────────────────────────────────────
  function readSettingsFile() {
    try {
      return JSON.parse(readText(`${memRoot()}/settings.json`)) ?? null;
    } catch {
      return null;
    }
  }

  function agentIdOf(x) {
    return String(x?.agentId ?? x?.agent?.id ?? x?.id ?? x?.session?.id ?? "main");
  }

  function audit(root, payload) {
    try {
      const line = `${JSON.stringify({ t: new Date().toISOString(), ...payload })}\n`;
      const p = `${root}/audit.log`;
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        /* 无文件 */
      }
      if (size > 2 * 1024 * 1024) {
        try {
          fs.renameSync(p, `${p}.1`);
        } catch {
          /* 轮转失败照常写 */
        }
      }
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(p, line, "utf8");
    } catch {
      /* 审计失败不影响主流程 */
    }
  }
}

// ── 纯函数区（无 ctx 依赖，便于测试）─────────────────────────────────────────

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

function renderFull(shards, maxChars) {
  const parts = [`<!-- 全局记忆 · 全文注入：${shards.length} 片 -->`];
  for (const s of shards) {
    const text = readText(s.file);
    if (text.length > SHARD_WARN_CHARS) {
      parts.push("", `## ${s.name} → ${s.file}（${(text.length / 1000).toFixed(1)}k，超 ${SHARD_WARN_CHARS / 1000}k 建议拆片，本片只注入前段）`, "", text.slice(0, SHARD_WARN_CHARS));
    } else {
      parts.push("", `## ${s.name} → ${s.file}`, "", text);
    }
    if (maxChars > 0 && parts.join("\n").length > maxChars) {
      parts.push("", `<!-- 正文超过 maxChars=${maxChars}，截断。建议切回 index 模式或拆片 -->`);
      break;
    }
  }
  return parts.join("\n");
}

function disciplineBlock(root) {
  return [
    "<!-- exp-memory 纪律（写入守卫会拒绝违规写入） -->",
    `【开工先查】上面是索引（片名 · 条数 · 最新日期 · 关键词 + 条目行号）。先按关键词判断该不该读，需要细节时按行号 read ${root}/topics/ 对应分片，不要凭标题臆测。`,
    "【收工即写】同一轮内把可复用经验落盘：踩坑与根因、验证过的命令/参数/路径、方案取舍、环境事实、用户偏好。格式 `- [YYYY-MM-DD] **短标题** —— 结论`，单条 ≤400 字，标题不带冒号，一条一件事；写前查重（同一件事 edit 补一句）。",
    "【红线】绝不写密钥/token/密码（只写「凭据放在哪里」）；记现状不记变迁史；不写流水账与可从仓库推出的内容。",
  ].join("\n");
}

/**
 * 给工具结果附加上下文：DSH 工具结果走 `additionalContexts`（元素与官方
 * createUserMessage 产出同构的 user 消息），不是往 content/text 字符串里拼。
 */
function contextMessage(text) {
  return { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: "exp-memory" } };
}

function withContext(result, note) {
  try {
    if (result && typeof result === "object") {
      return { ...result, additionalContexts: [contextMessage(note), ...(result.additionalContexts ?? [])] };
    }
  } catch {
    /* 附加失败返回原结果 */
  }
  return result;
}

export { withContext, contextMessage, renderFull, disciplineBlock, stripEmpty };
