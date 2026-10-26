// 浏览器 CDP 端口发现 + 选择 - 单一职责模块
// 被 check-deps.mjs 和 cdp-proxy.mjs 共享。
//
// 选择规则（resolution）：
//   1. 调用方传入 override 参数（来自命令行 --browser） → 严格模式，找不到则硬错
//   2. config.env 里 WEB_ACCESS_BROWSER 设了 → 严格模式，找不到则硬错
//   3. 都没设 → "ask" 模式，提示调用方询问用户
//
// 不擅自降级：偏好不可用一律硬错，让用户介入。
// 持久态只有 config.env 一处；override 是单次 spawn 通过命令行参数表达，不读 process.env。
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-30 修复「端口拉不起来」的根因（见历史补丁记录 20260930）：
//
//   现象：代理日志反复出现 `Received network error or non-101 status code`，
//         单次启动最多连续失败 12 次，上层 check-deps 最坏等 137 秒。
//
//   根因：**默认用户目录**下的 DevToolsActivePort 是一份"历史遗留"文件。
//         Edge 136+ 根本不允许在默认目录上开远程调试，所以那份文件只可能是旧的；
//         但它的第二行 UUID 会被当成有效 wsPath 使用（本文件旧版 L107 的回退逻辑），
//         于是拼出 /devtools/browser/<早已失效的 uuid> → 404 → 非 101。
//
//   修复三件套：
//     A. 探测顺序改为 **CDP 副本目录优先**，默认目录降为最后兜底；
//     B. 默认目录来源的条目 **永不采用文件里的 UUID**，必须由实时 /json/version 佐证；
//     C. 引入端点文件（launch-browser.mjs 启动后写入），端口+wsPath 直接落盘，绕过猜测链。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(SKILL_ROOT, 'config.env');

// 探测超时：本地回环 TCP 建连在 <1ms 级，2 秒纯属浪费；串行 3 个候选会叠成 12 秒。
const PORT_PROBE_TIMEOUT_MS = 300;
const WS_QUERY_TIMEOUT_MS = 900;

// 端点文件：由 launch-browser.mjs 在确认就绪后写入，代理优先读它。
export const ENDPOINT_FILENAME = '.cdp-endpoint.json';

// 副本 profile 目录名（launch-browser.mjs 用同一套命名）
const COPY_DIRNAME = { edge: 'EdgeCDP', chrome: 'ChromeCDP', chromium: 'ChromiumCDP' };

// 已知支持 chrome://inspect#remote-debugging toggle 的浏览器
// 加新浏览器：只改这里
export function knownBrowsers() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  const mk = (id, label, copyDir, ...defaultDirs) => ({
    id,
    label,
    // 顺序即优先级：CDP 副本目录在前（自动化实际使用的那个），默认目录仅作兜底。
    devToolsPaths: [
      ...(copyDir ? [{ path: path.join(localAppData, copyDir, 'DevToolsActivePort'), kind: 'copy', profileDir: path.join(localAppData, copyDir) }] : []),
      ...defaultDirs.map(p => ({ path: p, kind: 'default', profileDir: path.dirname(p) })),
    ],
  });
  switch (os.platform()) {
    case 'darwin':
      return [
        mk('chrome',        'Chrome',         null, path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort')),
        mk('chrome-canary', 'Chrome Canary',  null, path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort')),
        mk('chromium',      'Chromium',       null, path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort')),
        mk('edge',          'Microsoft Edge', null, path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort')),
      ];
    case 'linux':
      return [
        mk('chrome',   'Chrome',         null, path.join(home, '.config/google-chrome/DevToolsActivePort')),
        mk('chromium', 'Chromium',       null, path.join(home, '.config/chromium/DevToolsActivePort')),
        mk('edge',     'Microsoft Edge', null, path.join(home, '.config/microsoft-edge/DevToolsActivePort')),
      ];
    case 'win32':
      return [
        mk('chrome',   'Chrome',         'ChromeCDP',   path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort')),
        mk('chromium', 'Chromium',       'ChromiumCDP', path.join(localAppData, 'Chromium/User Data/DevToolsActivePort')),
        mk('edge',     'Microsoft Edge', 'EdgeCDP',     path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort')),
      ];
    default:
      return [];
  }
}

// ── 浏览器可执行文件定位 ────────────────────────────────────────────────────
// launch-browser.mjs 与 setup-env.mjs 共用这一份候选表，避免两处硬编码各自漂移。
// 加新路径：只改这里。
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || '';

export const BROWSER_EXE_CANDIDATES = {
  edge: {
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe',
    ],
    darwin: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
    ],
    linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge-beta'],
  },
  chrome: {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${LOCAL_APP_DATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome-beta'],
  },
  chromium: {
    win32: [`${LOCAL_APP_DATA}\\Chromium\\Application\\chrome.exe`],
    darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
  },
};

// 返回该浏览器在当前平台的全部候选路径（找不到也返回，供报错时展示）
export function browserExeCandidates(id) {
  return BROWSER_EXE_CANDIDATES[id]?.[process.platform] || [];
}

// 返回该浏览器可执行文件的真实路径；找不到返回 null
export function findBrowserExe(id) {
  return browserExeCandidates(id).find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// 探测本机装了哪些可用浏览器 → [{ id, label, exe }]
export function detectInstalledBrowsers() {
  return knownBrowsers()
    .map((b) => ({ id: b.id, label: b.label, exe: findBrowserExe(b.id) }))
    .filter((b) => b.exe);
}

// TCP 端口监听检测
// 用 TCP connect 而非 WebSocket，避免触发浏览器的远程调试授权弹窗。
export function checkPort(port, host = '127.0.0.1', timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); try { socket.destroy(); } catch {} resolve(v); } };
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error',   () => done(false));
  });
}

