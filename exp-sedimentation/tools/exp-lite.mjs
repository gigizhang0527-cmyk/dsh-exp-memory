#!/usr/bin/env node
/**
 * exp-lite.mjs — 经验沉淀轻量 CLI（零依赖 · 纯 ESM · node >= 18 · 单文件）
 *
 * 子命令：
 *   init   建库：创建 topics/ projects/ 目录与 README
 *   save   入库：按 ENTRY 格式追加条目（凭据扫描 + 查重）
 *   check  体检：条目格式 / 日期 / 单条长度 / 单片体量 / 重复标题
 *   index  索引：打印片级行 + 条目标题与行号
 *
 * 默认根目录 <cwd>/.exp-memory/，用 --root <路径> 覆盖。
 * 退出码：0 成功；1 用法或参数错误 / check 发现问题；2 凭据红线命中；3 同片同标题重复。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* ---------------- 常量与格式 ---------------- */

const MAX_ENTRY = 400;      // 单条 ≤400 字符
const MAX_SHARD = 12000;    // 单片 ≤12000 字符

// ENTRY：- [YYYY-MM-DD] **短标题** —— 结论
const ENTRY_RE = /^- \[(\d{4}-\d{2}-\d{2})\] \*\*(.+?)\*\*\s*——\s*(.+)$/;
// 项目层索引行：- [标题](文件.md) — 摘要
const INDEX_RE = /^- \[([^\]]+)\]\(([^)]+)\)\s*—\s*(.+)$/;
// 分片首行注释：<!-- 片名 · 关键词1 关键词2 … -->
const HEAD_RE = /^<!--\s*([^·]+?)\s*·\s*(.+?)\s*-->$/;

// 凭据红线八类（命中即拒写，只报模式名，不回显值）
const CREDENTIALS = [
  ['sk-密钥前缀', /\bsk-[A-Za-z0-9_-]{6,}/],
  ['AKIA密钥', /\bAKIA[A-Z0-9]{6,}/],
  ['ghp_令牌', /\bghp_[A-Za-z0-9]{6,}/],
  ['Bearer令牌', /\bBearer[ \t]+\S+/i],
  ['password=', /password\s*=/i],
  ['token=', /token\s*=/i],
  ['passwd=', /passwd\s*=/i],
  ['secret=', /secret\s*=/i],
];

const DOMAIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ---------------- 小工具 ---------------- */

// Windows 路径安全：反斜杠归一化（比较用，统一小写）
const normKey = (p) => String(p).replace(/\\/g, '/').toLowerCase();

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}
const isFuture = (s) => isValidDate(s) && s > todayStr();

function findCredentials(text) {
  for (const [name, re] of CREDENTIALS) {
    const m = re.exec(text);
    if (m) return { name, line: text.slice(0, m.index).split('\n').length };
  }
  return null;
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) opts[key] = true;
        else { opts[key] = next; i++; }
      }
    } else rest.push(a);
  }
  return { cmd: rest[0] || 'help', pos: rest.slice(1), opts };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
const readText = (p) => fs.readFile(p, 'utf8');
async function writeText(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, 'utf8');
}
const splitLines = (text) => text.split(/\r?\n/);

/* ---------------- init ---------------- */

const README_TEXT = `# 经验记忆库（<MEM>）

目录布局（详见 skill exp-sedimentation 的 references/data-model.md）：

\`\`\`
topics/exp-<domain>.md        # ① 全局分片：跨项目共享的经验条目
projects/<slug>/MEMORY.md     # ② 项目层：只在对应工作目录下生效
\`\`\`

约定：
- 分片首行注释：\`<!-- 片名 · 关键词1 关键词2 … -->\`（关键词进索引，决定要不要读这片）。
- 条目格式：\`- [YYYY-MM-DD] **短标题** —— 结论/做法/坑\`，单条 ≤400 字符、标题不带冒号、一条一件事。
- 红线：绝不写密钥/token/密码的值，只写“凭据放在哪里”；记现状不记变迁史。
- 工具：\`node exp-lite.mjs save|check|index\`（--root 指向本目录）。
`;

async function cmdInit(root) {
  const topics = path.join(root, 'topics');
  const projects = path.join(root, 'projects');
  await fs.mkdir(topics, { recursive: true });
  await fs.mkdir(projects, { recursive: true });
  const readme = path.join(root, 'README.md');
  let created = 0;
  if (!(await exists(readme))) { await writeText(readme, README_TEXT); created++; }
  console.log(`[init] 根目录：${normKey(root)}`);
  console.log(`[init] topics/ 与 projects/ 已就绪${created ? '，README.md 已创建' : '（README.md 已存在，未覆盖）'}`);
  return 0;
}

