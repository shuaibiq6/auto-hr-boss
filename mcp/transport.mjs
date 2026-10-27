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

/**
 * 从累积 Buffer 中尽可能多地解析出完整帧（字节偏移扫描，避免大 Buffer 全量 toString，T5-4）。
 * @returns {{ messages: Array, rest: Buffer, badFrames: Array }}
 *   messages：本次新解析出的完整消息；
 *   badFrames：非空但 JSON 解析失败的原始行（协议层应按 -32700 应答，T4-4）；
 *   rest：剩余未完整的字节。
 */
export function decodeFrames(buffer) {
  const messages = [];
  const badFrames = [];
  let rest = buffer;
  for (;;) {
    // 兼容：Content-Length 头（历史 LSP 风格帧）——只转 64 字节前缀判定，避免整 Buffer toString
    const header = rest.subarray(0, 64).toString('utf8').match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
    if (header) {
      const headerLen = header[0].length;
      const bodyLen = Number(header[1]);
      if (rest.length >= headerLen + bodyLen) {
        const raw = rest.subarray(headerLen, headerLen + bodyLen).toString('utf8');
        rest = rest.subarray(headerLen + bodyLen);
        if (raw.trim()) { try { messages.push(JSON.parse(raw)); } catch { badFrames.push(raw); } }
        continue;
      }
      return { messages, rest, badFrames };
    }
    // 标准：换行分隔（0x0A 字节扫描）
    const nl = rest.indexOf(0x0a);
    if (nl !== -1) {
      const raw = rest.subarray(0, nl).toString('utf8').trim();
      rest = rest.subarray(nl + 1);
      if (raw) { try { messages.push(JSON.parse(raw)); } catch { badFrames.push(raw); } }
      continue;
    }
    return { messages, rest, badFrames };
  }
}
