#!/usr/bin/env node
/**
 * 一键拉起招聘端自动化会话。
 *
 * 把原来需要 6~8 次工具调用、人工反复试的启动流程压成一条命令：
 *   1) 精确结束占用调试端口的旧浏览器（不影响你日常用的 Edge）
 *   2) 启动带 CDP 的浏览器（lean 瘦身档 + 防遮挡参数），等它真正 READY
 *   3) 启动 CDP 代理，等它 connected
 *   4) 定位目标页面 tab，打印 targetId（并可按需写入文件）
 *
 * 每一步都打印耗时，便于日后回归对比。
 *
 * 2026-10-13 加固（抗中断）：
 *   端口清理由「/json/version 能否解析」升级为「端口是否被监听 + 监听者是否说 CDP」两层判定，
 *   并在启动后加了一次「127.0.0.1 回环自检」。修掉的是这个硬故障：
 *   僵死残留进程占着 IPv4 127.0.0.1:9222（对任何请求都返回 404）→ 旧逻辑判定"浏览器没在跑"
 *   → 不清理 → 新实例抢不到 IPv4 只能绑 IPv6 → 只有 localhost 通 → 代理按端点文件连
 *   127.0.0.1 失败 → 整条链路起不来，且症状极易被误判成"登录失效"。
 *
 * 用法：
 *   node scripts/start-session.mjs
 *   node scripts/start-session.mjs --url https://www.zhipin.com/web/chat/recommend \
 *        --page-match zhipin.com --tid-out ../_tid.txt
 *   node scripts/start-session.mjs --reuse        # 浏览器已在跑就复用，不重启
 *   node scripts/start-session.mjs --no-proxy     # 只起浏览器
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);

if (flag('help')) {
  console.log(`用法: node scripts/start-session.mjs [选项]

  --url <url>         起始页面，默认 https://www.zhipin.com/web/chat/recommend
  --page-match <s>    目标 tab 的 URL 关键词，默认 zhipin.com
  --tid-out <file>    把目标 tab 的 targetId 写入该文件
  --browser <id>      edge（默认）| chrome
  --port <n>          调试端口，默认 9222
  --proxy-port <n>    代理端口，默认 3456
  --reuse             调试端口已活就直接复用，不重启浏览器
  --no-proxy          只起浏览器，不碰代理
  --hold              就绪后**保持阻塞不退出**（关键，见下）
  --no-kill           不结束旧进程（可能与 --reuse 冲突时自便）

⚠️ 关于 --hold（实测踩过）：
   在沙箱/任务系统里以后台任务方式运行时，**任务命令一旦返回，它派生的整棵进程树都会被回收**，
   即使子进程做了 detached + unref 也一样。所以起完就退 = 浏览器和代理立刻被杀。
   加 --hold 让本脚本前台阻塞，浏览器与代理就随这个后台任务一起存活：
   任务结束（或 Ctrl-C）→ 整树回收，环境干净。`);
  process.exit(0);
}

const URL_ = opt('url', 'https://www.zhipin.com/web/chat/recommend');
const PAGE_MATCH = opt('page-match', 'zhipin.com');
const TID_OUT = opt('tid-out');
const BROWSER = opt('browser', 'edge');
const PORT = parseInt(opt('port', '9222'), 10);
const PROXY_PORT = parseInt(opt('proxy-port', '3456'), 10);
const REUSE = flag('reuse');
const NO_PROXY = flag('no-proxy');
const NO_KILL = flag('no-kill');
const HOLD = flag('hold');

const SYS = process.env.SystemRoot || 'C:\\Windows';
const NETSTAT = path.join(SYS, 'System32', 'netstat.exe');
const TASKKILL = path.join(SYS, 'System32', 'taskkill.exe');
const PROXY_LOG = path.join(os.tmpdir(), 'cdp-proxy.log');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(2) + 's';

function pidsOnPort(port) {
  let out = '';
  try { out = execSync(`"${NETSTAT}" -ano -p TCP`, { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return []; }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`:${port} `) && line.includes('LISTENING')) {
      const m = line.trim().match(/(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
  }
  return [...pids];
}

function killPids(pids) {
  for (const pid of pids) {
    try { execSync(`"${TASKKILL}" /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

async function getJson(u, ms) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
    return await r.json();
  } catch { return null; }
}

/**
 * 探测调试端口是否真的"能干活"。
 *
 * 2026-10-13 修复（一次真实故障）：
 *   端口上有一个**僵死的 Edge 后台助手**（`--no-startup-window`）占着 IPv4 127.0.0.1:9222，
 *   它对任何请求都返回 404 —— 于是 `getJson` 解析失败返回 null，被判定成"浏览器没在跑"，
 *   脚本就不做清理；紧接着新浏览器启动时抢不到 IPv4，只能绑到 IPv6，
 *   结果只有 `localhost:9222` 通、`127.0.0.1:9222` 404 → 代理按端点文件连 127.0.0.1 → 连接断开。
 *
 * 所以判定要分两层：**端口有没有监听**（listen）与**监听者是否说 CDP**（valid）。
 */