/* ---------------- save ---------------- */

async function cmdSave(root, opts) {
  const domain = String(opts.domain || '').trim().toLowerCase();
  const title = String(opts.title || '').trim();
  const insight = String(opts.insight || '').trim();
  const reuse = opts.reuse ? String(opts.reuse).trim() : '';
  const evidence = opts.evidence ? String(opts.evidence).trim() : '';
  const symptom = opts.symptom ? String(opts.symptom).trim() : '';

  if (!domain || !title || !insight) {
    console.error('[save] 缺少必填参数：--domain / --title / --insight');
    return 1;
  }
  if (!DOMAIN_RE.test(domain)) {
    console.error(`[save] --domain 不合法（只允许 a-z 0-9 与短横线）：${domain}`);
    return 1;
  }

  // 1) 凭据红线扫描（全字段，命中拒绝写入，不回显值）
  const scanText = [title, insight, reuse, evidence, symptom].join('\n');
  const hit = findCredentials(scanText);
  if (hit) {
    console.error(`[save] 凭据红线命中：${hit.name}（第 ${hit.line} 个字段附近），拒绝写入。只写“凭据放在哪里”。`);
    return 2;
  }

  // 2) 组条目（复用/证据作为结论的补充，仍是一条一行）
  let body = insight;
  if (reuse) body += `（复用：${reuse}）`;
  if (evidence) body += `（证据：${evidence}）`;
  const date = todayStr();
  const entry = `- [${date}] **${title}** —— ${body}`;

  const file = path.join(root, 'topics', `exp-${domain}.md`);
  const rel = normKey(path.relative(root, file));

  let text = (await exists(file)) ? await readText(file) : '';
  const lines = splitLines(text).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));

  // 3) 查重：同片已有同标题 → exit 3
  const dup = lines.findIndex((l) => l.includes(`**${title}**`));
  if (dup > -1) {
    console.error(`[save] 同片已有同标题条目（${rel}:${dup + 1}）：「${title}」。请 edit 补一句，不新增重复条目。`);
    return 3;
  }

  // 4) 新片首行写关键词注释
  if (lines.length === 0) {
    const kw = symptom || title;
    lines.push(`<!-- ${domain} · ${kw} -->`, '');
  } else if (!HEAD_RE.test(lines[0].trim())) {
    console.error(`[save] ${rel} 首行不是 ` + '`<!-- 片名 · 关键词 -->`' + ` 注释，请先补首行注释。`);
    return 1;
  }

  lines.push(entry);
  await writeText(file, lines.join('\n') + '\n');

  if (entry.length > MAX_ENTRY) {
    console.error(`[提示] 本条 ${entry.length} 字符 > ${MAX_ENTRY}，建议精简（check 会报超长）。`);
  }
  console.log(`[save] 已入库：${rel}:${lines.length} —— [${date}] ${title}`);
  return 0;
}

/* ---------------- check ---------------- */

async function collectFiles(root) {
  const out = [];
  const topics = path.join(root, 'topics');
  if (await exists(topics)) {
    for (const f of await fs.readdir(topics)) {
      if (f.toLowerCase().endsWith('.md')) out.push({ file: path.join(topics, f), strict: true, kind: 'topics' });
    }
  }
  const projects = path.join(root, 'projects');
  if (await exists(projects)) {
    for (const d of await fs.readdir(projects)) {
      const dir = path.join(projects, d);
      const st = await fs.stat(dir).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      for (const f of await fs.readdir(dir)) {
        if (f.toLowerCase().endsWith('.md')) out.push({ file: path.join(dir, f), strict: false, kind: `projects/${d}` });
      }
    }
  }
  return out;
}

