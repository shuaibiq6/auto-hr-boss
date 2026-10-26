#!/usr/bin/env node
/**
 * 守夜人（watchdog）—— 让长批次「被杀也能自己跑完」。
 *
 * ── 为什么需要它（2026-10-13 的事故复盘）────────────────────────────────
 * 那天 25 人的批次停在 7/25，心跳里写着 `stopReason:null / graceful:false / aborted:true` ——
 * 也就是说：**不是脚本自己停的，也不是崩溃**，而是被外部终止、并且走完了优雅退出路径。
 * 事后用对照探针验证：后台进程在回合结束后可以连续存活 60+ 分钟、零断档
 * （p1.log 807 次写入 / 67.3 分钟 / 断档 0 处），所以「回合空闲就回收」并不成立 ——
 * **谁杀的无法确证，但这不重要。**
 *
 * 产品化的结论是：不要去猜凶手，而要让「被杀」变成无感事件。这个脚本干的就是这件事：
 *   1) 它以**独立进程**身份活着（可被 detach.mjs 完全脱离宿主启动），不依赖上层回合；
 *   2) 每一块都调用 greet-batch 的**有界片段**（--chunk），被杀时断点落在安全边界；
 *   3) 块结束时**多源合成**剩余量（结果文件 ∪ 心跳 doneIds ∪ 触达记录），
 *      即使子进程连结果文件都没写出来，也不会重复触达、不会漏算；
 *   4) 只要还有剩余且未触发熔断/闸门，就退避后**自动续跑**，直到跑完或到达截止；
 *   5) 全程只维护一个状态文件 <out>.watchdog.json，`scripts/status.mjs` 直接读它。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   # 前台运行（占用一个终端/工具调用，最直观）
 *   node scripts/watchdog.mjs --plan p5.plan25.json --limit 25 --chunk 6 \
 *     --touch screen.touch.json --commit --out p5.greet.json --log p5.greet.log
 *
 *   # 完全脱离宿主（推荐用于无人值守的长批次）—— 见 detach.mjs
 *   node scripts/detach.mjs --plan p5.plan25.json --limit 25 --chunk 6 \
 *     --touch screen.touch.json --commit --out p5.greet.json --log p5.greet.log
 *
 *   # 只做一次判定（自检 / 上层轮询）
 *   node scripts/watchdog.mjs --plan ... --limit 25 --now
 *
 * 退出码：0 已完成 / 12 到截止或达重启上限（仍有余量，可再跑）/ 3 闸门不允许 /
 *         4 命中熔断 / 2 会话无法恢复 / 5 锁冲突
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planWindow, resumeDoneSet, idsToSet, touchDoneSet } from './greet-batch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const GREET = path.join(HERE, 'greet-batch.mjs');
const START = path.join(HERE, 'start-session.mjs');

const isMain = !!(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

// ─────────────────────────────────────────────────────── 纯函数（可离线回归）
/**
 * 守夜人的下一步决策 —— 抽成纯函数，便于离线回归：
 * 用 10-13 的真实中断序列（7 成功 / 剩余 18 / 外部终止）做用例，确保「该重启就重启、该停就停」。
 */
export function decideWatchdogAction(state = {}) {
  const remaining = Number(state.remaining ?? 0);
  const restarts = Number(state.restarts ?? 0);
  const maxR = Number(state.maxRestarts ?? 40);
  const lastExit = state.lastExit == null ? null : Number(state.lastExit);
  const nowMs = Number(state.nowMs ?? Date.now());
  const dMs = state.deadlineMs == null ? null : Number(state.deadlineMs);
  const backoffS = Number(state.backoffS ?? 20);

  if (remaining <= 0) return { action: 'finish', reason: '全部处理完毕' };
  if (dMs != null && nowMs >= dMs) return { action: 'stop', reason: '到达 --deadline 截止时刻', code: 12 };
  if (restarts >= maxR) return { action: 'stop', reason: `达到 --max-restarts ${maxR}`, code: 12 };
  if (lastExit === 3) return { action: 'stop', reason: '闸门不允许（额度/时段），需人工确认后重跑', code: 3 };
  if (lastExit === 4) return { action: 'stop', reason: '命中熔断（风控信号/连败），需人工干预', code: 4 };
  if (lastExit === 5) return { action: 'stop', reason: '锁冲突：已有实例在跑', code: 5 };
  return { action: 'run', reason: `继续处理剩余 ${remaining} 人`, waitS: restarts > 0 ? backoffS : 0 };
}

