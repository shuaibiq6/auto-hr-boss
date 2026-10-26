#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常浏览器（Chrome / Edge / Chromium 等）
// 要求：浏览器已开启 remote debugging（chrome://inspect#remote-debugging toggle）
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { selectBrowser, findFallbackPort } from './browser-discovery.mjs';

// --- 解析命令行 --browser 参数（本次启动用哪个浏览器）---
function parseBrowserArg() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--browser=')) return argv[i].slice('--browser='.length);
  }
  return null;
}
const BROWSER_OVERRIDE = parseBrowserArg();

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
let ws = null;
let cmdId = 0;
const pending = new Map(); // id -> {resolve, timer}
const sessions = new Map(); // targetId -> sessionId
const managedTabs = new Map(); // targetId -> { lastAccessed: number }
const TAB_IDLE_TIMEOUT = parseInt(process.env.CDP_TAB_IDLE_TIMEOUT || '900000'); // 15 min default
const CLEANUP_INTERVAL = 60000; // sweep every 60s

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// proxy 启动时连接到的浏览器（用于 /health 暴露给 check-deps 比较）
let connectedBrowser = null; // { id, label, source }

// pin 首次成功连接的浏览器 id。重连时只接受同一 id，避免悄悄降级到别的浏览器。
let pinnedBrowserId = null;

