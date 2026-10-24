// lib/store.js —— 记忆存储层：路径 / slug / 条目解析 / 索引渲染（零依赖，Windows 安全）
import fs from "node:fs";
import os from "node:os";

export const LADDER = [8, 5, 3, 2, 1, 0];
export const ENTRY_RE = /^-\s\[(\d{4}-\d{2}-\d{2})\]\s(.*)$/;
export const INDEX_LINE_RE = /^-\s\[[^\]]+\]\([^)]+\)/; // 项目层 MEMORY.md 的 `- [标题](文件.md) — 摘要`
export const TITLE_MAX = 80;
export const ENTRY_WARN_CHARS = 400;
export const SHARD_WARN_CHARS = 12000;
export const IS_WIN = process.platform === "win32";

/** HOME：Windows 无 HOME 时用 USERPROFILE 兜底，统一正斜杠。 */
export function homeOf() {
  const raw =
    process.env.HOME ||
    process.env.USERPROFILE ||
    `${process.env.HOMEDRIVE ?? ""}${process.env.HOMEPATH ?? ""}` ||
    os.homedir() ||
    "";
  return String(raw).replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 反斜杠归一化。 */
export function slash(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

/** 用于路径比较的归一化（Windows 大小写不敏感）。 */
export function normForCompare(p) {
  const s = slash(p).replace(/\/+$/, "");
  return IS_WIN ? s.toLowerCase() : s;
}

/** 项目 slug：与 ~/.dsh/sessions 目录命名一致（非 ASCII 转 ~XXXX）。 */
export function slugOf(cwd) {
  const raw = slash(cwd).replace(/^([A-Za-z]):/, "$1");
  const trimmed = raw.replace(/\/+$/, "").replace(/^\/+/, "");
  const enc = trimmed.replace(
    /[^\x20-\x7e]/g,
    (c) => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"),
  );
  return "--" + enc.replace(/\//g, "-") + "--";
}

/** 默认记忆根目录（可用 config.memoryDir 覆盖）。 */
export function defaultMemDir() {
  return `${homeOf()}/.dsh/exp-memory`;
}

export function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** 原子写：先写临时文件再 rename；已有文件改前留 .bak。 */
export function writeAtomic(p, text) {
  const dir = slash(p).replace(/\/[^/]+$/, "");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(p)) {
    try {
      fs.copyFileSync(p, `${p}.bak`);
    } catch {
      /* .bak 失败不阻塞写入 */
    }
  }
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
}

/** 注入文本拆开 `{{`，避免提示词组装器当变量解析。 */
export function neutralizePromptVars(text) {
  return String(text ?? "").replace(/\{\{/g, "{ {");
}

/** 日期合法（真实存在且 ≤ 今天）。 */
export function validDate(iso, todayIso = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return false;
  return iso <= todayIso;
}

/** 解析条目：返回 [{line, date, rest, title, len}]（行号 1 起）。 */
export function parseEntries(text) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_RE);
    if (!m) continue;
    const rest = m[2];
    const title = (rest.match(/\*\*(.+?)\*\*/) ?? [])[1] ?? rest.slice(0, TITLE_MAX);
    out.push({ line: i + 1, date: m[1], rest, title: title.slice(0, TITLE_MAX), len: lines[i].length });
  }
  return out;
}

/** 敏感信息扫描：只报行号与模式名，不回显值。 */
export const SECRET_PATTERNS = [
  { name: "sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: "password-assign", re: /\b(password|passwd)\s*[=:]\s*\S+/i },
  { name: "token-assign", re: /\b(token|secret|api[_-]?key)\s*[=:]\s*\S+/i },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "basic-auth-url", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i },
];

export function scanSecrets(text) {
  const hits = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(lines[i])) hits.push({ line: i + 1, pattern: p.name });
    }
  }
  return hits;
}

