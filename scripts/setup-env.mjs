#!/usr/bin/env node
/**
 * 环境自检 / 部署助手
 *
 * 用途：把 skill 目录拷到一台**新机器**后，先跑这个脚本，一次看清
 *       「缺什么、能不能跑、下一步做什么」。所有检查项都是只读的，
 *       除非显式传 --fix（只做建目录 / 写 config.env / 清理过期端点这类无副作用动作）。
 *
 * 用法：
 *   node scripts/setup-env.mjs              人类可读报告
 *   node scripts/setup-env.mjs --json       机器可读（供上层 Agent 解析）
 *   node scripts/setup-env.mjs --fix        自动修复「可修复项」，然后再报告
 *   node scripts/setup-env.mjs --help
 *
 * 退出码：
 *   0 全绿，可直接使用
 *   1 存在**阻塞项**（缺 Node 22+ / 缺浏览器 / 无写权限）——必须先解决
 *   2 存在**需确认项**（如 config.env 未设浏览器偏好、端口被占）——不阻塞但有选择要做
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  knownBrowsers, detectInstalledBrowsers, browserExeCandidates, findBrowserExe,
  copyProfileDir, endpointPathFor, checkPort,
} from './browser-discovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CONFIG_PATH = path.join(ROOT, 'config.env');
const CONFIG_TEMPLATE = path.join(ROOT, 'templates', 'config.env.template');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const doFix = args.includes('--fix');
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法: node scripts/setup-env.mjs [--json] [--fix]

  --json   输出机器可读 JSON 报告
  --fix    自动修复可修复项（建副本 profile 目录、从模板生成 config.env、清理过期端点文件）
  --help   显示本帮助

退出码: 0=全绿  1=有阻塞项  2=有需确认项`);
  process.exit(0);
}

// ---------------------------------------------------------------- 结果收集
const items = [];
const add = (id, level, title, detail = '', hint = '') => items.push({ id, level, title, detail, hint });
const fixed = [];

// ---------------------------------------------------------------- 1. 平台
function checkPlatform() {
  const p = process.platform;
  const supported = ['win32', 'darwin', 'linux'].includes(p);
  add('platform', supported ? 'ok' : 'fail',
    `运行平台：${p} / ${process.arch}`,
    supported ? `Node ${process.version}` : 'CDP 代理仅适配 win32 / darwin / linux',
    supported ? '' : '请在 Windows / macOS / Linux 上运行');
  return supported;
}

// ---------------------------------------------------------------- 2. Node 版本
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= 22;
  add('node', ok ? 'ok' : 'fail',
    `Node.js ${process.version}`,
    ok ? '满足 >= 22（原生 WebSocket / fetch / AbortSignal.timeout 均可用）' : '版本过低',
    ok ? '' : `本 skill 依赖 Node 22+ 的原生 WebSocket（不引入 npm 依赖）。请安装 Node 22 LTS：https://nodejs.org/ ；或用 nvm/fnm 切版本。当前可执行文件：${process.execPath}`);
  return ok;
}

// ---------------------------------------------------------------- 3. 零第三方依赖（可移植性的前提）
function checkDeps() {
  let files = [];
  try { files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs')); } catch { /* ignore */ }
  const external = new Set();
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      external.add(spec);
    }
  }
  const ok = external.size === 0;
  add('deps', ok ? 'ok' : 'warn',
    '第三方依赖：无',
    ok ? `已扫描 ${files.length} 个脚本，全部只 import node: 内置模块与相对路径 —— 无需 npm install`
       : `发现外部依赖：${[...external].join(', ')}`,
    ok ? '' : '需要 npm install 安装上述依赖后才能运行');
  return ok;
}

