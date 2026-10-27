#!/usr/bin/env node
/**
 * lib.mjs — MCP Server 共享基础设施（零第三方依赖）
 *
 * 承载：
 *   1) 日志纪律（R-05）：Server 自身日志一律走 stderr + <BOSS_MCP_HOME>/logs/server.log，
 *      绝不写 stdout（stdout 只承载 MCP JSON-RPC 帧）。
 *   2) 状态根目录（R-06）：BOSS_MCP_HOME 环境变量，默认 ~/.boss-hr-outreach/。
 *   3) spawn 引擎脚本的通用助手（参数数组传递，不拼 shell 字符串；UTF-8 正确解析）。
 *   4) 时间 / 错误码 / 幂等读写等横切工具。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────── 引擎位置（单一事实源）
export const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_ROOT = path.resolve(MCP_DIR, '..');
export const SCRIPTS_DIR = path.join(ENGINE_ROOT, 'scripts');
export const TEMPLATES_DIR = path.join(ENGINE_ROOT, 'templates');
export const REFERENCES_DIR = path.join(ENGINE_ROOT, 'references');
export const NODE = process.execPath;

// ─────────────────────────────────────────────────────────── 请求上下文（取消传播）
// 用 AsyncLocalStorage 把「当前请求的 AbortSignal」带到 runNode / proxyCall 等底层，
// 无需在每一层 handler 手动透传 signal；收到 notifications/cancelled 时 abort 即可。
export const reqCtx = new AsyncLocalStorage();

// ─────────────────────────────────────────────────────────── 状态根目录（R-06）
export function resolveHome() {
  const env = process.env.BOSS_MCP_HOME;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.boss-hr-outreach');
}

export const HOME = resolveHome();

export const PATHS = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  runtime: path.join(HOME, 'runtime.json'),
  runtimeTid: path.join(HOME, 'runtime.tid.txt'),
  history: path.join(HOME, 'history'),
  touch: path.join(HOME, 'history', 'touch.json'),
  breaker: path.join(HOME, 'history', 'breaker.json'),
  attest: path.join(HOME, 'history', 'attest.json'),
  jobs: path.join(HOME, 'jobs'),
  plans: path.join(HOME, 'plans'),
  logs: path.join(HOME, 'logs'),
  serverLog: path.join(HOME, 'logs', 'server.log'),
};

/** 首次使用自动创建目录树（R-06）。幂等。 */
export function ensureHome() {
  for (const d of [PATHS.home, PATHS.history, PATHS.jobs, PATHS.plans, PATHS.logs]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────── 启动期引擎契约检查（T2-1）
// 引擎脚本（scripts/）或关键文件缺失时给出明确错误并退出，而不是在后续
// `import '../../scripts/pacing.mjs'` 处抛出一段难读的深层堆栈。
const _missing = [];
if (!fs.existsSync(SCRIPTS_DIR)) _missing.push('scripts/ 目录不存在');
else if (!fs.existsSync(path.join(SCRIPTS_DIR, 'pacing.mjs'))) _missing.push('scripts/pacing.mjs 缺失');
if (_missing.length) {
  try {
    process.stderr.write(`[boss-hr-outreach] 引擎位置错误：${_missing.join('；')}\n`
      + `  期望引擎根目录 ENGINE_ROOT=${ENGINE_ROOT}\n`
      + '  请用实际解压后的绝对路径修正 MCP 客户端配置中的 server.mjs 路径，并确保 scripts/ 与 mcp/ 同级。\n');
  } catch { /* ignore */ }
  process.exit(1);
}

// ─────────────────────────────────────────────────────────── 日志（R-05：stderr + 文件，绝不写 stdout）
// T5-2：文件写入改为内存缓冲 + 定时 flush（500ms）+ 退出前强制 flush，
//       避免在热路径（每请求多行日志）反复 appendFileSync 阻塞事件循环 → 客户端超时掉线。
//       stderr 仍即时写（非阻塞，Host 排障依赖），仅磁盘文件走缓冲。
let logBuf = [];
let logTimer = null;
function flushLogs() {
  if (!logBuf.length) return;
  const chunk = logBuf.join('\n') + '\n';
  logBuf = [];
  try { ensureHome(); fs.appendFileSync(PATHS.serverLog, chunk); } catch { /* ignore */ }
}
export function log(...args) {
  const line = `[${localTime()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
  logBuf.push(line);
  if (!logTimer) {
    logTimer = setTimeout(() => { logTimer = null; flushLogs(); }, 500);
    if (logTimer.unref) logTimer.unref();
  }
}
// 退出前把未 flush 的日志落盘（process.on('exit') 内只允许同步操作，flushLogs 恰好同步）。
try { process.on('exit', flushLogs); } catch { /* ignore */ }

// ─────────────────────────────────────────────────────────── 时间工具（一律本地时间，防时区混淆 INV 一致性规则 6）
const pad = (n) => String(n).padStart(2, '0');
export function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function todayStr() { return localDate(); }

// ─────────────────────────────────────────────────────────── 幂等读写
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function readJsonArr(file) {
  const j = readJson(file);
  return Array.isArray(j) ? j : [];
}
export function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { log('writeJson failed', file, e.message); return false; }
}
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

// ─────────────────────────────────────────────────────────── 跨进程文件锁（T3-4）
// touch/breaker/attest 是「读-改-写」热点：多个 MCP 进程（多 Host）并发时，
// 无锁的 read-modify-write 会丢记录 → 配额少计 → 闸门误放行超发。
// 这里用 O_EXCL 创建锁文件 + PID 落盘 + 自旋（同步，零第三方依赖）。
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 主线程不允许 Atomics.wait 时退化为忙等 */ } };

/** 锁文件是否为崩溃残留（持有者 PID 已死）——避免残留锁永久阻塞后续写入。 */
function isStaleLock(lockPath, staleMs) {
  try {
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch { return false; }
}

/**
 * 在文件锁内执行 fn（同步）。锁超时 5s，崩溃残留锁按持有者 PID 自动判定。
 * fn 抛错时锁仍会释放。
 */
export function withFileLockSync(file, fn, { timeoutMs = 5000, staleMs = 10000 } = {}) {
  const lockPath = file + '.lock';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      try { return fn(); }
      finally { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(lockPath); } catch { /* ignore */ } }
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        if (isStaleLock(lockPath, staleMs)) { try { fs.unlinkSync(lockPath); } catch { /* ignore */ } continue; }
        if (Date.now() > deadline) { log('withFileLockSync 超时', lockPath); throw new Error('file lock timeout: ' + lockPath); }
        sleepSync(15);
        continue;
      }
      throw e;
    }
  }
}

// ─────────────────────────────────────────────────────────── 错误对象（《03》§8）
export class McpError extends Error {
  constructor(code, message, details = null, hint = null) {
    super(message);
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}
export function fail(code, message, details = null, hint = null) {
  return new McpError(code, message, details, hint);
}

// ─────────────────────────────────────────────────────────── spawn 引擎脚本
/**
 * 运行一个引擎 CLI（参数数组传递，不拼 shell 字符串 → Windows 空格/中文/括号安全）。
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runNode(scriptRelPath, args = [], opts = {}) {
  const script = path.join(SCRIPTS_DIR, scriptRelPath);
  const { timeoutMs = 0, env = {}, signal = null } = opts;
  return new Promise((resolve) => {
    const child = spawn(NODE, [script, ...args], {
      cwd: ENGINE_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        NO_PROXY: '*', no_proxy: '*',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 取消传播：显式 signal 优先，否则取当前请求上下文（notifications/cancelled → abort）
    const abortSignal = signal || (reqCtx.getStore() ? reqCtx.getStore().signal : null);
    if (abortSignal) {
      const kill = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
      if (abortSignal.aborted) kill();
      else abortSignal.addEventListener('abort', kill, { once: true });
    }
    // T4-5：请求带 progressToken 时，长任务期间周期性心跳，避免客户端 60s 超时掉线
    const ctx = reqCtx.getStore();
    let progressTimer = null;
    if (ctx && ctx.progressToken && typeof ctx.sendProgress === 'function') {
      const started = Date.now();
      progressTimer = setInterval(() => {
        try { ctx.sendProgress(ctx.progressToken, Date.now() - started, timeoutMs > 0 ? timeoutMs : undefined); } catch { /* ignore */ }
      }, 5000);
      if (progressTimer.unref) progressTimer.unref();
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
      }, timeoutMs);
    }
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      resolve({ code: 1, stdout, stderr: stderr + '\n' + String(e.message), timedOut });
    });
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      resolve({ code: code == null ? 1 : code, stdout, stderr, timedOut, signal });
    });
  });
}

/** 从 stdout 里尽量解析出一个 JSON 对象（引擎偶有进度行混在 stdout，取首个 `{` 到末尾的片段）。 */
export function parseJsonFromStdout(stdout) {
  const t = String(stdout || '').trim();
  if (!t) return null;
  const first = t.indexOf('{');
  if (first === -1) return null;
  try { return JSON.parse(t.slice(first)); } catch { /* fallthrough */ }
  // 若整段不是纯 JSON，尝试从首个 { 开始做括号平衡截取
  let depth = 0, inStr = false, esc = false;
  for (let i = first; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(first, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ─────────────────────────────────────────────────────────── 退出码 → 错误码（《03》§8）
export function mapExitCode(script, code) {
  if (script === 'risk-check') {
    if (code === 4) return fail('E_RISK_BLOCK', '命中风控信号（验证码 / 答题 / 操作频繁）—— 立即终止当天全部操作');
    if (code === 3) return fail('E_LOGIN_REQUIRED', '需要干预：页面不可见或登录失效', null, '请在浏览器完成登录 / 还原窗口后重试');
    if (code === 1) return fail('E_INTERNAL', '参数或网络错误');
  }
  if (script === 'greet-batch' || script === 'watchdog') {
    if (code === 3) return fail('E_GATE_DENIED', '闸门不允许（额度 / 时段）');
    if (code === 4) return fail('E_CIRCUIT_OPEN', '命中熔断（风控信号 / 连败）—— 当日不再允许 live');
    if (code === 5) return fail('E_JOB_ACTIVE', '已有实例在运行（锁冲突）');
  }
  if (code === 0) return null;
  return fail('E_INTERNAL', `引擎脚本退出码 ${code}`);
}

// ─────────────────────────────────────────────────────────── 结果封装
export function ok(text, data = null) {
  return { text, data, isError: false, code: null, image: null };
}
export function errResult(code, message, details = null, hint = null) {
  return { text: message, data: { code, message, details: details ?? undefined, hint: hint ?? undefined }, isError: true, code, image: null };
}

/** 把中文/对象安全转成可打印字符串（摘要用） */
export function s(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