// --- 跨 iframe 元素解析 ---
// 部分站点把主体内容放在同源 iframe 里（如 BOSS 招聘端：/web/frame/search/、/web/frame/recommend/），
// 此时 document.querySelector 拿不到任何内容，表现为「选择器写对了却报未找到元素」。
// 解析规则：
//   1. 普通 CSS 选择器 —— 先查顶层文档；未命中则递归遍历同源 iframe（最多 4 层）
//   2. "frame:<src子串> ||| <选择器>" —— 指定 iframe，避免多个 frame 命中同一选择器
// 返回 { el, x, y }，其中 x/y 是该元素所属 frame 链在顶层视口中的偏移，
// 真实点击坐标 = x + rect.left + width/2（CDP Input 事件的坐标是顶层视口坐标系）。
const DEEP_RESOLVER = `
function __resolveDeep(sel) {
  let frameHint = null, css = sel;
  const sep = sel.indexOf('|||');
  if (sep !== -1) {
    const head = sel.slice(0, sep).trim();
    css = sel.slice(sep + 3).trim();
    if (head.indexOf('frame:') === 0) frameHint = head.slice(6).trim();
  }
  function scan(doc, ox, oy, depth) {
    if (depth > 4) return null;
    try { const el = doc.querySelector(css); if (el) return { el, x: ox, y: oy }; } catch (e) {}
    let frames;
    try { frames = doc.querySelectorAll('iframe'); } catch (e) { return null; }
    for (const f of frames) {
      if (frameHint && (f.src || '').indexOf(frameHint) === -1) continue;
      let d = null;
      try { d = f.contentDocument; } catch (e) { continue; }
      if (!d) continue;
      const r = f.getBoundingClientRect();
      let bl = 0, bt = 0;
      try {
        const cs = f.ownerDocument.defaultView.getComputedStyle(f);
        bl = parseFloat(cs.borderLeftWidth) || 0;
        bt = parseFloat(cs.borderTopWidth) || 0;
      } catch (e) {}
      const hit = scan(d, ox + r.left + bl, oy + r.top + bt, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  return scan(document, 0, 0, 0);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// 拟人鼠标轨迹
//
// 为什么不是直线插值：直线 + 匀速是机器人最好抓的特征——速度剖面平坦、路径零曲率。
// 真人鼠标有三个可观测特征，这里三条都做：
//   ① 路径带弧（三次贝塞尔，控制点随机偏到连线两侧）
//   ② 速度非匀速（ease-out：起步快、接近目标时明显减速）
//   ③ 末段微过冲再回正（对应"瞄准后修正"）
// 另外每段停顿带随机抖动，避免固定节奏。
// ─────────────────────────────────────────────────────────────────────────────
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function bezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

// 派发一条拟人化鼠标移动轨迹（全部 trusted 事件）。返回轨迹元信息。
async function humanMoveTo(sid, from, to) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(4, Math.min(26, Math.round(dist / 38) + 4));
  // 控制点：在连线法线方向随机偏移 → 弧线；偏移量随距离增大但有上限
  const bow = Math.min(90, Math.max(14, dist * 0.18));
  const side = Math.random() < 0.5 ? -1 : 1;
  const nx = -(to.y - from.y) / (dist || 1);
  const ny = (to.x - from.x) / (dist || 1);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const c1 = {
    x: from.x + (mid.x - from.x) * 0.4 + nx * bow * side * (0.6 + Math.random() * 0.6),
    y: from.y + (mid.y - from.y) * 0.4 + ny * bow * side * (0.6 + Math.random() * 0.6),
  };
  const c2 = {
    x: mid.x + (to.x - mid.x) * 0.6 + nx * bow * side * (0.3 + Math.random() * 0.5),
    y: mid.y + (to.y - mid.y) * 0.6 + ny * bow * side * (0.3 + Math.random() * 0.5),
  };

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = 1 - Math.pow(1 - t, 2.6);      // ease-out 立方
    const p = bezierPoint(from, c1, c2, to, e);
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(p.x + (Math.random() - 0.5) * 2),
      y: Math.round(p.y + (Math.random() - 0.5) * 2),
      button: 'none', buttons: 0,
    }, sid);
    await sleepMs(Math.round(8 + Math.random() * 22 + t * 26));   // 前段快、末段慢
  }

  let extra = 0;
  if (dist > 40) {   // 末段过冲 + 回正
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(to.x + (Math.random() - 0.5) * 5),
      y: Math.round(to.y + (Math.random() - 0.5) * 5),
      button: 'none', buttons: 0,
    }, sid);
    await sleepMs(Math.round(20 + Math.random() * 40));
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(to.x), y: Math.round(to.y), button: 'none', buttons: 0,
    }, sid);
    extra = 2;
  }
  return { steps: steps + extra, path: 'bezier', dist: Math.round(dist) };
}

// 在指定坐标完成一次"真人式"点击：hover 停留（瞄准）→ press → 随机按住时长 → release。
async function humanClickAt(sid, x, y, from) {
  const start = from || { x: Math.round(x * (0.4 + Math.random() * 0.4)), y: Math.round(y * (0.5 + Math.random() * 0.4)) };
  const trail = await humanMoveTo(sid, start, { x, y });
  await sleepMs(Math.round(60 + Math.random() * 140));            // 瞄准延迟：落在目标上先停一下
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1,
  }, sid);
  await sleepMs(Math.round(45 + Math.random() * 95));             // 按住时长抖动
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1,
  }, sid);
  return trail;
}

// ─────────────────────────────────────────────────────────────────────────────
// 命中测试 / 遮挡诊断（页面侧）
//
// 返回目标在顶层视口的点击坐标、该坐标处"最顶层命中的元素"是不是目标本身，
// 以及遮挡物的类名与文案、可用的中性关闭按钮坐标。
//
// 关键：这里**不做任何 DOM 改写**（不打 data-agent-target 之类的标记）。
// 早前踩过的坑：为方便选择器命中而打标记，随后"清理辅助函数"把标记清掉，
// 导致重试路径选择器失配 → 报 400。现在改为「一次性算出坐标 → 直接用坐标点击」。
// ─────────────────────────────────────────────────────────────────────────────
const HIT_TEST_JS = DEEP_RESOLVER + `(() => {
  let hit;
  try { hit = __resolveDeep(SELECTOR); } catch (e) { return JSON.stringify({ error: 'resolve-throw:' + e.message }); }
  if (!hit) return JSON.stringify({ error: 'not-found' });

  hit.el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = hit.el.getBoundingClientRect();
  const doc = hit.el.ownerDocument;
  const win = doc.defaultView;
  const localX = r.x + r.width / 2, localY = r.y + r.height / 2;
  const tx = hit.x + localX, ty = hit.y + localY;

  const rect = { w: Math.round(r.width), h: Math.round(r.height) };
  const visible = r.width > 0 && r.height > 0 && win.getComputedStyle(hit.el).visibility !== 'hidden';

  let top = null, hitOk = false, blocker = null;
  try {
    top = doc.elementFromPoint(localX, localY);
    hitOk = !!top && (top === hit.el || hit.el.contains(top) || top.contains(hit.el));
  } catch (e) {}

  // 遮挡物诊断
  if (!hitOk && top) {
    let node = top, cls = '', text = '';
    for (let i = 0; i < 6 && node; i++) {
      const c = String(node.className || '');
      if (c) { cls = c; text = (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160); break; }
      node = node.parentElement;
    }
    blocker = { tag: top.tagName, cls: cls.slice(0, 120), text };

    // 在遮挡物里找一个"中性关闭按钮"（知道了/关闭/取消/确定），只取可见且有尺寸的
    const NEUTRAL = ['知道了', '我知道了', '关闭', '取消', '确定', '好的'];
    const FORBIDDEN = ['不再提示', '不再显示', '不再提醒', '同意'];   // 会改用户账号设置，绝不点
    const root = (() => {
      // 2026-10-09 修复：原实现只从「第一个带 class 的祖先」里找关闭按钮，而 BOSS 回执遮罩
      // 最顶层的命中元素是 .dialog-layer（纯遮罩层，内部没有任何按钮）→ 永远找不到「知道了」
      // → 遮罩永不关闭 → 后续每一轮点击都被 409 拒绝（并让上层把陈旧遮罩误判成发送成功）。
      // 改为：向上寻找最近的「弹窗容器」（.dialog-wrap / *modal* / *popup*），在其内部搜索。
      let scope = node || top;
      for (let n = top, i = 0; n && i < 8; i++, n = n.parentElement) {
        if (/dialog|modal|popup/i.test(String(n.className || ''))) scope = n;
      }
      return scope || node || top;
    })();
    const cands = [...root.querySelectorAll('button,a,[role=button],span,div')]
      .filter((e) => {
        const t = (e.innerText || '').trim();
        return t && e.offsetParent !== null && e.offsetWidth > 0 && e.offsetHeight > 0;
      })
      .map((e) => ({ el: e, t: (e.innerText || '').trim() }))
      .filter((x) => NEUTRAL.includes(x.t) && !FORBIDDEN.some((f) => x.t.includes(f)));
    if (cands.length) {
      const pick = cands[cands.length - 1].el;
      const br = pick.getBoundingClientRect();
      const f = (function findFrame(el) {
        let w = el.ownerDocument.defaultView;
        while (w && w !== w.parent) {
          const fe = w.frameElement;
          if (!fe) break;
          const fr = fe.getBoundingClientRect();
          return { dx: fr.left + (parseFloat(w.getComputedStyle(fe).borderLeftWidth) || 0), dy: fr.top + (parseFloat(w.getComputedStyle(fe).borderTopWidth) || 0) };
        }
        return { dx: 0, dy: 0 };
      })(pick);
      blocker.dismiss = {
        text: (pick.innerText || '').trim(),
        x: f.dx + br.x + br.width / 2,
        y: f.dy + br.y + br.height / 2,
      };
    }
  }

  return JSON.stringify({
    tx: Math.round(tx), ty: Math.round(ty), localX: Math.round(localX), localY: Math.round(localY),
    tag: hit.el.tagName, text: (hit.el.textContent || '').trim().slice(0, 100),
    rect, visible, hitOk, hitTag: top ? top.tagName : null,
    blocker, vw: win.innerWidth, vh: win.innerHeight,
  });
})()`;

// --- 自动发现浏览器调试端口 ---
// 决策完全委派给 browser-discovery.selectBrowser；此处只做日志和返回结构包装。
async function discoverChromePort() {
  const result = await selectBrowser(BROWSER_OVERRIDE);
  if (result.kind === 'ok') {
    if (pinnedBrowserId && pinnedBrowserId !== result.browser.id) {
      throw new Error(
        `本次连接的浏览器已经是 ${pinnedBrowserId}，不会自动切到 ${result.browser.id}。` +
        `如果想换成 ${result.browser.id}，请先在终端运行 pkill -f cdp-proxy.mjs 重置。`
      );
    }
    pinnedBrowserId = result.browser.id;
    connectedBrowser = { id: result.browser.id, label: result.browser.label, source: result.source };
    const tag = result.source === 'override' ? '[--browser 指定]'
      : result.source === 'endpoint' ? '[端点文件直通]'
      : '[config.env 偏好]';
    console.log(`[CDP Proxy] 选用 ${result.browser.label} (端口 ${result.browser.port}${result.browser.wsPath ? '，带 wsPath' : ''}) ${tag}`);
    return { port: result.browser.port, wsPath: result.browser.wsPath, source: result.source };
  }
  // mismatch：有显式偏好但未检测到 —— 硬错，绝不降级
  if (result.kind === 'mismatch') {
    const expected = result.override || result.configured;
    const src = result.source === 'override' ? '本次指定' : '默认偏好';
    throw new Error(
      `${src}的浏览器是 "${expected}"，但没连上。Agent 处理顺序：` +
      `(1) 先用系统命令打开 ${expected}（按平台选择，如 macOS 的 open -a），稍等后重试请求；` +
      `(2) 若仍失败，说明远程调试开关没启用 —— 告知用户在地址栏访问 ${expected}://inspect/#remote-debugging 勾选 "Allow remote debugging for this browser instance"。`
    );
  }
  // 已 pin 过浏览器（如首次连上 edge 后 edge 退出）：拒绝任何 fallback
  if (pinnedBrowserId) {
    throw new Error(
      `本次连接的浏览器是 ${pinnedBrowserId}，但现在没连上。Agent 处理顺序：` +
      `(1) 先用系统命令打开 ${pinnedBrowserId}（按平台选择），稍等后重试请求；` +
      `(2) 若仍失败，告知用户在地址栏访问 ${pinnedBrowserId}://inspect/#remote-debugging 重新勾选允许。` +
      `若想换成其他浏览器，请先在终端运行 pkill -f cdp-proxy.mjs 重置。`
    );
  }
  // 仅在「从未成功连接 + 无偏好/override」时允许固定端口兜底（手动 --remote-debugging-port 启动场景）
  const fallbackPort = await findFallbackPort();
  if (fallbackPort !== null) {
    connectedBrowser = { id: 'unknown', label: '未知（通过手动调试端口连接）', source: 'fallback' };
    console.log(`[CDP Proxy] 通过手动调试端口连接: ${fallbackPort}`);
    // 手动端口兜底时没有 DevToolsActivePort 提供的 wsPath，
    // 必须向 /json/version 查询真实的浏览器级 WebSocket 路径（含实例 UUID），
    // 否则拼出 ws://127.0.0.1:<port>/devtools/browser 会 404 → 握手非 101。
    let wsPath = null;
    try {
      const res = await fetch(`http://127.0.0.1:${fallbackPort}/json/version`, { signal: AbortSignal.timeout(3000) });
      const info = await res.json();
      if (info && info.webSocketDebuggerUrl) {
        wsPath = new URL(info.webSocketDebuggerUrl).pathname;
        console.log(`[CDP Proxy] 已解析浏览器级 wsPath: ${wsPath}`);
      }
    } catch (e) {
      console.error('[CDP Proxy] 查询 /json/version 失败:', e && e.message);
    }
    return { port: fallbackPort, wsPath, source: 'fallback' };
  }
  return null;
}