async function probeVersion(port, host, ms = 1200) {
  const h = host.includes(':') ? `[${host}]` : host;   // IPv6 字面量要加方括号
  try {
    const r = await fetch(`http://${h}:${port}/json/version`, { signal: AbortSignal.timeout(ms) });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, text: text.slice(0, 80), host };
    let info = null;
    try { info = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: !!info?.webSocketDebuggerUrl, status: r.status, info, host, text: text.slice(0, 80) };
  } catch (e) {
    return { ok: false, status: 0, error: e.message.slice(0, 60), host };
  }
}

/** 依次尝试各 host，返回第一个可用的；并附上"全部失败"时的诊断信息 */
async function probeVersionAny(port) {
  const tried = [];
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const r = await probeVersion(port, host);
    tried.push(r);
    if (r.ok) return { ...r, tried };
  }
  return { ok: false, tried, status: tried[0]?.status ?? 0, text: tried[0]?.text };
}

async function main() {
  console.log(`[start] 目标页面 ${URL_}`);
  console.log('');

  // ── 1) 清理旧进程 ──────────────────────────────────────────────────────
  // 「端口有监听」与「监听者会说 CDP」是两件事。只看后者会漏掉僵死残留进程（真实故障来源）。
  let listeners = pidsOnPort(PORT);
  let probe = await probeVersionAny(PORT);
  let browserAlive = probe.ok;

  if (browserAlive && REUSE) {
    console.log(`[1/4] 复用已运行的浏览器 (端口 ${PORT}, ${el()})`);
  } else if (!browserAlive && listeners.length && REUSE) {
    // 要求复用，但端口上的监听者还没进入 CDP 就绪态 —— 先等一会儿，别急着杀
    console.log(`[1/4] 端口 ${PORT} 有监听（PID ${listeners.join(',')}）但 CDP 未就绪，等待最多 10s ...`);
    const dl = Date.now() + 10000;
    while (Date.now() < dl && !browserAlive) {
      await sleep(500);
      probe = await probeVersionAny(PORT);
      browserAlive = probe.ok;
    }
    if (browserAlive) console.log(`      ✓ 已就绪 (${el()})`);
    else console.log(`      ✗ 仍未就绪，将按"残留进程"处理 (${el()})`);
  }

  if (!(browserAlive && REUSE)) {
    if (listeners.length && !NO_KILL) {
      console.log(`[1/4] 结束占用 ${PORT} 的进程 PID ${listeners.join(',')} (${el()})`);
      if (!probe.ok && probe.status) {
        console.log(`      ⚠ 该监听者对 /json/version 返回 HTTP ${probe.status}，不是有效 CDP`);
        console.log(`        （典型是僵死的 Edge 后台助手；不清掉它，新实例只能绑到 IPv6，`);
        console.log(`         于是 127.0.0.1:${PORT} 不通 → 代理按端点文件连接失败）`);
      }
      killPids(listeners);
      await sleep(800);
      // 复查：残留进程常常需要第二刀（或它自己又拉起了 worker）
      listeners = pidsOnPort(PORT);
      if (listeners.length) {
        console.log(`      仍有监听 PID ${listeners.join(',')}，再清一次 ...`);
        killPids(listeners);
        await sleep(800);
        listeners = pidsOnPort(PORT);
      }
      if (listeners.length) {
        console.log(`      ⚠ 端口 ${PORT} 仍被 PID ${listeners.join(',')} 占用 —— 请手工结束它们后重试`);
      } else {
        console.log(`      ✓ 端口 ${PORT} 已释放 (${el()})`);
      }
    } else {
      console.log(`[1/4] 端口 ${PORT} 空闲，无需清理 (${el()})`);
    }
    // 旧代理也要清，否则它会攥着失效的 wsPath
    if (!NO_PROXY) {
      const oldProxy = pidsOnPort(PROXY_PORT);
      if (oldProxy.length) {
        console.log(`      结束旧代理 PID ${oldProxy.join(',')} (${el()})`);
        killPids(oldProxy);
        await sleep(300);
      }
    }
  }

  // ── 2) 启动浏览器并等 READY ────────────────────────────────────────────
  if (browserAlive && REUSE) {
    // 复用时补写端点文件
    const v = await getJson(`http://127.0.0.1:${PORT}/json/version`, 1500);
    if (v?.webSocketDebuggerUrl) {
      const { writeEndpoint } = await import('./browser-discovery.mjs');
      writeEndpoint({ browserId: BROWSER, port: PORT, wsUrl: v.webSocketDebuggerUrl, pid: pidsOnPort(PORT)[0] ?? null });
      console.log(`[2/4] 端点文件已刷新 (${el()})`);
    }
  } else {
    console.log(`[2/4] 启动浏览器（lean 瘦身档）...`);
    const r = spawn(NODE, [
      path.join(HERE, 'launch-browser.mjs'),
      '--browser', BROWSER, '--port', String(PORT), '--url', URL_, '--wait', '60',
    ], { stdio: 'inherit' });
    const code = await new Promise(res => r.on('exit', res));
    if (code !== 0) {
      console.error(`❌ 浏览器未就绪（退出码 ${code}）`);
      process.exit(1);
    }
  }

  // ── 2.5) 回环自检：127.0.0.1 必须真的能说 CDP。
  // 代理是按端点文件连 127.0.0.1 的；若新实例只绑到了 IPv6，这里就会暴露出来，
  // 而不是等到后面"代理连不上"再让人误判成登录失效/被踢。
  const loopback = await probeVersion(PORT, '127.0.0.1', 2500);
  if (!loopback.ok) {
    const alt = await probeVersionAny(PORT);
    console.error(`❌ 127.0.0.1:${PORT} 无法完成 CDP 握手（HTTP ${loopback.status || 0}）。`);
    if (alt.ok) {
      console.error(`   但 ${alt.host}:${PORT} 正常 —— 说明浏览器只绑到了 IPv6（IPv4 端口被别的进程占着）。`);
      console.error(`   占用者 PID：${pidsOnPort(PORT).join(',') || '(未知)'}`);
      console.error(`   处理：结束上述进程（注意不要结束浏览器主进程所在的整棵树以外的无关程序），然后重跑本脚本。`);
    } else {
      console.error('   各 host 均不可用，浏览器可能没起来；请检查上面的启动输出。');
    }
    process.exit(1);
  }

  if (NO_PROXY) {
    console.log(`\n[start] 完成（--no-proxy）总耗时 ${el()}`);
    return;
  }

  // ── 3) 启动代理并等 connected ──────────────────────────────────────────
  console.log(`[3/4] 启动 CDP 代理 ...`);
  const logFd = fs.openSync(PROXY_LOG, 'a');
  const proxy = spawn(NODE, [path.join(HERE, 'cdp-proxy.mjs')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  proxy.unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + 30000;
  let ok = false;
  while (Date.now() < deadline) {
    const h = await getJson(`http://127.0.0.1:${PROXY_PORT}/health`, 1500);
    if (h?.status === 'ok' && h.connected) { ok = true; break; }
    await sleep(250);
  }
  if (!ok) {
    console.error(`❌ 代理 30s 内未连上浏览器。日志: ${PROXY_LOG}`);
    process.exit(1);
  }
  console.log(`      代理就绪 (端口 ${PROXY_PORT}, ${el()})`);

  // ── 4) 定位目标 tab ────────────────────────────────────────────────────
  const targets = await getJson(`http://127.0.0.1:${PROXY_PORT}/targets`, 8000);
  const pages = Array.isArray(targets) ? targets.filter(t => t.type === 'page') : [];
  const hit = pages.find(t => (t.url || '').includes(PAGE_MATCH));
  console.log(`[4/4] 页面 tab 共 ${pages.length} 个 (${el()})`);
  if (!hit) {
    console.log(`      ⚠️ 没有匹配 "${PAGE_MATCH}" 的页面。现有页面：`);
    for (const p of pages) console.log(`        - ${p.url}`);
  } else {
    console.log(`      TID=${hit.targetId}`);
    console.log(`      ${hit.url}`);
    if (TID_OUT) {
      fs.writeFileSync(TID_OUT, hit.targetId, 'utf8');
      console.log(`      已写入 ${TID_OUT}`);
    }
  }

  console.log(`\n[start] ✅ 全部就绪，总耗时 ${el()}`);
  console.log(`        代理 http://127.0.0.1:${PROXY_PORT}   调试端口 ${PORT}`);
  console.log(`        日志 ${PROXY_LOG}`);

  if (!HOLD) {
    console.log('');
    console.log('⚠️  未加 --hold：本进程退出后，浏览器与代理可能被一并回收。');
    console.log('    以后台任务方式使用时请加 --hold。');
    return;
  }

  console.log('');
  console.log('[start] --hold：保持运行中。结束本任务即回收浏览器与代理。');
  const shutdown = (sig) => {
    console.log(`\n[start] 收到 ${sig}，清理进程 ...`);
    if (!NO_PROXY) killPids(pidsOnPort(PROXY_PORT));
    if (!REUSE) killPids(pidsOnPort(PORT));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 长驻：每 30s 打一次心跳，便于日志确认链路还活着
  for (;;) {
    await sleep(30000);
    const h = await getJson(`http://127.0.0.1:${PROXY_PORT}/health`, 2000);
    if (!h?.connected) {
      console.log(`[start] ⚠️ 代理已断开（${new Date().toLocaleTimeString()}），尝试重连 ...`);
      const again = await getJson(`http://127.0.0.1:${PROXY_PORT}/targets`, 8000);
      if (!Array.isArray(again)) console.log('[start] ⚠️ 重连未成功，稍后自动再试');
      else console.log('[start] ✅ 已恢复');
    }
  }
}

main().catch(e => { console.error('[start] 失败:', e); process.exit(1); });
