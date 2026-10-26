#!/usr/bin/env node
/**
 * 高可靠点击 + 业务状态轮询 —— cdp-proxy `/clickSafe` 的薄封装
 *
 * 存在的理由（本项目最惨痛的一次教训）：
 *   `/click`、`/clickHuman` 的返回值只说明「鼠标事件已发出」，**不说明业务已执行**。
 *   曾出现「20 轮每轮都返回 clicked:true，实际一个招呼都没发出去」——因为首次成功后
 *   平台弹了全屏遮罩，后续点击全打在遮罩上（事件 isTrusted=true，业务零动作）。
 *
 *   所以正确姿势是两件事同时做：
 *     ① 用 /clickSafe 点击（它做命中测试，被遮挡时不硬点）
 *     ② 用**业务状态**判定成败（节点消失 / 文本变化 / 计数变化），而不是看返回值
 *
 * 作为 CLI（诊断单次点击）：
 *   node scripts/human-click.mjs --selector "button.submit"
 *   node scripts/human-click.mjs --selector "button.submit" --verify "document.querySelectorAll('.btn-greet').length" --expect 12
 *   node scripts/human-click.mjs --selector "button.submit" --json
 *
 * 作为模块（被 greet-batch.mjs 等调用）：
 *   import { pickTarget, clickSafe, waitUntil } from './human-click.mjs';
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_PROXY = process.env.CDP_PROXY_URL || 'http://127.0.0.1:3456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 关闭代理劫持：Node 的 fetch 默认会走环境变量里的 HTTP(S)_PROXY，
// 把 127.0.0.1 的请求也劫持出去（实测踩过）。这里统一显式绕过。
async function noProxyFetch(url, init = {}, timeoutMs = 15000) {
  const prev = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.NO_PROXY = '*'; process.env.no_proxy = '*';
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** 选一个可用 targetId：优先 --target，其次 /targets 里第一个 page 类型标签 */
export async function pickTarget(proxy = DEFAULT_PROXY, explicit = null) {
  if (explicit) return explicit;
  const res = await noProxyFetch(`${proxy}/targets`, {}, 5000);
  const list = await res.json();
  const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page') || (Array.isArray(list) ? list[0] : null);
  if (!page) throw new Error('没有可用的标签页（/targets 为空）');
  return page.id || page.targetId;
}

/** 读页面内一段 JS 的结果（返回解析后的值） */
export async function evalJs(proxy, target, expr, timeoutMs = 20000) {
  const res = await noProxyFetch(`${proxy}/eval?target=${encodeURIComponent(target)}`, {
    method: 'POST', body: expr,
  }, timeoutMs);
  const data = await res.json().catch(() => null);
  const v = data?.value ?? data;
  if (typeof v === 'string' && /^[{[]/.test(v.trim())) { try { return JSON.parse(v); } catch { /* 原样返回 */ } }
  return v;
}

/**
 * 可靠点击：走 /clickSafe。被遮挡/不可见时不点击，返回 ok:false 与诊断。
 * @returns {Promise<{ok:boolean, status:number, body:object}>}
 */
export async function clickSafe({ proxy = DEFAULT_PROXY, target, selector, timeoutMs = 25000 }) {
  const res = await noProxyFetch(`${proxy}/clickSafe?target=${encodeURIComponent(target)}`, {
    method: 'POST', body: selector,
  }, timeoutMs);
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { body = null; }
  return { ok: res.status === 200 && !!body?.clicked, status: res.status, body };
}

/**
 * 轮询等待「业务状态」满足条件。
 * @param expr  一段返回 truthy/falsy 的 JS（在页面内执行）
 * @returns {Promise<{ok:boolean, elapsed:number, last:any, samples:number}>}
 */
export async function waitUntil({ proxy = DEFAULT_PROXY, target, expr, timeoutMs = 15000, intervalMs = 800 }) {
  const t0 = Date.now();
  let last = null, samples = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(intervalMs);
    samples += 1;
    try { last = await evalJs(proxy, target, expr); } catch { continue; }
    if (last) return { ok: true, elapsed: (Date.now() - t0) / 1000, last, samples };
  }
  return { ok: false, elapsed: (Date.now() - t0) / 1000, last, samples };
}

// ---------------------------------------------------------------- CLI
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(`用法: node scripts/human-click.mjs --selector "<css>" [选项]

  --selector <css>   必填，目标元素选择器（支持 "frame:<src子串> ||| <css>" 语法）
  --target <id>      标签页 targetId；省略则自动取第一个 page
  --proxy <url>      代理地址，默认 ${DEFAULT_PROXY}
  --verify <js>      点击后用于判定业务生效的 JS 表达式（返回 truthy 视为成功）
  --timeout <秒>     --verify 的轮询上限，默认 15
  --json             输出 JSON

示例:
  node scripts/human-click.mjs --selector "[data-agent-target=\\"greet\\"]" \\
    --verify "document.querySelector('.btn-continue') ? 1 : 0"`);
    process.exit(argv.length ? 0 : 1);
  }
  const opt = (name, def = null) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
  };
  const selector = opt('selector');
  if (!selector) { console.error('缺少 --selector'); process.exit(1); }
  const proxy = opt('proxy', DEFAULT_PROXY);
  const asJson = argv.includes('--json');

  const target = await pickTarget(proxy, opt('target'));
  const click = await clickSafe({ proxy, target, selector });

  let verify = null;
  const verifyExpr = opt('verify');
  if (click.ok && verifyExpr) {
    verify = await waitUntil({ proxy, target, expr: verifyExpr, timeoutMs: Number(opt('timeout', '15')) * 1000 });
  }

  const result = { target, selector, click, verify };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`目标  : ${target}`);
    console.log(`选择器: ${selector}`);
    if (click.ok) {
      console.log(`点击  : ✓ 命中并点击 @ (${click.body?.x}, ${click.body?.y})　tag=${click.body?.tag}　轨迹=${click.body?.path}/${click.body?.steps} 步`);
      if (click.body?.notes?.length) click.body.notes.forEach((n) => console.log(`        注：${n}`));
    } else {
      console.log(`点击  : ✗ HTTP ${click.status} —— ${click.body?.blocked ? '被遮挡，已拒绝点击' : click.body?.invisible ? '元素不可见' : click.body?.error || '失败'}`);
      if (click.body?.blocker) console.log(`        遮挡物: ${click.body.blocker.tag} .${click.body.blocker.cls}　「${(click.body.blocker.text || '').slice(0, 60)}」`);
      click.body?.notes?.forEach((n) => console.log(`        注：${n}`));
    }
    if (verify) console.log(`业务校验: ${verify.ok ? `✓ ${verify.elapsed.toFixed(1)}s 后生效` : `✗ ${verify.elapsed.toFixed(1)}s 内未生效（采样 ${verify.samples} 次）`}`);
  }
  process.exit(click.ok && (!verify || verify.ok) ? 0 : 1);
}

const invokedDirectly = !!(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invokedDirectly) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
