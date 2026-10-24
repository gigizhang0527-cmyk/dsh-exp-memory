#!/usr/bin/env node
// dsh-exp-memory 一键安装脚本（源码 link: 方式，跨 Windows/macOS/Linux）
// 用法：
//   node install.mjs                     # 自动装进 ~/.dsh/profiles/ 下所有 profile + 复制 skill
//   node install.mjs --profile web       # 只装 CLI 的 web profile（desktop 同理）
//   node install.mjs --memory-dir "D:/mem"  # 指定记忆库目录（默认 ~/.dsh/memory）
//   node install.mjs --keep-legacy       # 保留旧 @jipika/dsh-memory（会双注入，不推荐）
//   node install.mjs --no-skill          # 不复制 exp-sedimentation skill
//   node install.mjs --dry-run           # 只打印将做什么，不落盘
// 装完必须完全退出并重开 DSH（插件代码在启动时加载）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes(name);

const DRY = flag("--dry-run");
const KEEP_LEGACY = flag("--keep-legacy");
const WITH_SKILL = !flag("--no-skill");
const ONLY_PROFILE = opt("--profile", null);
const PLUGIN_DIR = path.resolve(opt("--plugin-dir", path.join(SCRIPT_DIR, "dsh-exp-memory")));
const SKILL_DIR = path.resolve(opt("--skill-dir", path.join(SCRIPT_DIR, "exp-sedimentation")));
const HOME = String(os.homedir()).replace(/\\/g, "/");
const MEMORY_DIR = String(opt("--memory-dir", `${HOME}/.dsh/memory`)).replace(/\\/g, "/").replace(/\/+$/, "");
const PROFILES_DIR = `${HOME}/.dsh/profiles`;
const SKILLS_DIR = `${HOME}/.agents/skills`;

const log = (s) => console.log(s);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exit(1);
};

// ── 前置检查 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(PLUGIN_DIR, "package.json")) || !fs.existsSync(path.join(PLUGIN_DIR, "index.js"))) {
  fail(`找不到插件包：${PLUGIN_DIR}（用 --plugin-dir 指定 dsh-exp-memory 目录）`);
}
if (!fs.existsSync(PROFILES_DIR)) fail(`找不到 DSH profile 目录：${PROFILES_DIR}（这台机器装了 DSH 吗？）`);

const profiles = fs
  .readdirSync(PROFILES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(PROFILES_DIR, e.name, "package.json")))
  .map((e) => e.name)
  .filter((n) => (ONLY_PROFILE ? n === ONLY_PROFILE : true));
if (profiles.length === 0) fail(ONLY_PROFILE ? `profile 不存在：${ONLY_PROFILE}` : "没有可安装的 profile");

log(`插件源：${PLUGIN_DIR}`);
log(`记忆库：${MEMORY_DIR}`);
log(`目标 profile：${profiles.join(", ")}${DRY ? "（dry-run，不落盘）" : ""}`);
if (profiles.length > 1) {
  log(`⚠ 检测到多个 profile（${profiles.join(", ")}）。若它们会同时跑 DSH，共用一个记忆库可能双注入；`);
  log(`  建议只装实际在用的那个：--profile desktop 或 --profile web。\n`);
} else {
  log("");
}

const linkSpec = `link:${PLUGIN_DIR.replace(/\\/g, "/")}`;