// 读 config.env 文件（不写入 process.env，分清来源）
// 格式：KEY=VALUE，# 开头是注释
function readConfig() {
  const cfg = {};
  let content;
  try { content = fs.readFileSync(CONFIG_PATH, 'utf8'); }
  catch { return cfg; }
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k && v) cfg[k] = v;
  }
  return cfg;
}

// 向端口上的实时实例查询真实的浏览器级 WebSocket 路径（含实例 UUID）。
// 用 HTTP /json/version，不发起 WS upgrade，因此不会触发远程调试授权弹窗。
async function liveWsPath(port, timeoutMs = WS_QUERY_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    const info = await res.json();
    if (info && info.webSocketDebuggerUrl) return new URL(info.webSocketDebuggerUrl).pathname;
  } catch { /* 返回 null，由调用方决定是否降级 */ }
  return null;
}

// ── 端点文件 ────────────────────────────────────────────────────────────────
// 由 launch-browser.mjs 在 /json/version 就绪后写入；代理只需读一个文件，
// 不必再猜"哪个目录的 DevToolsActivePort 是真的"。

export function copyProfileDir(browserId) {
  const dirname = COPY_DIRNAME[browserId];
  if (!dirname) return null;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, dirname);
}

export function endpointPathFor(browserId) {
  const dir = copyProfileDir(browserId);
  return dir ? path.join(dir, ENDPOINT_FILENAME) : null;
}

export function writeEndpoint({ browserId = 'edge', port, wsUrl, pid }) {
  const p = endpointPathFor(browserId);
  if (!p) return null;
  let wsPath = null;
  try { wsPath = new URL(wsUrl).pathname; } catch { return null; }
  const payload = { browserId, port, wsPath, wsUrl, pid: pid ?? null, ts: Date.now() };
  try { fs.writeFileSync(p, JSON.stringify(payload), 'utf8'); return payload; }
  catch { return null; }
}

// 读端点文件；要求「文件未过期」且「端口真的活着」才认。
export async function readEndpoint({ maxAgeMs = 6 * 3600 * 1000 } = {}) {
  for (const browser of knownBrowsers()) {
    const p = endpointPathFor(browser.id);
    if (!p) continue;
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let ep;
    try { ep = JSON.parse(raw); } catch { continue; }
    const port = parseInt(ep.port, 10);
    if (!(port > 0 && port < 65536)) continue;
    if (!ep.ts || Date.now() - ep.ts > maxAgeMs) continue;
    if (!(await checkPort(port))) continue;
    // 端口活着，再用实时 /json/version 校正一次 UUID（实例重启后 UUID 会变）
    const real = await liveWsPath(port);
    const wsPath = real || ep.wsPath || null;
    if (!wsPath) continue;
    return {
      browser: { id: browser.id, label: browser.label, port, wsPath, devToolsPath: p },
      source: 'endpoint',
      endpointPath: p,
      corrected: !!(real && ep.wsPath && real !== ep.wsPath),
    };
  }
  return null;
}

