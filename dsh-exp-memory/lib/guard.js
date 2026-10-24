// lib/guard.js —— 写入守卫规则引擎（deny / ask / allow+note，零成本，不调用模型）
import {
  ENTRY_RE,
  INDEX_LINE_RE,
  normForCompare,
  parseEntries,
  readText,
  scanSecrets,
  slash,
  validDate,
  ENTRY_WARN_CHARS,
} from "./store.js";

const BASH_MUTATE_RE = /(>>|>\s*[^|&\s]|tee\s|sed\s+-i|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item)/i;

const STALE_RE = /(已卸载|不再使用|已经删除|已停用|已被替换|no longer (used|installed))/;

const deny = (reason) => ({ decision: "deny", reason: `exp-memory write-guard：${reason}` });
const ask = (reason) => ({ decision: "ask", reason: `exp-memory write-guard：${reason}` });

/** 该路径是否归记忆管辖（Windows 反斜杠 + 大小写安全）。 */
export function isMemoryPath(p, root) {
  if (typeof p !== "string" || p.length === 0) return false;
  const n = normForCompare(p);
  const r = normForCompare(root);
  return n === r || n.startsWith(`${r}/`);
}

/** 路径是否属于记忆内部资产（.bak / audit / state 等，禁止工具直改）。 */
function isInternalAsset(p) {
  const base = slash(p).split("/").pop() ?? "";
  return !base.endsWith(".md") || base.endsWith(".md.bak") || /\.(bak|log|json|tmp-\d+)$/.test(base);
}

/**
 * 组装 write/edit 的判定负载。
 * @returns {{path:string, oldText:string, newText:string, added:string[], removed:string[]}|null}
 */
export function buildWritePayload(tool, args) {
  const p = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : null;
  if (!p) return null;
  let oldText = "";
  try {
    oldText = readText(p);
  } catch {
    /* 读不到按空处理 */
  }
  let newText = oldText;
  if (tool === "write") newText = String(args?.content ?? "");
  else if (tool === "edit") {
    const old = String(args?.old_string ?? args?.oldString ?? "");
    const rep = String(args?.new_string ?? args?.newString ?? "");
    const all = Boolean(args?.replace_all ?? args?.replaceAll);
    if (old && oldText.includes(old)) {
      newText = all ? oldText.split(old).join(rep) : oldText.replace(old, rep);
    } else if (!old) {
      newText = rep;
    }
  }
  const oldSet = new Set(oldText.split("\n"));
  const newSet = new Set(newText.split("\n"));
  const added = newText.split("\n").filter((l) => l.trim() && !oldSet.has(l));
  const removed = oldText.split("\n").filter((l) => l.trim() && !newSet.has(l));
  return { path: p, oldText, newText, added, removed };
}

/**
 * 写入规则判定。
 * @returns {{decision:"allow"|"ask"|"deny", reason?:string, notes?:string[]}}
 */
export function runWriteRules({ path: p, oldText, newText, added = [], removed = [] }, root, todayIso) {
  const notes = [];
  const base = slash(p).split("/").pop() ?? "";

  if (isInternalAsset(p)) {
    return deny(`这是 exp-memory 的内部资产（备份/审计/状态文件），不要用工具修改它（${base}）。`);
  }

  const projectIndex = base === "MEMORY.md";

  // 1) 新增条目格式与日期
  for (const line of added) {
    const t = line.trim();
    if (!t.startsWith("-")) continue;
    if (projectIndex && INDEX_LINE_RE.test(t)) continue; // `- [标题](文件.md) — 摘要`
    const m = t.match(ENTRY_RE);
    if (!m) {
      return deny(
        `第 ${JSON.stringify(t.slice(0, 40))}… 新条目格式应为 \`- [YYYY-MM-DD] 事实\`（标题不带冒号）。请修正后重写。`,
      );
    }
    if (!validDate(m[1], todayIso)) {
      return deny(`新增条目日期 ${m[1]} 非法（或在未来）。用今天的日期，格式 \`- [YYYY-MM-DD] 事实\`。`);
    }
  }

  // 2) 凭据红线
  const secrets = scanSecrets((added ?? []).join("\n"));
  if (secrets.length > 0) {
    const listed = secrets.map((s) => `L${s.line}·${s.pattern}`).join("，");
    return deny(`新增内容疑似包含凭据（${listed}）。记忆会随每次请求离开本机，禁止写入任何密钥/token/密码；只允许写「凭据存放在哪里」这类指针。`);
  }

  // 3) 整文件覆写防删史
  const oldEntries = parseEntries(oldText).length;
  const newEntries = parseEntries(newText).length;
  if (oldEntries > 0 && newEntries < oldEntries) {
    return deny(
      `这次整文件覆写会把既有 ${oldEntries} 条记忆删到 ${newEntries} 条。请改用 edit 追加/修订；确要重构先保留全部条目。`,
    );
  }

  // 4) 过时陈述与超长条目（放行但留痕）
  for (const line of added) {
    const t = line.trim();
    if (STALE_RE.test(t)) notes.push(`L 含过时陈述模式：记现状，别记变迁史（“已卸载/不再使用”式句子写完即过期）`);
    if (t.startsWith("-") && t.length > ENTRY_WARN_CHARS) notes.push(`单条超 ${ENTRY_WARN_CHARS} 字符，建议精简；长流程另存专题文件并在条目里指向它`);
    if (notes.length >= 4) break;
  }

  return { decision: "allow", notes };
}

/** bash 是否在改记忆文件（保守转人工）。 */
export function bashTouchesMemory(command, root) {
  const cmd = String(command ?? "").replace(/\\/g, "/");
  if (!BASH_MUTATE_RE.test(cmd)) return false;
  return isMemoryPath(cmd, root) || normForCompare(cmd).includes(normForCompare(root));
}

/** 合并多路决策（deny > ask > allow）。 */
export function mergeDecisions(a, b) {
  const rank = { deny: 3, ask: 2, allow: 1 };
  if (!a) return b;
  if (!b) return a;
  return (rank[b.decision] ?? 0) > (rank[a.decision] ?? 0) ? b : a;
}