/**
 * 多源合成剩余量。
 * 关键：不能只看结果文件 —— 它是收尾才写的，子进程被杀时可能压根不存在。
 * 已办集合 = 结果文件 ∪ 心跳 doneIds ∪ 触达记录（后两者都是逐条落盘）。
 */
export function computeRemaining({ all = [], limit = null, out = [], progress = {}, touch = [] } = {}) {
  const prevResults = Array.isArray(out) ? out : [];
  const prog = (progress && typeof progress === 'object') ? progress : {};
  const touchArr = Array.isArray(touch) ? touch : [];
  const doneSet = new Set([
    ...resumeDoneSet(prevResults),
    ...idsToSet(prog.doneIds),
    ...touchDoneSet(touchArr),
  ]);
  const { poolSize } = planWindow(all, { limit, doneIds: doneSet, chunk: null });
  // doneSetSize 是合并后的全集（可能跨天、含名单外的人）；relevantDone 才是「本名单内已办」
  const scope = limit == null ? all : all.slice(0, Math.max(0, limit));
  const relevantDone = scope.filter((t) => t && doneSet.has(String(t.id))).length;
  return { pending: poolSize, doneSetSize: doneSet.size, relevantDone };
}

// ─────────────────────────────────────────────────────── 若被 import，到此为止
if (!isMain) { /* no side effects when imported (offline regression / status reuse) */ }
else {

// ─────────────────────────────────────────────────────── CLI
const args = process.argv.slice(2);
const val = (n, d = null) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);

if (flag('help') || args.length === 0) {
  console.log(`用法: node scripts/watchdog.mjs --plan <file> [选项]

  --plan <file>          必填，候选名单（同 greet-batch）
  --limit <n>            计划总量（冻结上限，续跑多少次都不会超发）
  --out <file>           结果文件，默认 ./greet-batch-result.json
  --log <file>           子进程日志，默认 ./greet-batch.log
  --chunk <n>            每块处理几个人，默认 6（越小越抗中断）
  --max-restarts <n>     最多重启几次，默认 40（安全阀）
  --backoff <sec>        重启前退避，默认 20
  --child-timeout <sec>  单块最长运行秒数，超时则终止并重启，默认 1800（0=不限）
  --deadline <HH:MM>     到达该本地时刻即停止（可选；用于守限频窗口）
  --action <file>        动作模板        --profile <name>  限频档位，默认 hr150
  --touch <file>         触达记录        --commit          成功项回写
  --respect-window       子进程离开限频档时段即优雅停机
  --target <id>          标签页 id       --tid-file <file> 默认 ./_tid.txt
  --job <name>           写进触达记录的岗位标识
  --url <url>            自动恢复会话的起始页
  --page-match <s>       自动恢复会话的 tab 匹配，默认 zhipin.com
  --now                  只做一次状态判定并打印结论，不启动任何子进程（自检用）
  --dry                  只定位不点击（用于验证守护流程本身）
  --no-auto-recover      会话掉线时不自动重拉
  --state <file>         守护状态文件，默认 <out>.watchdog.json

退出码: 0 已完成 / 12 到截止或达上限 / 3 闸门不允许 / 4 命中熔断 / 2 会话不可恢复 / 5 锁冲突`);
  process.exit(0);
}

const plan = val('plan');
if (!plan) { console.error('缺少 --plan <file>'); process.exit(1); }

const out = val('out', './greet-batch-result.json');
const logFile = val('log', './greet-batch.log');
const chunk = Math.max(1, Number(val('chunk', '6')) || 6);
const maxRestarts = Number(val('max-restarts', '40')) || 40;
const backoffS = Math.max(0, Number(val('backoff', '20')) || 0);
const childTimeout = Math.max(0, Number(val('child-timeout', '1800')) || 0);
const deadlineStr = val('deadline');
const stateFile = val('state', out + '.watchdog.json');
const autoRecover = !flag('no-auto-recover');
const onlyNow = flag('now');
const url = val('url', 'https://www.zhipin.com/web/chat/recommend');
const pageMatch = val('page-match', 'zhipin.com');
const proxy = val('proxy', process.env.CDP_PROXY_URL || 'http://127.0.0.1:3456');

const progressFile = out + '.progress.json';
const wdLogFile = out + '.watchdog.log';