// 返回所有开了 toggle 且端口活的浏览器
async function detectAll() {
  const candidates = [];
  for (const browser of knownBrowsers()) {
    for (const d of browser.devToolsPaths) candidates.push({ browser, ...d });
  }

  // 并发探测：串行会让 3 个浏览器 × 2 次探测叠成秒级。
  const probed = await Promise.all(candidates.map(async (c) => {
    let content;
    try { content = fs.readFileSync(c.path, 'utf8'); }
    catch { return null; }

    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    const port = parseInt(lines[0], 10);
    if (!(port > 0 && port < 65536)) return null;
    if (!(await checkPort(port))) return null;       // 端口没人听 → 文件是遗迹

    const live = await liveWsPath(port);

    // 关键防线：默认用户目录永远不可能开远程调试（Edge 136+ / Chrome 136+ 硬限制），
    // 所以那份文件只可能是历史遗留 —— 它的 UUID 一律不可信，必须有实时佐证。
    if (c.kind === 'default' && !live) return null;

    // 副本目录：/json/version 暂时没起来时，允许用文件值兜底，但要求文件是新的，
    // 否则宁可放弃这个候选，也不要拿一个过期 UUID 去撞 404。
    let fileWsPath = lines[1] || null;
    if (fileWsPath && !/^\/devtools\/browser\/[\w-]+$/.test(fileWsPath)) fileWsPath = null;
    if (fileWsPath) {
      try {
        const ageMs = Date.now() - fs.statSync(c.path).mtimeMs;
        if (ageMs > 600_000) fileWsPath = null;      // 超过 10 分钟 → 不信任
      } catch { fileWsPath = null; }
    }

    const wsPath = live || fileWsPath;
    if (!wsPath) return null;

    return {
      id: c.browser.id,
      label: c.browser.label,
      port,
      wsPath,
      source: live ? 'live' : 'file',
      kind: c.kind,
      devToolsPath: c.path,
      profileDir: c.profileDir,
    };
  }));

  // 去重（同一 browser 可能命中多个目录）：副本目录优先
  const byId = new Map();
  for (const r of probed.filter(Boolean)) {
    const prev = byId.get(r.id);
    if (!prev) { byId.set(r.id, r); continue; }
    if (prev.kind === 'default' && r.kind === 'copy') byId.set(r.id, r);
  }
  return [...byId.values()];
}

// 决策入口
// 参数：override — 调用方解析自命令行 --browser 的值（null 表示未传）
// 返回 { kind, browser?, source?, detected, configured, override? }
//   kind ∈ 'ok' | 'ambiguous' | 'mismatch' | 'empty'
//   source ∈ 'override' | 'preference' | 'endpoint' | undefined
//   ambiguous = 没设偏好 + 至少一个浏览器开了 toggle，需问用户
//   mismatch  = override/配偏好设了但未检测到对应 toggle，硬错
//   empty     = 0 浏览器开 toggle 且未设偏好/override
export async function selectBrowser(override = null) {
  const configured = readConfig().WEB_ACCESS_BROWSER || null;
  const wantId = override || configured;

  // 0. 端点文件直通：最快、最准，但仍要满足 override/偏好 的一致性约束。
  const ep = await readEndpoint();
  const epOk = ep && (!wantId || ep.browser.id === wantId);

  const detected = await detectAll();

  const finish = (browser, source) => ({
    kind: 'ok', browser, source, detected, configured, override: override || undefined,
  });

  if (epOk) {
    // 端点文件命中时，若同浏览器也能被常规探测到，用端点文件（强制 type 一致）
    return finish({ ...ep.browser, endpoint: true, endpointPath: ep.endpointPath }, 'endpoint');
  }

  // 1. 命令行 override（最高优先，单次有效）
  if (override) {
    const match = detected.find(b => b.id === override);
    if (match) return finish(match, 'override');
    return { kind: 'mismatch', source: 'override', detected, configured, override };
  }

  // 2. config.env preference（持久）
  if (configured) {
    const match = detected.find(b => b.id === configured);
    if (match) return finish(match, 'preference');
    return { kind: 'mismatch', source: 'preference', detected, configured };
  }

  // 3. 无偏好 —— 一律询问用户（哪怕 detected 只有一个）
  if (detected.length === 0) {
    return { kind: 'empty', detected, configured };
  }
  return { kind: 'ambiguous', detected, configured };
}

// 兜底：扫描常用固定端口
// 适用场景：用户手动 --remote-debugging-port=9222 启动浏览器，
// 此时 DevToolsActivePort 可能不在默认 user-data-dir。
export async function findFallbackPort() {
  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) return port;
  }
  return null;
}