// ── 逐 profile 安装 ─────────────────────────────────────────────────────────
for (const name of profiles) {
  const dir = path.join(PROFILES_DIR, name);
  const pkgPath = path.join(dir, "package.json");
  const patchPath = path.join(dir, "cordis.patch.yml");

  // 1) package.json：加依赖 + 加 bundle；必要时移除旧 dsh-memory bundle
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dependencies = pkg.dependencies ?? {};
  const prevDep = pkg.dependencies["dsh-exp-memory"];
  pkg.dependencies["dsh-exp-memory"] = linkSpec;
  const bundles = (pkg.dsh = pkg.dsh ?? {}).profile = pkg.dsh.profile ?? {};
  const list = (bundles.bundles = bundles.bundles ?? []);
  if (!list.includes("dsh-exp-memory")) list.push("dsh-exp-memory");
  const hadLegacy = list.includes("@jipika/dsh-memory");
  if (hadLegacy && !KEEP_LEGACY) {
    pkg.dsh.profile.bundles = list.filter((b) => b !== "@jipika/dsh-memory");
    log(`  [${name}] 移除旧 bundle @jipika/dsh-memory（防双注入；--keep-legacy 可保留）`);
  }
  if (!DRY) fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  log(`  [${name}] 依赖 ${prevDep ? `更新 ${prevDep} → ` : "新增 "}${linkSpec}`);

  // 2) cordis.patch.yml：幂等追加 insert 行（+ 旧插件禁用行）
  let patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "# exp-memory install.mjs 创建\n";
  if (!/id:\s*exp-memory/.test(patch)) {
    patch += [
      "",
      "# ── exp-memory 经验沉淀（install.mjs 追加）─────────────────────────────",
      "- insert:",
      "    - id: exp-memory",
      "      name: 'dsh-exp-memory'",
      "      config:",
      `        memoryDir: '${MEMORY_DIR}'`,
    ].join("\n");
    if (hadLegacy && !KEEP_LEGACY && !/id:\s*dsh-memory/.test(patch)) {
      patch += ["- id: dsh-memory", "  disabled: true"].join("\n");
    }
    patch += "\n";
    if (!DRY) fs.writeFileSync(patchPath, patch, "utf8");
    log(`  [${name}] cordis.patch.yml 追加 exp-memory 行（memoryDir=${MEMORY_DIR}）`);
  } else {
    log(`  [${name}] cordis.patch.yml 已有 exp-memory 行，跳过`);
  }

  // 3) pnpm install 链接依赖
  if (DRY) {
    log(`  [${name}] （dry-run）跳过 pnpm install`);
    continue;
  }
  log(`  [${name}] pnpm install …`);
  const r = spawnSync("pnpm", ["install"], { cwd: dir, shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`  [${name}] pnpm install 失败（exit ${r.status}）。常见原因：没装 pnpm / 网络代理残留。`);
    console.error(`  手动兜底：进 ${dir} 自己跑 pnpm install，然后重启 DSH。`);
  }
}

// ── skill 复制 ──────────────────────────────────────────────────────────────
if (WITH_SKILL) {
  const target = path.join(SKILLS_DIR, "exp-sedimentation");
  if (fs.existsSync(path.join(SKILL_DIR, "SKILL.md"))) {
    if (fs.existsSync(target)) log(`\nskill 已存在：${target}（跳过，要更新请先删掉它）`);
    else {
      if (!DRY) fs.cpSync(SKILL_DIR, target, { recursive: true });
      log(`\nskill 已装：${target}`);
    }
  } else {
    log(`\n（未找到 skill 目录 ${SKILL_DIR}，跳过）`);
  }
}

// ── 收尾提示 ────────────────────────────────────────────────────────────────
log(`
${DRY ? "[dry-run 完成，未做任何修改]" : "安装完成"}。接下来：
1) 完全退出 DSH（含系统托盘）再重开 —— 插件代码只在启动时加载；
2) 验收三条：
   · 新会话提示词出现「全局记忆 · 索引模式」；
   · node -e "fetch('http://127.0.0.1:<GUI端口>/exp-memory/diagnostics').then(r=>r.text()).then(console.log)" 返回 JSON；
   · 干活的回合结束后出现「经验沉淀 · 收尾」提醒。
3) 回滚：把 package.json / cordis.patch.yml 里 exp-memory 相关行删掉（或用备份覆盖），
   bundles 加回旧插件，pnpm install 后重启。`);