/** 扫描 topics/ 分片。 */
export function readShards(topicsDir) {
  let names = [];
  try {
    names = fs.readdirSync(topicsDir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return names.map((n) => {
    const file = `${slash(topicsDir)}/${n}`;
    const text = readText(file);
    const firstLine = text.split("\n")[0] ?? "";
    const kw = firstLine.match(/<!--\s*[^·：:]+[·：:]\s*([^>]*?)\s*-->/);
    const h1 = text.match(/^#\s+(.+)$/m);
    const entries = parseEntries(text);
    const latest = entries.reduce((m, e) => (e.date > m ? e.date : m), "");
    return {
      name: (h1 ? h1[1].trim() : n.replace(/\.md$/, "")),
      file,
      keywords: kw ? kw[1].trim() : "",
      entries,
      count: entries.length,
      size: text.length,
      latest,
    };
  });
}

/**
 * 全局层索引（预算内按片配额列最新 N 条，绝不整层归零）。
 * 超预算沿 LADDER 收缩每片条目数；末档 0 = 仅片级线索。
 */
export function renderGlobalIndex(shards, budget = 12000, label = "全局记忆") {
  if (shards.length === 0) return "";
  const render = (perShard) => {
    const parts = [`<!-- ${label} · 索引模式：${shards.length} 片 / ${shards.reduce((a, s) => a + s.count, 0)} 条 -->`];
    for (const s of shards) {
      const head = `## ${s.name} → ${s.file}（${s.count} 条 · ${(s.size / 1000).toFixed(1)}k${s.latest ? ` · 最新 ${s.latest}` : ""}${s.keywords ? ` · ${s.keywords}` : ""}）`;
      parts.push("", head);
      if (perShard > 0 && s.entries.length > 0) {
        const shown = s.entries.slice(-perShard);
        const hidden = s.entries.length - shown.length;
        for (const e of shown) parts.push(`- [${e.date}] ${e.title}（L${e.line}）`);
        if (hidden > 0) {
          const from = s.entries[0].line;
          const to = s.entries[hidden - 1].line;
          parts.push(`- …更早 ${hidden} 条在第 ${from}–${to} 行，按行号 read ${s.file}`);
        }
      } else if (perShard === 0 && s.count > 0) {
        parts.push(`- ${s.count} 条，第 ${s.entries[0].line}–${s.entries[s.entries.length - 1].line} 行，按行号 read ${s.file}`);
      }
    }
    return parts.join("\n");
  };
  if (!(budget > 0)) return render(Infinity);
  for (const perShard of LADDER) {
    const text = render(perShard === 0 ? 0 : perShard);
    if (text.length <= budget || perShard === 0) return text;
  }
  return render(0);
}

/** 项目层：目录形式（MEMORY.md 是人写索引）或单文件形式（条目集合）。 */
export function renderProjectLayer(cwd, projectsDir, maxChars = 24000) {
  const slug = slugOf(cwd);
  const dir = `${slash(projectsDir)}/${slug}`;
  const indexPath = `${dir}/MEMORY.md`;
  const filePath = `${slash(projectsDir)}/${slug}.md`;
  const isDir = fs.existsSync(dir) && fs.statSync(dir).isDirectory();

  if (isDir) {
    const indexText = readText(indexPath).trim();
    const others = [];
    try {
      for (const n of fs.readdirSync(dir).sort()) {
        if (!n.endsWith(".md") || n === "MEMORY.md") continue;
        others.push({ name: n, size: readText(`${dir}/${n}`).length });
      }
    } catch {
      /* 目录不可读按只有索引处理 */
    }
    if (!indexText && others.length === 0) return "";
    const refs = new Set([...indexText.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1].split("/").pop()));
    const orphans = others.filter((f) => !refs.has(f.name));
    const parts = [
      `<!-- 项目记忆 · ${cwd} · 目录形式：索引 ${(indexText.match(/^\s*-\s\[/gm) ?? []).length} 条 / 正文 ${others.length} 篇，正文按需 read -->`,
    ];
    if (indexText) {
      const body = maxChars > 0 && indexText.length > maxChars ? `${indexText.slice(0, maxChars)}\n…（超长截断）` : indexText;
      parts.push("", `## 索引 (MEMORY.md) → ${indexPath}`, "", body);
    }
    if (orphans.length > 0) {
      parts.push("", "## 未被索引登记的正文（要么读它，要么把它补进 MEMORY.md）");
      for (const f of orphans) parts.push(`- ${f.name} (${(f.size / 1000).toFixed(1)}k)`);
    }
    parts.push("", `<!-- 写入本层：正文写进对应主题文件，并在 MEMORY.md 补一行 \`- [标题](文件.md) — 摘要\` -->`);
    return parts.join("\n");
  }

  // 单文件形式：条目集合 → 索引化
  const text = readText(filePath);
  if (!text.trim()) return "";
  const entries = parseEntries(text);
  const parts = [`<!-- 项目记忆 · ${cwd} · 单文件形式：${entries.length} 条，按行号 read ${filePath} -->`];
  for (const e of entries) parts.push(`- [${e.date}] ${e.title}（L${e.line}）`);
  parts.push("", `<!-- 写入本层：在本文件末尾按分组追加一行 \`- [YYYY-MM-DD] 事实\` -->`);
  return parts.join("\n");
}
