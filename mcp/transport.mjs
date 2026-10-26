#!/usr/bin/env node
/**
 * transport.mjs — MCP stdio 传输层（零第三方依赖）
 *
 * MCP 规范要求：消息由换行（\n）分隔，且单条消息不得含内嵌换行。
 * 出站用 JSON.stringify（不产生裸换行）+ '\n'；入站以换行分隔为主，
 * 并兼容历史 Content-Length 帧（LSP 风格，旧宿主/自测可回退）。
 *
 * 与协议层解耦：本文件只负责「字节流 ↔ 消息对象」，不关心 method/result/error。
 */

/** 出站编码：JSON 对象 → 换行分隔的一帧。 */
export function encodeMessage(obj) {
  return JSON.stringify(obj) + '\n';
}

/** 构造 send 函数（写 stdout，失败仅记录，绝不抛到协议层）。 */
export function createSender(log) {
  return function send(obj) {
    try { process.stdout.write(encodeMessage(obj)); }
    catch (e) { log && log('stdout write failed', e && e.message); }
  };
}

function tryParse(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * 从累积 Buffer 中尽可能多地解析出完整帧。
 * @returns {{ messages: Array, rest: Buffer }}
 *   messages：本次新解析出的完整消息；rest：剩余未完整的字节。
 */
export function decodeFrames(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const s = rest.toString('utf8');
    // 兼容：Content-Length 头（历史 LSP 风格帧）
    const header = s.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
    if (header) {
      const headerLen = header[0].length;
      const bodyLen = Number(header[1]);
      if (rest.length >= headerLen + bodyLen) {
        const body = rest.subarray(headerLen, headerLen + bodyLen);
        rest = rest.subarray(headerLen + bodyLen);
        const msg = tryParse(body.toString('utf8'));
        if (msg) messages.push(msg);
        continue;
      }
      return { messages, rest };
    }
    // 标准：换行分隔
    const nl = s.indexOf('\n');
    if (nl !== -1) {
      const line = s.slice(0, nl);
      rest = rest.subarray(nl + 1);
      const msg = tryParse(line);
      if (msg) messages.push(msg);
      continue;
    }
    return { messages, rest };
  }
}
