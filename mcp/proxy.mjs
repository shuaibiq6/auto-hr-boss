#!/usr/bin/env node
/**
 * proxy.mjs — CDP 代理的薄 HTTP 客户端（Server 只当 HTTP 客户端，不重复实现代理逻辑）
 *
 * cdp-proxy.mjs 是长驻进程，监听 127.0.0.1:3456，暴露约 20 个端点。
 * 这里提供统一的请求封装：NO_PROXY 处理（回环不被外层代理劫持）、超时、
 * JSON / 文本 / 二进制（截图）三类响应的归一化。
 */

import { ok } from './lib.mjs';

// T3-2：本模块只与回环 CDP 代理（127.0.0.1）通信，进程级一次性设置 NO_PROXY，
// 不再在每次请求里临时改/还原（消除并发竞态：某请求的还原可能覆盖另一请求正在用的值）。
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

/** 代理地址（默认 127.0.0.1:3456，可被 config 覆盖）。 */
export function proxyBase(proxy = null) {
  return proxy || process.env.CDP_PROXY_URL || 'http://127.0.0.1:3456';
}

/**
 * @returns {Promise<{status:number, body:any, contentType:string, ok:boolean}>}
 *   body：JSON 可解析时为对象；二进制为 Buffer；否则为字符串。
 */
export async function proxyCall(method, pathname, { body = null, proxy = null, timeoutMs = 30000, acceptJson = false } = {}) {
  try {
    const init = { method, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== null) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(proxyBase(proxy) + pathname, init);
    const contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    let out = buf;
    if (contentType.includes('json')) {
      try { out = JSON.parse(buf.toString('utf8')); } catch { out = buf.toString('utf8'); }
    } else if (contentType.startsWith('text/')) {
      out = buf.toString('utf8');
    } else if (contentType.includes('image')) {
      out = buf;
    } else {
      // 未知类型：尝试 JSON，否则文本
      const s = buf.toString('utf8');
      try { out = JSON.parse(s); } catch { out = s; }
    }
    return { status: res.status, body: out, contentType, ok: res.status >= 200 && res.status < 300 };
  } catch (e) {
    return { status: 0, body: { error: String(e.message).slice(0, 160) }, contentType: '', ok: false };
  }
}

export const proxyGet = (p, proxy) => proxyCall('GET', p, { proxy });
export const proxyPost = (p, body, proxy) => proxyCall('POST', p, { body, proxy });

/** 截图：返回 {image:{data(base64),mimeType}, file} 或抛 E_* 语义。 */
export async function proxyScreenshot({ target = null, file = null, format = 'png', proxy = null } = {}) {
  const q = new URLSearchParams();
  if (target) q.set('target', target);
  if (file) q.set('file', file);
  if (format) q.set('format', format);
  const r = await proxyCall('GET', '/screenshot?' + q.toString(), { proxy, timeoutMs: 30000 });
  if (!r.ok) return { status: r.status, body: r.body };
  if (Buffer.isBuffer(r.body)) {
    return { status: r.status, image: { data: r.body.toString('base64'), mimeType: `image/${format === 'jpeg' ? 'jpeg' : 'png'}` }, file };
  }
  // 写了 file 时返回 {file} JSON
  return { status: r.status, body: r.body, file };
}
