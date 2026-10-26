#!/usr/bin/env node
/**
 * CDP 副本 profile 瘦身
 *
 * 背景：launch-browser.mjs 用的是「把日常 profile 复制一份」的方案，
 * 复制时剔除的缓存目录会随着使用重新长出来，再加上 Edge 的组件缓存与遥测数据，
 * 副本会从最初的 ~240MB 膨胀到 800MB+。
 *
 * 设计原则（保守，宁可少删）：
 *   1. 只删「可再生 + 与登录态无关」的东西：缓存、遥测、组件包、崩溃转储、扩展状态。
 *   2. 绝不碰 Default/Network/Cookies（BOSS 登录态在这里）、Login Data、
 *      Preferences、Secure Preferences、Local State、Local Storage、
 *      IndexedDB、Service Worker。
 *   3. 应用前先把登录态相关文件复制到同级备份目录。
 *   4. 浏览器运行时拒绝执行。
 *
 * 用法：
 *   node scripts/slim-profile.mjs                 # 干跑，只列出将删除的项
 *   node scripts/slim-profile.mjs --apply         # 备份登录态后执行清理
 *   node scripts/slim-profile.mjs --profile D:\x  # 指定 profile
 *   node scripts/slim-profile.mjs --apply --no-backup
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);

if (flag('help')) {
  console.log(`用法: node scripts/slim-profile.mjs [选项]

  --profile <dir>   目标 profile，默认 %LOCALAPPDATA%\\EdgeCDP
  --apply           真正执行清理（默认只干跑）
  --no-backup       跳过登录态备份（不推荐）
  --port <n>        用于判断浏览器是否在运行，默认 9222`);
  process.exit(0);
}

const PROFILE = opt('profile') || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'EdgeCDP');
const APPLY = flag('apply');
const DO_BACKUP = APPLY && !flag('no-backup');
const PORT = parseInt(opt('port', '9222'), 10);

// ── 待清理清单（相对 profile 根的路径）────────────────────────────────────
// 每一项都注明类别，便于日后审计。
const JUNK = [
  // Edge 组件包：--disable-component-update 后不会再被下载，留着只是占地方
  'component_crx_cache',
  'EdgeLanguageDetectionModel',
  'Speech Recognition',
  'Edge Sidebar',
  // Edge 遥测 / 数据采集
  'ProvenanceData',
  'ProvenanceDataTensors',
  'Edge Entity Extraction',
  'Default/EntityExtraction',
  'Default/WebAssistDatabase',
  // 崩溃转储 / 指标
  'BrowserMetrics',
  'BrowserMetrics-spare.pma',
  'Default/favorites_diagnostic.log.old',
  // 纯缓存
  'Default/Cache',
  'Default/GPUCache',
  'Default/image_cache',
  'GrShaderCache',
  'ShaderCache',
  // Edge 商城类组件
  'Edge Wallet',
  'Edge Shopping',
  // 统计库（单个 61MB，只记站点加载性能）
  'Default/load_statistics.db',
  'Default/load_statistics.db-wal',
  'Default/load_statistics.db-shm',
  // 与扩展/同步相关（lean 档已 --disable-extensions / --disable-sync）
  'Default/Extension State',
  'Default/ExtensionActivityEdge',
  'Default/Sync Data',
  // 安全浏览订阅列表（体积小，列出仅为透明；默认不删）
  // 'Subresource Filter', 'Safe Browsing', 'Typosquatting', 'SmartScreen',
];

// 显式保护：出现任何一条被误列，直接中止
const PROTECTED = [
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/IndexedDB',
  'Default/Service Worker',
  'Local State',
];

// ── 工具 ──────────────────────────────────────────────────────────────────
function dirSize(p) {
  let bytes = 0, files = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) stack.push(f);
      else { try { bytes += fs.statSync(f).size; files++; } catch { /* ignore */ } }
    }
  }
  try { const st = fs.statSync(p); if (st.isFile()) { bytes += st.size; files += 1; } } catch { /* ignore */ }
  return { bytes, files };
}

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

function checkPort(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(t); try { s.destroy(); } catch {} resolve(v); } };
    const s = net.createConnection(port, '127.0.0.1');
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(PROFILE)) {
    console.error(`profile 不存在: ${PROFILE}`);
    process.exit(1);
  }

  if (await checkPort(PORT)) {
    console.error(`❌ 端口 ${PORT} 上有浏览器在运行，文件被占用。请先关闭再看。`);
    console.error(`   结束命令: taskkill /F /T /PID <占用该端口的 PID>`);
    process.exit(1);
  }

  const before = dirSize(PROFILE);
  console.log(`profile : ${PROFILE}`);
  console.log(`当前体积: ${mb(before.bytes)} / ${before.files} 文件`);
  console.log('');

  const targets = [];
  for (const rel of JUNK) {
    const abs = path.join(PROFILE, ...rel.split('/'));
    if (PROTECTED.some(p => rel === p || rel.startsWith(p + '/'))) {
      console.error(`⛔ 内部错误：${rel} 命中保护名单，已跳过`);
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    const { bytes, files } = dirSize(abs);
    targets.push({ rel, abs, bytes, files });
  }
  targets.sort((a, b) => b.bytes - a.bytes);

  const totalBytes = targets.reduce((s, t) => s + t.bytes, 0);
  console.log(`将清理 ${targets.length} 项，共 ${mb(totalBytes)}：`);
  console.log('');
  for (const t of targets) {
    console.log(`  ${mb(t.bytes).padStart(10)}  ${String(t.files).padStart(6)} 文件  ${t.rel}`);
  }
  console.log('');
  console.log(`清理后预计: ${mb(before.bytes - totalBytes)} / ${before.files - targets.reduce((s, t) => s + t.files, 0)} 文件`);
  console.log('保护名单（不会被动）:');
  for (const p of PROTECTED) console.log(`  ✓ ${p}`);
  console.log('');

  if (!APPLY) {
    console.log('（干跑模式，未做任何修改。加 --apply 执行）');
    return;
  }

  // 1) 备份登录态
  if (DO_BACKUP) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(path.dirname(PROFILE), `${path.basename(PROFILE)}-login-backup-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    let n = 0;
    for (const rel of PROTECTED) {
      const src = path.join(PROFILE, ...rel.split('/'));
      if (!fs.existsSync(src)) continue;
      const dst = path.join(backupDir, ...rel.split('/'));
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true });
        n += 1;
      } catch (e) {
        console.error(`  ⚠️ 备份失败 ${rel}: ${e.message}`);
      }
    }
    console.log(`✅ 登录态已备份 ${n} 项 → ${backupDir}`);
    console.log('');
  }

  // 2) 删除
  let removed = 0, failed = 0;
  for (const t of targets) {
    try {
      fs.rmSync(t.abs, { recursive: true, force: true });
      removed += t.bytes;
    } catch (e) {
      failed += 1;
      console.error(`  ❌ 删除失败 ${t.rel}: ${e.message}`);
    }
  }

  const after = dirSize(PROFILE);
  console.log('');
  console.log(`✅ 已释放 ${mb(removed)}${failed ? `（${failed} 项失败）` : ''}`);
  console.log(`现在体积: ${mb(after.bytes)} / ${after.files} 文件  （原 ${mb(before.bytes)} / ${before.files}）`);
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