// ─────────────────────────────────────────────────────── 基础
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readArr = (f) => { const j = readJson(f); return Array.isArray(j) ? j : []; };

// 输出韧性：理由同 greet-batch —— 不能因为控制台管道断开就丢掉守护进程
let outputBroken = false;
const safeWrite = (fn) => { if (outputBroken) return; try { fn(); } catch { outputBroken = true; } };
try {
  process.stdout.on('error', (e) => { const c = e && e.code; if (c === 'EPIPE' || c === 'ERR_STREAM_DESTROYED') outputBroken = true; });
  process.stderr.on('error', () => { /* 吞掉 */ });
} catch { /* ignore */ }

function wlog(m) {
  const line = `[${stamp()}][守夜人] ${m}`;
  try { fs.appendFileSync(wdLogFile, line + '\n'); } catch { /* ignore */ }
  safeWrite(() => console.log(line));
}

/**
 * 转发子进程输出：**同时**落盘 + 控制台。
 * 落盘是必须的 —— detach 模式下 watchdog 的 stdio 是 'ignore'（彻底避开 EPIPE），
 * 如果只写 console，子进程的输出就全丢了。
 */
function wforward(s) {
  const txt = String(s).replace(/\r/g, '');
  try { fs.appendFileSync(wdLogFile, txt.endsWith('\n') ? txt : txt + '\n'); } catch { /* ignore */ }
  safeWrite(() => process.stdout.write(txt));
}

/** 解析 --deadline HH:MM 为今天的该时刻（已过则顺延到明天，避免误判成立即截止） */
function parseDeadline(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
const deadlineMs = parseDeadline(deadlineStr);

function writeWState(patch = {}) {
  const prev = readJson(stateFile) || {};
  const payload = {
    v: 1, pid: process.pid, updatedAt: new Date().toISOString(),
    plan, out, chunk, maxRestarts, backoffS, deadline: deadlineStr || null, wdLog: wdLogFile,
    ...prev, ...patch,
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* ignore */ }
}

function snapshotRemaining() {
  const raw = readJson(plan);
  const all = Array.isArray(raw) ? raw : (raw && raw.accepted) || [];
  const limit = val('limit') ? Number(val('limit')) : null;
  const touchFile = val('touch');
  return computeRemaining({
    all, limit, out: readArr(out), progress: readJson(progressFile),
    touch: touchFile ? readArr(touchFile) : [],
  });
}

// ─────────────────────────────────────────────────────── 会话健康
async function health() {
  const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.NO_PROXY = '*'; process.env.no_proxy = '*';
  try {
    const r = await fetch(proxy + '/health', { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch { return null; }
  finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

let sessionChild = null;
async function recoverSession() {
  if (!autoRecover) { wlog('会话不可用，且 --no-auto-recover 已设置 —— 请手工恢复后重跑'); return false; }
  wlog('会话不可用，尝试自动重新拉起（start-session --hold）...');
  if (sessionChild && sessionChild.exitCode === null) { try { sessionChild.kill(); } catch { /* ignore */ } }
  const child = spawn(NODE, [
    START, '--url', url, '--page-match', pageMatch, '--tid-out', val('tid-file', './_tid.txt'), '--hold',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  sessionChild = child;
  child.stdout.on('data', (d) => wforward(`[session] ${d}`));
  child.stderr.on('data', (d) => wforward(`[session] ${d}`));
  child.on('exit', (c) => { if (sessionChild === child) wlog(`会话进程退出（code=${c}）`); });

  const dl = Date.now() + 90000;
  while (Date.now() < dl) {
    const h = await health();
    if (h && h.connected) { wlog('✓ 会话已恢复'); return true; }
    await sleep(1500);
  }
  wlog('✗ 90s 内未能恢复会话');
  return false;
}

async function ensureSession() {
  const h = await health();
  if (h && h.connected) return true;
  return await recoverSession();
}

// ─────────────────────────────────────────────────────── 跑一块
let currentChild = null;
function runChunk() {
  const argv = [
    GREET, '--plan', plan, '--out', out, '--log', logFile,
    '--chunk', String(chunk), '--resume',
    '--profile', val('profile', 'hr150'),
  ];
  const limit = val('limit'); if (limit) argv.push('--limit', limit);
  const action = val('action'); if (action) argv.push('--action', action);
  const touch = val('touch'); if (touch) argv.push('--touch', touch);
  const job = val('job'); if (job) argv.push('--job', job);
  const tidFile = val('tid-file'); if (tidFile) argv.push('--tid-file', tidFile);
  const target = val('target'); if (target) argv.push('--target', target);
  if (flag('commit')) argv.push('--commit');
  if (flag('dry')) argv.push('--dry');
  if (flag('respect-window')) argv.push('--respect-window');

  wlog(`启动一块：--chunk ${chunk} --resume${flag('dry') ? ' [DRY]' : ''}`);
  const child = spawn(NODE, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  currentChild = child;
  child.stdout.on('data', (d) => wforward(d));
  child.stderr.on('data', (d) => wforward(d));

  let timedOut = false;
  let timer = null;
  if (childTimeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      wlog(`⚠ 单块超过 --child-timeout ${childTimeout}s，终止该块并按断点续跑`);
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 8000);
    }, childTimeout * 1000);
  }

  return new Promise((res) => {
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      currentChild = null;
      res({ code: code == null ? 1 : code, signal: signal || null, timedOut });
    });
  });
}

// ─────────────────────────────────────────────────────── 主流程
// --now 是只读自检：不写状态文件、不写日志，方便上层随时安全查询
if (onlyNow) {
  const s = snapshotRemaining();
  const decision = decideWatchdogAction({ remaining: s.pending, restarts: 0, maxRestarts, nowMs: Date.now(), deadlineMs, backoffS });
  console.log(JSON.stringify({ remaining: s.pending, doneSetSize: s.doneSetSize, decision }, null, 2));
  process.exit(0);
}

writeWState({ status: 'starting', restarts: 0, remaining: null, lastExit: null });
wlog(`守夜人启动：计划 ${plan}　分块 ${chunk}　上限 ${maxRestarts} 次　结果 ${out}`);
if (deadlineMs) wlog(`截止时刻：${deadlineStr}`);

// 被外部终止时也要留下痕迹（守夜人自己不能被静默杀掉）
let restarts = 0;
let lastExit = null;
let stopCode = 0;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      wlog(`收到 ${sig} —— 结束守夜（子进程会被一并终止；重跑本脚本即续跑）`);
      writeWState({ status: 'stopped', stopReason: `signal:${sig}`, restarts, finishedAt: new Date().toISOString() });
      try { if (currentChild) currentChild.kill('SIGTERM'); } catch { /* ignore */ }
      process.exit(12);
    });
  } catch { /* ignore */ }
}