function getWebSocketUrl(port, wsPath) {
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

// --- WebSocket 连接管理 ---
let chromePort = null;
let chromeWsPath = null;
// 端点的可信度：来自端点文件 / override / 偏好 的端口-路径对是"确定性"的，
// 单次握手失败不该把它丢掉（旧逻辑每次都清空 → 触发全量重发现 → 失败风暴）。
let chromePortReliable = false;

// 指数退避 + 失败计数：避免"失败→立刻全量重发现→又失败"的紧循环。
let connectFailCount = 0;
let nextConnectAllowedAt = 0;
const BACKOFF_BASE_MS = 150;
const BACKOFF_MAX_MS = 2000;

let connectingPromise = null;
async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;
  if (connectingPromise) return connectingPromise;  // 复用进行中的连接

  // 退避门：刚失败过就先等一会儿，不要去撞同一堵墙。
  const wait = nextConnectAllowedAt - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  if (!chromePort) {
    const discovered = await discoverChromePort();
    if (!discovered) {
      throw new Error(
        'Chrome 未开启远程调试端口。请用以下方式启动 Chrome：\n' +
        '  macOS: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n' +
        '  Linux: google-chrome --remote-debugging-port=9222\n' +
        '  或在 chrome://flags 中搜索 "remote debugging" 并启用'
      );
    }
    chromePort = discovered.port;
    chromeWsPath = discovered.wsPath;
    chromePortReliable = discovered.source === 'endpoint' || discovered.source === 'override' || discovered.source === 'preference';
  }

  const wsUrl = getWebSocketUrl(chromePort, chromeWsPath);
  if (!wsUrl) throw new Error('无法获取 Chrome WebSocket URL');

  return connectingPromise = new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      connectingPromise = null;
      connectFailCount = 0;
      nextConnectAllowedAt = 0;
      console.log(`[CDP Proxy] 已连接浏览器 (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      connectingPromise = null;
      ws = null;
      connectFailCount += 1;
      nextConnectAllowedAt = Date.now() + Math.min(BACKOFF_BASE_MS * (2 ** (connectFailCount - 1)), BACKOFF_MAX_MS);

      // 只有"猜出来的"端口才清空重发现；端点文件/显式指定出来的端口保留，
      // 下轮直接用同一个 wsPath 重试（多数失败只是浏览器还没起来）。
      if (!chromePortReliable || connectFailCount >= 3) {
        chromePort = null;
        chromeWsPath = null;
        chromePortReliable = false;
      }
      const msg = e.message || e.error?.message || '连接失败';
      const hint = `（第 ${connectFailCount} 次失败，${Math.min(BACKOFF_BASE_MS * (2 ** (connectFailCount - 1)), BACKOFF_MAX_MS)}ms 后重试）`;
      console.error('[CDP Proxy] 连接错误:', msg, hint);
      reject(new Error(msg));
    };
    const onClose = () => {
      console.log('[CDP Proxy] 连接断开');
      ws = null;
      chromePort = null; // 重置端口缓存，下次连接重新发现
      chromeWsPath = null;
      chromePortReliable = false;
      sessions.clear();
      managedTabs.clear();
    };
    const onMessage = (evt) => {
      const data = typeof evt === 'string' ? evt : (evt.data || evt);
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(targetInfo.targetId, sessionId);
      }
      // 拦截页面对 Chrome 调试端口的探测请求（反风控）
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, sessionId: sid } = msg.params;
        sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid).catch(() => {});
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    }

    // 兼容 Node 原生 WebSocket 和 ws 模块的事件 API
    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    }
  });
}

function sendCDP(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error('WebSocket 未连接'));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 命令超时: ' + method));
    }, 30000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
}

// 已启用端口拦截的 session 集合（避免重复启用）
const portGuardedSessions = new Set();

// 输入事件前确保页面处于激活/可见状态。
// 背景标签页会被渲染器节流，导致 Input.dispatchMouseEvent 永远等不到 ack（表现为挂起）。
async function ensureActive(sid, targetId) {
  let hidden = false;
  try {
    const r = await sendCDP('Runtime.evaluate', {
      expression: 'document.visibilityState === "hidden" || outerWidth === 0',
      returnByValue: true,
    }, sid);
    hidden = !!r.result?.result?.value;
  } catch (e) {
    hidden = true;
  }
  if (!hidden) return false; // 页面本来就可见，不做任何侵入动作
  try { await sendCDP('Page.bringToFront', {}, sid); } catch (e) {}
  try { await sendCDP('Page.setWebLifecycleState', { state: 'active' }, sid); } catch (e) {}
  try {
    const w = await sendCDP('Browser.getWindowForTarget', { targetId });
    const windowId = w.result?.windowId;
    if (windowId !== undefined) {
      await sendCDP('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await sendCDP('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 60, top: 40, width: 1440, height: 900, windowState: 'normal' },
      });
    }
  } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
  return true;
}

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    // 启用调试端口探测拦截
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// 拦截页面对 Chrome 调试端口的探测（反风控）
// 只拦截 127.0.0.1:{chromePort} 的请求，不影响其他任何本地服务
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* Fetch 域启用失败不影响主流程 */ }
}

// --- 闲置 Tab 自动清理 ---
function touchTab(targetId) {
  const entry = managedTabs.get(targetId);
  if (entry) entry.lastAccessed = Date.now();
}

async function cleanupIdleTabs() {
  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;
  const now = Date.now();
  for (const [targetId, info] of managedTabs) {
    if (now - info.lastAccessed < TAB_IDLE_TIMEOUT) continue;
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* tab may already be closed */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
    console.log(`[CDP Proxy] Auto-closed idle tab: ${targetId}`);
  }
}

async function closeAllManagedTabs() {
  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;
  const targets = [...managedTabs.keys()];
  for (const targetId of targets) {
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* ignore */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
  }
  if (targets.length) console.log(`[CDP Proxy] Shutdown: closed ${targets.length} managed tab(s)`);
}

// --- 等待页面加载 ---
async function waitForLoad(
  sessionId,
  timeoutMs = 15000,
  { requireNonBlank = false, acceptInteractive = false } = {},
) {
  // 启用 Page 域
  await sendCDP('Page.enable', {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP('Runtime.evaluate', {
          expression: 'JSON.stringify({ ready: document.readyState, url: location.href })',
          returnByValue: true,
        }, sessionId);
        const value = resp.result?.result?.value;
        const state = typeof value === 'string' ? JSON.parse(value) : null;
        const ready = state?.ready === 'complete' || (acceptInteractive && state?.ready === 'interactive');
        if (ready && (!requireNonBlank || state.url !== 'about:blank')) {
          done('complete');
        }
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);
  if (q.target) touchTab(q.target);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // /health 不需要连接浏览器
    if (pathname === '/health') {
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({
        status: 'ok',
        connected,
        browser: connectedBrowser,
        sessions: sessions.size,
        managedTabs: managedTabs.size,
        chromePort,
      }));
      return;
    }

    await connect();

    // GET /targets - 列出所有页面
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const pages = resp.result.targetInfos.filter(t => t.type === 'page');
      res.end(JSON.stringify(pages, null, 2));
    }

    // POST /new (body=URL) - 创建新后台 tab
    else if (pathname === '/new') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /new 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' http://localhost:3456/new",
        }));
        return;
      }
      const body = (await readBody(req)).trim();
      const targetUrl = body || 'about:blank';
      // 先创建空白页并完成 attach，再显式导航。Target.createTarget({ url }) 会先暴露
      // readyState=complete 的 about:blank，导致慢页面在真正开始加载前被误判为完成。
      const resp = await sendCDP('Target.createTarget', { url: 'about:blank', background: true });
      const targetId = resp.result.targetId;
      managedTabs.set(targetId, { lastAccessed: Date.now() });

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await sendCDP('Page.navigate', { url: targetUrl }, sid);
          await waitForLoad(sid, 15000, { requireNonBlank: true, acceptInteractive: true });
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      managedTabs.delete(q.target);
      res.end(JSON.stringify(resp.result));
    }

    // POST /navigate?target=xxx (body=URL) - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /navigate 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' 'http://localhost:3456/navigate?target=ID'",
        }));
        return;
      }
      const targetUrl = (await readBody(req)).trim();
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: targetUrl }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // POST /eval?target=xxx - 执行 JS
    else if (pathname === '/eval') {
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = DEEP_RESOLVER + `(() => {
        const hit = __resolveDeep(${selectorJson});
        if (!hit) return { error: '未找到元素: ' + ${selectorJson} };
        const el = hit.el;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = DEEP_RESOLVER + `(() => {
        const hit = __resolveDeep(${selectorJson});
        if (!hit) return { error: '未找到元素: ' + ${selectorJson} };
        hit.el.scrollIntoView({ block: 'center' });
        const rect = hit.el.getBoundingClientRect();
        return { x: hit.x + rect.x + rect.width / 2, y: hit.y + rect.y + rect.height / 2, tag: hit.el.tagName, text: (hit.el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // POST /clickHuman?target=xxx — 带拟人鼠标轨迹的真实点击（反自动化检测友好）
    // 路径为三次贝塞尔曲线、速度 ease-out、末段过冲回正，全部 trusted 事件。
    // 返回体含 hitTest，便于调用方区分「事件已发出」与「确实落在目标上」。
    else if (pathname === '/clickHuman') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      await ensureActive(sid, q.target);
      const js = HIT_TEST_JS.replace('SELECTOR', () => JSON.stringify(selector));
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js, returnByValue: true, awaitPromise: true,
      }, sid);
      const raw = coordResp.result?.result?.value;
      let c = null;
      try { c = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { c = null; }
      if (!c || c.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(c || { error: 'eval-failed', raw: String(raw).slice(0, 200) }));
        return;
      }
      const trail = await humanClickAt(sid, c.tx, c.ty);
      res.end(JSON.stringify({
        clicked: true, x: c.tx, y: c.ty, steps: trail.steps, path: trail.path,
        tag: c.tag, text: c.text,
        hitTest: { ok: c.hitOk, blocker: c.blocker || null },
        warn: c.hitOk ? undefined : '坐标处命中的不是目标元素（疑似被遮挡）—— 改用 /clickSafe 可自动处理',
      }));
    }

    // POST /clickSafe?target=xxx — 高可靠点击：命中测试 → 自动关遮罩 → 重测 → 拟人轨迹点击
    // 与 /clickHuman 的区别：clickHuman 只保证「事件发出」，clickSafe 额外保证「落在目标上」。
    // 它在页面侧逐层做遮挡诊断，必要时点掉中性关闭按钮（绝不点「不再提示」这类改设置的动作）。
    // 无法确保命中时返回 409 且不点击 —— 宁可不点，也不制造「输入层全绿、业务层零动作」的假象。
    else if (pathname === '/clickSafe') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      await ensureActive(sid, q.target);

      const evaluate = async () => {
        const js = HIT_TEST_JS.replace('SELECTOR', () => JSON.stringify(selector));
        const resp = await sendCDP('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, sid);
        const rawValue = resp.result?.result?.value;
        try { return typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue; } catch { return null; }
      };

      const notes = [];
      let c = await evaluate();

      // 懒加载/重渲染导致元素暂不可见 → 短暂等待后重试一次
      for (let attempt = 0; attempt < 2 && c && c.error === 'not-found'; attempt++) {
        await sleepMs(700);
        c = await evaluate();
        notes.push('元素未找到，等待 700ms 后重试');
      }
      if (!c || c.error) {
        res.statusCode = 404;
        res.end(JSON.stringify({ clicked: false, error: c?.error || 'eval-failed', notes }));
        return;
      }

      // ① 被遮挡 → 点掉中性关闭按钮（最多一次），然后轮询等待遮挡真正消失
      //    （弹窗关闭常有 200–400ms 过渡动画，点完立刻重测会误判为"仍被遮挡"）
      if (!c.hitOk && c.blocker?.dismiss) {
        notes.push(`被遮挡（${c.blocker.cls || c.blocker.tag}）→ 点「${c.blocker.dismiss.text}」`);
        await humanClickAt(sid, c.blocker.dismiss.x, c.blocker.dismiss.y);
        for (let i = 0; i < 6; i++) {
          await sleepMs(280);
          const cx = await evaluate();
          if (cx && !cx.error) { c = cx; if (c.hitOk) break; }
        }
        if (c.hitOk) notes.push('遮挡已解除');
        else notes.push('关闭按钮已点，但遮挡仍在');
      } else if (!c.hitOk) {
        notes.push(`被遮挡但未找到中性关闭按钮：${JSON.stringify(c.blocker || {}).slice(0, 180)}`);
      }

      // ② 仍未命中 → 不点
      if (!c.hitOk) {
        res.statusCode = 409;
        res.end(JSON.stringify({
          clicked: false, blocked: true, x: c.tx, y: c.ty, tag: c.tag, text: c.text,
          blocker: c.blocker || null, notes,
        }));
        return;
      }

      // ③ 尺寸为 0 / 不可见 → 不点
      if (!c.visible) {
        res.statusCode = 409;
        res.end(JSON.stringify({ clicked: false, invisible: true, x: c.tx, y: c.ty, tag: c.tag, rect: c.rect, notes }));
        return;
      }

      const trail = await humanClickAt(sid, c.tx, c.ty);
      res.end(JSON.stringify({
        clicked: true, x: c.tx, y: c.ty, tag: c.tag, text: c.text,
        steps: trail.steps, path: trail.path, hitTest: { ok: true }, notes,
      }));
    }

    // POST /type?target=xxx — 向输入框输入文本（CDP Input.insertText，事件为 trusted）
    // body 两种写法：
    //   纯文本                              → 输入到当前焦点元素
    //   {"selector":"...","text":"...","replace":true,"enter":false}
    // 为什么不用「赋值 value + dispatchEvent('input')」：那会产生 isTrusted=false 的合成事件，
    // 是风控 SDK 的检测面之一。Input.insertText 走浏览器输入管线，事件为 trusted。
    else if (pathname === '/type') {
      const sid = await ensureSession(q.target);
      const raw = await readBody(req);
      if (!raw) { res.statusCode = 400; res.end(JSON.stringify({ error: 'POST body 需要文本或 JSON' })); return; }
      let opt = { text: raw, replace: false, enter: false, selector: null };
      const trimmed = raw.trim();
      if (trimmed.startsWith('{')) {
        try { opt = Object.assign(opt, JSON.parse(trimmed)); } catch (e) { /* 当纯文本处理 */ }
      }
      await ensureActive(sid, q.target);
      if (opt.selector) {
        const selJson = JSON.stringify(opt.selector);
        const focusJs = DEEP_RESOLVER + `(() => {
          const hit = __resolveDeep(${selJson});
          if (!hit) return { error: '未找到元素: ' + ${selJson} };
          const el = hit.el;
          el.scrollIntoView({ block: 'center' });
          el.focus();
          try {
            if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, (el.value || '').length);
            else if (typeof el.select === 'function') el.select();
          } catch (e) {}
          return { focused: true, tag: el.tagName, value: (el.value === undefined ? '' : String(el.value)) };
        })()`;
        const fr = await sendCDP('Runtime.evaluate', { expression: focusJs, returnByValue: true, awaitPromise: true }, sid);
        const fv = fr.result?.result?.value;
        if (!fv || fv.error) { res.statusCode = 400; res.end(JSON.stringify(fv || fr.result)); return; }
      }
      if (opt.replace) {
        // Ctrl+A → Backspace，用真实按键清空，避免改 DOM
        await sendCDP('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' }, sid);
        await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' }, sid);
        await sendCDP('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' }, sid);
        await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' }, sid);
        await new Promise(r => setTimeout(r, 90));
      }
      await sendCDP('Input.insertText', { text: String(opt.text === undefined ? '' : opt.text) }, sid);
      if (opt.enter) {
        await new Promise(r => setTimeout(r, 140));
        await sendCDP('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' }, sid);
        await sendCDP('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' }, sid);
        await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' }, sid);
      }
      res.end(JSON.stringify({ typed: true, selector: opt.selector || null, text: String(opt.text === undefined ? '' : opt.text), replaced: !!opt.replace, entered: !!opt.enter }));
    }

    // GET /focus?target=xxx[&emu=1] — 恢复并前置浏览器窗口
    // 解决：窗口最小化时 visibilityState=hidden，Chromium 会阻塞 Input 域事件（点击/滚轮挂起）
    else if (pathname === '/focus') {
      const sid = await ensureSession(q.target);
      const out = {};
      await ensureActive(sid, q.target);
      out.activated = true;
      if (q.emu === '1') {
        try {
          await sendCDP('Emulation.setFocusEmulationEnabled', { enabled: true }, sid);
          out.focusEmu = true;
        } catch (e) { out.focusEmuErr = String(e.message); }
      }
      await new Promise(r => setTimeout(r, 600));
      const st = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({vis: document.visibilityState, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight})',
        returnByValue: true,
      }, sid);
      out.state = st.result?.result?.value;
      res.end(JSON.stringify(out));
    }

    // GET /restore-window?target=xxx[&all=1] — 强制恢复窗口（浏览器级 Browser.* 域）
    // 专用场景：窗口被最小化导致 visibilityState=hidden、Input 域命令永久挂起。
    // 与 /focus 的区别：/focus 走 ensureActive（只在检测到 hidden 时才动窗口），
    // 这里**无条件**做一次 getWindowForTarget → normal → activateTarget，
    // 用于 /focus 救不回来的最小化状态（实测踩过）。加 &all=1 会处理所有 page 窗口。
    else if (pathname === '/restore-window') {
      const sid = await ensureSession(q.target);
      const report = [];
      let targets = [q.target];
      if (q.all === '1') {
        try {
          const resp = await sendCDP('Target.getTargets');
          targets = resp.result.targetInfos.filter((t) => t.type === 'page').map((t) => t.targetId);
        } catch (e) { /* 保留默认 */ }
      }
      for (const tid of targets) {
        const row = { target: tid };
        try {
          const w = await sendCDP('Browser.getWindowForTarget', { targetId: tid });
          row.windowId = w.result?.windowId;
          row.before = w.result?.bounds?.windowState;
          if (row.windowId !== undefined && row.before !== 'normal') {
            await sendCDP('Browser.setWindowBounds', { windowId: row.windowId, bounds: { windowState: 'normal' } });
            row.restored = true;
          }
        } catch (e) { row.error = String(e.message).slice(0, 120); }
        try { await sendCDP('Target.activateTarget', { targetId: tid }); row.activated = true; } catch (e) { /* ignore */ }
        report.push(row);
      }
      try { await sendCDP('Page.bringToFront', {}, sid); } catch (e) { /* ignore */ }
      await sleepMs(450);
      let state = null;
      try {
        const st = await sendCDP('Runtime.evaluate', {
          expression: 'JSON.stringify({vis:document.visibilityState, ow:outerWidth, oh:outerHeight})',
          returnByValue: true,
        }, sid);
        state = st.result?.result?.value;
      } catch (e) { /* ignore */ }
      res.end(JSON.stringify({ ok: true, report, state }));
    }

    // GET /mouseMove?target=xxx&steps=8[&selector=<css>] — 派发可信的鼠标移动
    // 不传 selector：在窗口内随机游走（制造自然活动痕迹）
    // 传 selector：带缓动路径移到该元素中心并停住——用于触发 CSS :hover
    //   （大量站点把「联系TA / 打招呼 / 更多操作」做成 hover 才显现，
    //     元素非 hover 时 offsetWidth=0，直接点会落到 (0,0)）
    else if (pathname === '/mouseMove') {
      const sid = await ensureSession(q.target);
      await ensureActive(sid, q.target);
      const dim = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight})',
        returnByValue: true,
      }, sid);
      const d = JSON.parse(dim.result?.result?.value || '{"w":1440,"h":900}');
      const steps = Math.min(30, Math.max(2, parseInt(q.steps || '8')));
      let x = Math.round(d.w * (0.15 + Math.random() * 0.6));
      let y = Math.round(d.h * (0.2 + Math.random() * 0.5));

      if (q.selector) {
        const selJson = JSON.stringify(q.selector);
        const js = DEEP_RESOLVER + `(() => {
          const hit = __resolveDeep(${selJson});
          if (!hit) return { error: '未找到元素: ' + ${selJson} };
          hit.el.scrollIntoView({ block: 'center' });
          const r = hit.el.getBoundingClientRect();
          return { x: hit.x + r.x + r.width / 2, y: hit.y + r.y + r.height / 2, w: r.width, h: r.height, tag: hit.el.tagName };
        })()`;
        const rr = await sendCDP('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, sid);
        const c = rr.result?.result?.value;
        if (!c || c.error) { res.statusCode = 400; res.end(JSON.stringify(c || rr.result)); return; }
        // 与 /clickHuman 共用同一条贝塞尔 + ease-out 轨迹，避免两套动作的统计特征不一致
        const trail = await humanMoveTo(sid, { x, y }, { x: c.x, y: c.y });
        // 停在元素内（不正好是中心，避免每次坐标一致）
        await sendCDP('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(c.x + (Math.random() - 0.5) * Math.max(2, c.w * 0.3)),
          y: Math.round(c.y + (Math.random() - 0.5) * Math.max(2, c.h * 0.3)),
          button: 'none', buttons: 0,
        }, sid);
        res.end(JSON.stringify({ moved: true, steps: trail.steps, path: trail.path, at: 'element', tag: c.tag, target: { x: Math.round(c.x), y: Math.round(c.y) } }));
        return;
      }

      for (let i = 0; i < steps; i++) {
        x = Math.max(5, Math.min(d.w - 5, x + Math.round((Math.random() - 0.5) * 260)));
        y = Math.max(5, Math.min(d.h - 5, y + Math.round((Math.random() - 0.5) * 180)));
        await sendCDP('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y, button: 'none', buttons: 0,
        }, sid);
        await new Promise(r => setTimeout(r, 40 + Math.round(Math.random() * 150)));
      }
      res.end(JSON.stringify({ moved: true, steps, last: { x, y } }));
    }

    // GET /wheel?target=xxx&dy=600&steps=3 — 派发可信滚轮事件（比 window.scrollBy 更像真人）
    else if (pathname === '/wheel') {
      const sid = await ensureSession(q.target);
      await ensureActive(sid, q.target);
      const dy = parseInt(q.dy || '700');
      const steps = Math.min(20, Math.max(1, parseInt(q.steps || '3')));
      const wantBottom = q.to === 'bottom';
      let acc = 0;
      for (let i = 0; i < steps; i++) {
        const jitter = Math.round(dy * (0.6 + Math.random() * 0.8));
        acc += jitter;
        const pos = await sendCDP('Runtime.evaluate', {
          expression: `JSON.stringify({x: Math.round(window.innerWidth * ${0.3 + Math.random() * 0.4}), y: Math.round(window.innerHeight * ${0.35 + Math.random() * 0.3})})`,
          returnByValue: true,
        }, sid);
        const p = JSON.parse(pos.result?.result?.value || '{"x":700,"y":400}');
        await sendCDP('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: jitter, button: 'none', buttons: 0,
        }, sid);
        await new Promise(r => setTimeout(r, 120 + Math.round(Math.random() * 320)));
      }
      if (wantBottom) {
        await new Promise(r => setTimeout(r, 400));
        await sendCDP('Runtime.evaluate', {
          expression: 'window.scrollTo(0, document.body.scrollHeight); "bottom"',
          returnByValue: true,
        }, sid);
      }
      res.end(JSON.stringify({ wheeled: true, steps, totalDelta: acc }));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down'; // down | up | top | bottom
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      const format = q.format || 'png';
      const resp = await sendCDP('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? 80 : undefined,
      }, sid);
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new': 'POST body=URL - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=': 'POST body=URL - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/eval?target=': 'POST body=JS表达式 - 执行 JS',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&file=': 'GET - 截图',
        },
      }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 检查端口是否被占用
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  // 检查是否已有 proxy 在运行
  const available = await checkPortAvailable(PORT);
  if (!available) {
    // 验证已有实例是否健康
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok"')));
        }).on('error', () => resolve(false));
      });
      if (ok) {
        console.log(`[CDP Proxy] 已有实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
    } catch { /* 端口占用但非 proxy，继续报错 */ }
    console.error(`[CDP Proxy] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 运行在 http://localhost:${PORT}`);
    // 启动时尝试连接 Chrome（非阻塞）
    connect().catch(e => console.error('[CDP Proxy] 初始连接失败:', e.message, '（将在首次请求时重试）'));
  });

  // 定时清理闲置 tab
  const cleanupTimer = setInterval(cleanupIdleTabs, CLEANUP_INTERVAL);
  cleanupTimer.unref();

  const shutdown = async (sig) => {
    console.log(`[CDP Proxy] ${sig}, cleaning up...`);
    clearInterval(cleanupTimer);
    await closeAllManagedTabs();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main();