// ---------------------------------------------------------------- 4. 可用浏览器
async function checkBrowser() {
  const installed = detectInstalledBrowsers();
  const ids = installed.map((b) => b.id);
  const primary = ids.includes('edge') ? 'edge' : (ids.includes('chrome') ? 'chrome' : ids[0]);

  if (installed.length === 0) {
    const allCandidates = knownBrowsers().flatMap((b) =>
      browserExeCandidates(b.id).map((p) => `    ${b.label}: ${p}`));
    add('browser', 'fail', '浏览器：未找到 Chromium 系浏览器',
      '本 skill 通过 CDP 直连用户的 Edge / Chrome',
      `请先安装 Microsoft Edge 或 Google Chrome。已查找路径：\n${allCandidates.join('\n')}`);
    return { ok: false, primary: null, installed };
  }

  add('browser', 'ok',
    `浏览器：检测到 ${installed.map((b) => b.label).join('、')}`,
    `首选 ${knownBrowsers().find((b) => b.id === primary)?.label || primary}`,
    ids.includes('edge') || ids.includes('chrome') ? '' : '未检测到 Edge/Chrome，Chromium 变体也可用但未做完整验证');

  // config.env 偏好是否指向已安装的浏览器
  let configured = null;
  try {
    const txt = fs.readFileSync(CONFIG_PATH, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0 && t.slice(0, i).trim() === 'WEB_ACCESS_BROWSER') configured = t.slice(i + 1).trim() || null;
    }
  } catch { /* config.env 不存在，下面单独报 */ }

  if (!configured) {
    add('browser-pref', 'warn', `${path.basename(CONFIG_PATH)}：未设置浏览器偏好`,
      '首次运行 check-deps 时会提示二选一',
      doFix ? '' : `可设 WEB_ACCESS_BROWSER=${primary} 固定使用；或直接跑 node scripts/check-deps.mjs --browser ${primary}`);
  } else if (!ids.includes(configured)) {
    add('browser-pref', 'warn', `${path.basename(CONFIG_PATH)}：偏好 "${configured}" 未检测到`,
      `当前已安装：${ids.join('、') || '无'}`,
      `改成已安装的：WEB_ACCESS_BROWSER=${primary}`);
  } else {
    add('browser-pref', 'ok', `${path.basename(CONFIG_PATH)}：偏好 ${configured}`, '与已安装浏览器一致');
  }

  return { ok: true, primary, installed };
}

// ---------------------------------------------------------------- 5. 副本 profile 目录可写
function checkProfileDir(browserId) {
  if (!browserId) {
    add('profile', 'warn', '副本用户目录：跳过', '未确定浏览器', '');
    return false;
  }
  const dir = copyProfileDir(browserId);
  if (!dir) {
    add('profile', 'fail', '副本用户目录：无法确定路径', `browserId=${browserId}`, '');
    return false;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('profile', 'ok', '副本用户目录可写', dir,
      '浏览器会在这里开调试端口，不影响你日常使用的 profile');
    return true;
  } catch (e) {
    add('profile', 'fail', '副本用户目录不可写', `${dir} — ${e.message}`,
      '检查目录权限，或以有写权限的用户运行；也可用 --profile 指定其它目录');
    return false;
  }
}