for (;;) {
  const snap = snapshotRemaining();
  const decision = decideWatchdogAction({
    remaining: snap.pending, restarts, maxRestarts, lastExit,
    nowMs: Date.now(), deadlineMs, backoffS,
  });

  writeWState({
    status: decision.action === 'run' ? 'running' : decision.action === 'finish' ? 'finished' : 'stopped',
    restarts, remaining: snap.pending, doneSetSize: snap.doneSetSize,
    lastExit, stopReason: decision.action === 'run' ? null : decision.reason,
  });

  if (decision.action === 'finish') { wlog(`✅ ${decision.reason}`); stopCode = 0; break; }
  if (decision.action === 'stop') { wlog(`⏹ ${decision.reason}（剩余 ${snap.pending} 人）`); stopCode = decision.code || 12; break; }

  wlog(`第 ${restarts + 1} 轮：${decision.reason}（本名单已办 ${snap.relevantDone ?? snap.doneSetSize} 人）`);
  if (decision.waitS > 0) { wlog(`退避 ${decision.waitS}s 后继续...`); await sleep(decision.waitS * 1000); }

  if (!(await ensureSession())) { wlog('⛔ 会话无法恢复，停止'); stopCode = 2; break; }

  const r = await runChunk();
  lastExit = r.code;
  restarts += 1;
  wlog(`第 ${restarts} 轮结束：exit=${r.code}${r.signal ? ` signal=${r.signal}` : ''}${r.timedOut ? ' [超时终止]' : ''}`);
}

const finalSnap = snapshotRemaining();
writeWState({
  status: stopCode === 0 ? 'finished' : 'stopped',
  restarts, remaining: finalSnap.pending, lastExit,
  stopReason: stopCode === 0 ? null : (readJson(stateFile) || {}).stopReason || 'stopped',
  finishedAt: new Date().toISOString(),
});
wlog(stopCode === 0 ? '守夜结束：全部处理完毕' : `守夜结束：仍余 ${finalSnap.pending} 人 —— 原样重跑本命令即可续跑`);
process.exit(stopCode);

}
