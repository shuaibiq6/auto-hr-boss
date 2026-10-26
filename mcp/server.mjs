#!/usr/bin/env node
/**
 * server.mjs — MCP stdio 服务端（零第三方依赖，手写 JSON-RPC）
 *
 * 分层：
 *   transport.mjs  传输层（换行分隔 JSON 帧，兼容历史 Content-Length）
 *   本文件         协议层（JSON-RPC 信封 / initialize / tools / resources / prompts / 取消）
 *   tools/*.mjs    能力层（12 个 boss_ 工具 + 安全强制点）
 *
 * R-05 日志纪律：stdout 只承载 MCP JSON-RPC 帧；一切日志走 stderr + <BOSS_MCP_HOME>/logs/server.log。
 * R-06 状态根：BOSS_MCP_HOME 环境变量，默认 ~/.boss-hr-outreach/。
 * 引擎（scripts/）一行不改，全部作为子进程薄封装调用。
 */

import { log, McpError, reqCtx } from './lib.mjs';
import { TOOLS, findTool } from './tools/index.mjs';
import { RESOURCES, RESOURCE_TEMPLATES, readResource } from './resources.js';
import { PROMPTS, getPrompt } from './prompts.js';
import { createSender, decodeFrames } from './transport.mjs';

const SERVER_INFO = { name: 'boss-hr-outreach', version: '1.1.0' };
const SUPPORTED_PROTOCOL = ['2024-11-05', '2025-03-26', '2025-06-18', '2026-07-28'];
const CAPABILITIES = { tools: {}, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } };

const send = createSender(log);

// ─────────────────────────────────────────────────────────── 入站帧循环
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let parsed;
  while ((parsed = decodeFrames(buf))) {
    buf = parsed.rest;
    if (!parsed.messages.length) break;
    for (const msg of parsed.messages) void handleMessage(msg);
  }
});
process.stdin.on('end', () => { log('stdin 关闭，退出'); process.exit(0); });

// ─────────────────────────────────────────────────────────── 请求取消（MCP notifications/cancelled）
const activeRequests = new Map(); // id(string) → { controller }

async function handleMessage(msg) {
  const { method, id, params } = msg || {};
  if (!method) return;

  if (id === undefined || id === null) {
    // 通知（无需响应）
    if (method === 'notifications/cancelled') {
      const requestId = String((params && params.requestId) ?? '');
      const entry = activeRequests.get(requestId);
      if (entry) { log('cancel 请求', requestId); entry.controller.abort(); }
      else log('cancel 未匹配活动请求', requestId);
    }
    return;
  }

  const controller = new AbortController();
  activeRequests.set(String(id), { controller });
  try {
    // 用 AsyncLocalStorage 把 signal 带入底层 runNode（引擎子进程被 SIGTERM 终止）
    const result = await reqCtx.run({ signal: controller.signal }, () => dispatch(method, params || {}));
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: toRpcError(e) });
  } finally {
    activeRequests.delete(String(id));
  }
}

function toRpcError(e) {
  if (e && e.rpcCode) return { code: e.rpcCode, message: e.message, data: e.data };
  if (e instanceof McpError) return { code: -32000, message: e.message, data: { code: e.code, message: e.message, details: e.details, hint: e.hint } };
  return { code: -32603, message: String((e && e.message) || e) };
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      // T2-3：客户端协议未命中时回落到最新支持的版本，而非最旧
      const protocolVersion = SUPPORTED_PROTOCOL.includes(requested) ? requested : SUPPORTED_PROTOCOL[SUPPORTED_PROTOCOL.length - 1];
      log('initialize', 'client protocol=', requested, '→', protocolVersion);
      return {
        protocolVersion,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: 'boss-hr-outreach MCP：招聘端主动触达工具集。任何安全闸门由 Server 强制、不可绕过；live 前必先 dry；结果以 verify 为准。',
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map((t) => {
      const o = { name: t.name, description: t.description, inputSchema: t.inputSchema };
      if (t.title) o.title = t.title;
      if (t.annotations) o.annotations = t.annotations;
      return o;
    }) };
    case 'tools/call': return callTool(params);
    case 'resources/list': return { resources: RESOURCES };
    case 'resources/templates/list': return { resourceTemplates: RESOURCE_TEMPLATES };
    case 'resources/read': return read(params);
    case 'prompts/list': return { prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })) };
    case 'prompts/get': {
      const p = getPrompt(params && params.name, (params && params.arguments) || {});
      if (!p) throw { rpcCode: -32602, message: `未知 prompt：${params && params.name}` };
      return p;
    }
    default:
      throw { rpcCode: -32601, message: `Method not found: ${method}` };
  }
}

function toolResult(r) {
  const content = [];
  if (r && r.image && r.image.data) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
  content.push({ type: 'text', text: (r && r.text) || '' });
  const out = { content, isError: !!(r && r.isError) };
  if (r && r.data !== null && r.data !== undefined) out.structuredContent = r.data;
  return out;
}

async function callTool(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const tool = findTool(name);
  if (!tool) {
    return toolResult({ text: `未知工具：${name}`, data: { code: 'E_BAD_INPUT', message: `未知工具：${name}` }, isError: true });
  }
  log('tool.call', name, JSON.stringify(args).slice(0, 500));
  try {
    const r = await tool.handler(args || {});
    return toolResult(r);
  } catch (e) {
    log('tool.call 异常', name, (e && e.stack) || String(e));
    return toolResult({ text: `工具内部异常：${(e && e.message) || e}`, data: { code: 'E_INTERNAL', message: String((e && e.message) || e), hint: '查看 server.log 排障' }, isError: true });
  }
}

async function read(params) {
  const uri = params && params.uri;
  if (!uri) throw { rpcCode: -32602, message: 'resources/read 需要 uri' };
  const r = await readResource(uri);
  return { contents: [r] };
}

// ─────────────────────────────────────────────────────────── 启动
log(`boss-hr-outreach MCP server 启动（Node ${process.version}）`);