// ---------------------------------------------------------------- 6. skill 目录写权限（config.env / 日志）
function checkSkillWritable() {
  try {
    const probe = path.join(ROOT, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('writable', 'ok', 'skill 目录可写', ROOT);
    return true;
  } catch (e) {
    add('writable', 'fail', 'skill 目录不可写', `${ROOT} — ${e.message}`,
      'config.env 与端点文件需要写权限；把 skill 放在用户目录下（不要放 Program Files）');
    return false;
  }
}

// ---------------------------------------------------------------- 7. 端口占用
async function checkPorts() {
  const [p9222, p3456] = await Promise.all([checkPort(9222), checkPort(3456)]);
  if (p3456) {
    add('port-proxy', 'ok', '端口 3456：CDP 代理已在运行', '可直接复用（启动成本 0）');
  } else {
    add('port-proxy', 'ok', '端口 3456：空闲', '首次调用时会自动启动代理');
  }
  if (p9222) {
    add('port-browser', 'ok', '端口 9222：浏览器调试端口已开', '可直连');
  } else {
    add('port-browser', 'warn', '端口 9222：无浏览器监听调试端口',
      '尚未启动带调试端口的浏览器',
      '用一键脚本拉起：node scripts/start-session.mjs --url <目标URL>');
  }
}

// ---------------------------------------------------------------- 8. 过期端点文件
function checkStaleEndpoint(browserId) {
  const p = browserId ? endpointPathFor(browserId) : null;
  if (!p) return;
  if (!fs.existsSync(p)) {
    add('endpoint', 'ok', '端点文件：无（首次启动后生成）', p);
    return;
  }
  let ep = {};
  try { ep = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
  const ageMin = ep.ts ? (Date.now() - ep.ts) / 60000 : null;
  if (ageMin !== null && ageMin > 360) {
    if (doFix) { try { fs.unlinkSync(p); fixed.push(`清理过期端点文件 ${p}`); } catch { /* ignore */ } }
    add('endpoint', 'warn', `端点文件已过期（${Math.round(ageMin / 60)} 小时前）`,
      p, doFix ? '已清理' : '可加 --fix 清理；不清理也不影响（代理会做端口活性校验）');
  } else {
    add('endpoint', 'ok', '端点文件有效', `${p}${ageMin !== null ? `（${Math.round(ageMin)} 分钟前）` : ''}`);
  }
}

// ---------------------------------------------------------------- 汇总
const LEVEL_ICON = { ok: '✓', warn: '!', fail: '✗' };
const LEVEL_LABEL = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };

function render() {
  const lines = [];
  lines.push('');
  lines.push('boss-hr-outreach-safe · 环境自检报告');
  lines.push('─'.repeat(72));
  for (const it of items) {
    lines.push(`${LEVEL_ICON[it.level]} [${LEVEL_LABEL[it.level]}] ${it.title}`);
    if (it.detail) lines.push(`          ${it.detail.replace(/\n/g, '\n          ')}`);
    if (it.hint && it.level !== 'ok') lines.push(`          → ${it.hint.replace(/\n/g, '\n            ')}`);
  }
  if (fixed.length) {
    lines.push('');
    lines.push('已自动修复：');
    for (const f of fixed) lines.push(`  · ${f}`);
  }
  lines.push('─'.repeat(72));
  const fails = items.filter((i) => i.level === 'fail');
  const warns = items.filter((i) => i.level === 'warn');
  lines.push(fails.length ? `结论：${fails.length} 项阻塞、${warns.length} 项待确认 —— 先解决 FAIL 项`
    : warns.length ? `结论：可运行，但有 ${warns.length} 项待确认`
    : '结论：全绿，可直接使用');
  if (!fails.length) {
    lines.push('');
    lines.push('下一步：');
    lines.push('  1) node scripts/start-session.mjs --url <目标URL> --page-match <域名关键词> --tid-out ./_tid.txt');
    lines.push('  2) 在浏览器里完成登录（如需），然后按 SKILL.md 的流程操作');
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  checkPlatform();
  checkNode();
  checkDeps();

  if (doFix) {
    // 可修复项：先建目录 / 生成 config.env
    try {
      if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_TEMPLATE)) {
        fs.copyFileSync(CONFIG_TEMPLATE, CONFIG_PATH);
        fixed.push(`从模板生成 ${CONFIG_PATH}`);
      }
    } catch { /* ignore */ }
  } else if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_TEMPLATE)) {
    try {
      fs.copyFileSync(CONFIG_TEMPLATE, CONFIG_PATH);
      fixed.push(`从模板生成 ${CONFIG_PATH}`);
    } catch { /* ignore */ }
  }

  const b = await checkBrowser();
  checkProfileDir(b.primary);
  checkSkillWritable();
  checkStaleEndpoint(b.primary);
  await checkPorts();

  const fails = items.filter((i) => i.level === 'fail').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  const exitCode = fails ? 1 : (warns ? 2 : 0);

  if (asJson) {
    console.log(JSON.stringify({
      ok: !fails,
      exitCode,
      summary: { fails, warns, total: items.length },
      host: { platform: process.platform, arch: process.arch, node: process.version, execPath: process.execPath },
      root: ROOT,
      primaryBrowser: b.primary,
      installedBrowsers: b.installed.map((x) => x.id),
      fixed,
      checks: items,
    }, null, 2));
  } else {
    console.log(render());
  }
  process.exit(exitCode);
}

await main();