async function cmdCheck(root) {
  const files = await collectFiles(root);
  const problems = [];
  const titleMap = new Map(); // 标题 -> [文件:行]
  let entryCount = 0;

  for (const { file, strict } of files) {
    const rel = normKey(path.relative(root, file));
    const text = await readText(file);
    const lines = splitLines(text);

    if (text.length > MAX_SHARD) {
      problems.push(`[体量] ${rel}：${text.length} 字符 > ${MAX_SHARD}，按子主题拆片并同步首行关键词`);
    }
    if (strict && lines.length > 0 && lines[0].trim() !== '' && !HEAD_RE.test(lines[0].trim())) {
      problems.push(`[格式] ${rel}:1 首行缺少 ` + '`<!-- 片名 · 关键词 -->`' + ` 注释`);
    }

    const seenInFile = new Map(); // 标题 -> 首次行号
    lines.forEach((raw, i) => {
      const ln = i + 1;
      const line = raw.trimEnd();
      const isBullet = line.startsWith('- ');
      const isEntryLine = line.startsWith('- [');
      if (!isBullet) return;
      if (!isEntryLine && !strict) return; // 项目层允许散文项目符号；分片层条目必须合规

      const em = ENTRY_RE.exec(line);
      const im = INDEX_RE.exec(line);
      if (im && !em) return; // 项目层索引行合法

      if (!em) {
        problems.push(`[格式] ${rel}:${ln} 条目格式非法（应为 ` + '`- [YYYY-MM-DD] **短标题** —— 结论`' + `）`);
        return;
      }
      entryCount++;
      const [, date, title, body] = em;
      if (!isValidDate(date)) problems.push(`[日期] ${rel}:${ln} 日期非法：${date}`);
      else if (isFuture(date)) problems.push(`[日期] ${rel}:${ln} 日期在未来：${date}`);
      if (/[:：]/.test(title)) problems.push(`[标题] ${rel}:${ln} 标题含冒号（索引会截断）：「${title}」`);
      if (line.length > MAX_ENTRY) problems.push(`[超长] ${rel}:${ln} 单条 ${line.length} 字符 > ${MAX_ENTRY}`);
      if (!body.trim()) problems.push(`[格式] ${rel}:${ln} 结论为空`);

      const key = title.trim().toLowerCase();
      if (seenInFile.has(key)) {
        problems.push(`[重复] ${rel}:${ln} 与 ${rel}:${seenInFile.get(key)} 同片同标题「${title}」`);
      } else seenInFile.set(key, ln);
      if (!titleMap.has(key)) titleMap.set(key, []);
      titleMap.get(key).push(`${rel}:${ln}`);
    });
  }

  // 跨片同标题（提示级）
  for (const [key, locs] of titleMap) {
    const filesOf = new Set(locs.map((l) => l.split(':')[0]));
    if (filesOf.size > 1) problems.push(`[重复] 跨片同标题「${key}」：${locs.join('、')}`);
  }

  for (const p of problems) console.log(p);
  console.log(`[check] 完成：${files.length} 个文件 / ${entryCount} 条条目 / ${problems.length} 个问题`);
  return problems.length ? 1 : 0;
}

/* ---------------- index ---------------- */

async function cmdIndex(root) {
  const files = await collectFiles(root);
  console.log(`[index] 根目录：${normKey(root)}`);
  if (!files.length) {
    console.log('（空库，先跑 init / save）');
    return 0;
  }
  for (const { file, kind } of files) {
    const rel = normKey(path.relative(root, file));
    const lines = splitLines(await readText(file));
    const head = lines[0] && HEAD_RE.test(lines[0].trim()) ? HEAD_RE.exec(lines[0].trim()) : null;
    const keywords = head ? head[2] : (kind === 'topics' ? '' : '项目层');
    const entries = [];
    let latest = '';
    lines.forEach((raw, i) => {
      const em = ENTRY_RE.exec(raw.trimEnd());
      if (!em) return;
      entries.push({ ln: i + 1, date: em[1], title: em[2] });
      if (em[1] > latest) latest = em[1];
    });
    const size = (await readText(file)).length;
    console.log(`\n${rel} · ${entries.length} 条 · ${size} 字符 · 最新 ${latest || '-'} · ${keywords || '-'}`);
    for (const e of entries) console.log(`  L${e.ln}  [${e.date}] ${e.title}`);
  }
  return 0;
}

/* ---------------- 入口 ---------------- */

function usage() {
  console.log(`exp-lite.mjs — 经验沉淀轻量 CLI（零依赖，node >= 18）

用法：
  node exp-lite.mjs init  [--root <目录>]
  node exp-lite.mjs save  --domain <key> --title "短标题" --insight "结论" \\
                          [--reuse 复用场景] [--evidence 证据] [--symptom 检索词] [--root <目录>]
  node exp-lite.mjs check [--root <目录>]
  node exp-lite.mjs index [--root <目录>]

默认根目录：<cwd>/.exp-memory/
退出码：0 成功；1 参数错误或 check 发现问题；2 凭据红线命中；3 同片同标题重复。`);
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root ? String(opts.root) : path.join(process.cwd(), '.exp-memory'));
  switch (cmd) {
    case 'init': return cmdInit(root);
    case 'save': return cmdSave(root, opts);
    case 'check': return cmdCheck(root);
    case 'index': return cmdIndex(root);
    case 'help':
    case '--help':
    case '-h': usage(); return 0;
    default:
      console.error(`[exp-lite] 未知子命令：${cmd}`);
      usage();
      return 1;
  }
}

main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    console.error('[exp-lite] 运行出错：' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
