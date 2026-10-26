#!/usr/bin/env node
/**
 * 启动带 CDP 调试端口的浏览器（Edge / Chrome）。
 *
 * 为什么要用这个脚本而不是手敲命令：
 *
 *   Edge 154+ / Chromium 136+ 拒绝在「默认用户数据目录」上开远程调试端口，
 *   必须指向一个非默认目录（默认用 %LOCALAPPDATA%\<Browser>CDP）。
 *
 *   更隐蔽的是「遮挡检测」：窗口没最小化、标签也在前台，只要窗口被别的窗口完全盖住，
 *   Chromium 就把该标签判定为不可见 → 渲染器被节流 → Input 域命令
 *   （Input.dispatchMouseEvent / insertText）等不到 ack，永久挂起。
 *   症状是 /clickHuman、/mouseMove、/wheel 全部超时，而 /eval 一切正常，
 *   极易误诊为"被平台踢了"。运行期无解，只能在启动时用下面三个开关关掉：
 *     --disable-features=CalculateNativeWinOcclusion
 *     --disable-backgrounding-occluded-windows
 *     --disable-renderer-backgrounding
 *
 * 2026-09-30 新增（对应「启动慢」诊断的优化）：
 *   --wait    启动后主动轮询 /json/version，就绪即打印 READY 并写入端点文件
 *             %LOCALAPPDATA%\<Browser>CDP\.cdp-endpoint.json。
 *             代理优先读这个文件，彻底绕开「哪个 DevToolsActivePort 是真的」猜测链。
 *   --lean    瘦身启动档（**默认开启**）：关掉组件更新、后台网络、同步、断点上报、
 *             扩展、默认应用等与自动化无关的重服务。用 --no-lean 关闭。
 *
 * 用法：
 *   node scripts/launch-browser.mjs                          # 默认 Edge + 9222 + 空白页
 *   node scripts/launch-browser.mjs --url https://www.zhipin.com/web/chat/recommend
 *   node scripts/launch-browser.mjs --port 9333 --browser chrome --profile D:\cdp-profile
 *   node scripts/launch-browser.mjs --no-lean                # 不瘦身（回归对照用）
 *   node scripts/launch-browser.mjs --no-wait                # 不等就绪，spawn 完就退
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writeEndpoint, ENDPOINT_FILENAME,
  findBrowserExe, browserExeCandidates, copyProfileDir,
} from './browser-discovery.mjs';

// ---------------------------------------------------------------- 参数解析
const args = process.argv.slice(2);
const opt = (name, def = undefined) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

if (flag('help')) {
  console.log(`用法: node scripts/launch-browser.mjs [选项]

  --browser <edge|chrome>   浏览器，默认 edge
  --port <n>                调试端口，默认 9222
  --url <url>               启动时打开的页面
  --profile <dir>           用户数据目录；默认 %LOCALAPPDATA%\\<Browser>CDP（副本，不动你的日常 profile）
  --no-occlusion-guard      不添加防遮挡参数（默认添加）
  --lean                    瘦身启动档（默认开启）；--no-lean 关闭
  --wait <秒>               等待 CDP 就绪的秒数，默认 60；--no-wait 表示不等待
  --foreground              前台运行（默认后台脱离）

示例:
  node scripts/launch-browser.mjs --url https://www.zhipin.com/web/chat/recommend`);
  process.exit(0);
}

const which = (opt('browser', 'edge') || 'edge').toLowerCase();
const port = parseInt(opt('port', '9222'), 10);
const url = opt('url', '');
const useGuard = !flag('no-occlusion-guard');
const useLean = !flag('no-lean');
const noWait = flag('no-wait');
const waitSec = noWait ? 0 : parseInt(opt('wait', '60'), 10);

// ---------------------------------------------------------------- 定位可执行文件
// 候选表统一在 browser-discovery.mjs（与 setup-env.mjs 共用一份，避免漂移）。
const platform = process.platform;
const exe = findBrowserExe(which);
if (!exe) {
  const list = browserExeCandidates(which);
  console.error(`找不到 ${which} 的可执行文件。候选路径：\n  ${list.join('\n  ')}`);
  console.error(`可用 --browser edge|chrome 切换，或自行用正确路径启动并附上 --remote-debugging-port=${port}。`);
  process.exit(1);
}

// ---------------------------------------------------------------- 用户数据目录
let profile = opt('profile');
if (!profile) {
  profile = copyProfileDir(which) || path.join(os.homedir(), '.cache', `${which}CDP`);
}
mkdirSync(profile, { recursive: true });

// ---------------------------------------------------------------- 组装参数
// 防遮挡 + 瘦身特性必须合并进**同一个** --disable-features（重复传会互相覆盖）。
const DISABLE_FEATURES = ['CalculateNativeWinOcclusion'];
if (useLean) {
  DISABLE_FEATURES.push(
    // Edge 专有重型特性：侧边栏、购物助手、身份/个性化 NTP
    'msEdgeSidebarV2',
    'msEdgeShoppingAssistant',
    'msEdgeIdentityFeature',
    'msPersonalizationNTP',
  );
}

const LEAN_FLAGS = useLean ? [
  '--disable-component-update',        // 关掉 component_crx_cache 的联网与校验
  '--disable-background-networking',   // 关掉后台探测/下载
  '--disable-sync',                    // 关掉账号同步
  '--no-service-autorun',              // 不随系统自启后台服务
  '--disable-domain-reliability',      // 关掉域名可靠性上报
  '--disable-breakpad',                // 不写 BrowserMetrics 崩溃转储
  '--disable-crash-reporter',
  '--no-pings',
  '--disable-client-side-phishing-detection',
  '--disable-extensions',              // 副本 profile 里不需要日常扩展
  '--disable-default-apps',
] : [];

const flags = [
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  ...LEAN_FLAGS,
  `--disable-features=${DISABLE_FEATURES.join(',')}`,
];
if (useGuard) {
  flags.push(
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  );
}
if (url) flags.push(url);

console.log(`浏览器  : ${exe}`);
console.log(`端口    : ${port}   （CDP: http://127.0.0.1:${port}/json/version）`);
console.log(`用户目录: ${profile}   ${opt('profile') ? '' : '（副本目录，不影响你日常使用的浏览器）'}`);
console.log(`防遮挡  : ${useGuard ? '已启用（推荐）' : '已关闭 —— Input 域命令可能永久挂起'}`);
console.log(`瘦身档  : ${useLean ? '已启用' : '已关闭'}`);
if (url) console.log(`起始页面: ${url}`);

const t0 = Date.now();
const child = spawn(exe, flags, {
  detached: !flag('foreground'),
  stdio: 'ignore',
  windowsHide: false,
});
child.unref();

console.log(`\n已启动，PID ${child.pid}。`);

// ---------------------------------------------------------------- 等待就绪 + 落盘端点
async function waitReady() {
  const deadline = Date.now() + waitSec * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const info = await res.json();
        if (info?.webSocketDebuggerUrl) {
          const ep = writeEndpoint({ browserId: which, port, wsUrl: info.webSocketDebuggerUrl, pid: child.pid });
          const ms = Date.now() - t0;
          console.log(`READY  ${(ms / 1000).toFixed(2)}s  port=${port}`);
          console.log(`       ws=${info.webSocketDebuggerUrl}`);
          if (ep) console.log(`       端点文件已写入: ${path.join(profile, ENDPOINT_FILENAME)}`);
          else console.log('       ⚠️ 端点文件写入失败（代理将退回常规发现流程）');
          return true;
        }
      }
    } catch (e) { lastErr = e.message; }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`❌ 等待 ${waitSec}s 仍未就绪${lastErr ? `（最后错误: ${lastErr}）` : ''}`);
  return false;
}

if (noWait) {
  console.log('--no-wait：不等待就绪直接退出。');
  console.log(`下一步：启动 CDP 代理 →  node scripts/cdp-proxy.mjs`);
} else {
  const ok = await waitReady();
  if (ok) {
    console.log(`\n下一步：启动 CDP 代理 →  node scripts/cdp-proxy.mjs`);
    console.log(`验证：  curl --noproxy '*' http://127.0.0.1:${port}/json/version`);
  }
  process.exit(ok ? 0 : 1);
}
