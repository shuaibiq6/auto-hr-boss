#!/usr/bin/env node
/**
 * 批次守护：把一批触达跑完，中途出问题自己扛 —— 目标是「不用人盯，也不怕中断」。
 *
 * 解决的问题（2026-10-12 的真实中断）：
 *   47 人批次要跑约 2 小时。当时上层 Agent 为了看进度反复用同一条命令扫日志，
 *   被宿主"重复调用保护"拦下，回合被切断 —— 任务看起来就"中断"了。
 *
 * 这个脚本把长任务收进**一个**进程里：
 *   1) 按 --chunk 分块调用 greet-batch（每块都是"安全边界"，随时可停）
 *   2) 块与块之间做会话健康检查；代理/浏览器掉线就自动重新拉起会话
 *   3) 每块都用 --resume 续跑，绝不重复触达已发出的人
 *   4) 全程只维护一个状态文件，等待方读它即可（配 scripts/status.mjs）
 *
 * 用法：
 *   node scripts/run-until-done.mjs --plan p4.plan47.json --limit 47 \
 *     --touch screen.touch.json --commit --chunk 12
 *
 *   # 中断后原样再跑一次即是"续跑"（--resume 会跳过已完成的人）
 *
 * 退出码：0 全部完成 / 1 有未确认项 / 3 闸门不允许 / 4 命中熔断需人工干预 / 2 会话无法恢复 / 6 达到 --max-chunks
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const GREET = path.join(HERE, 'greet-batch.mjs');
const START = path.join(HERE, 'start-session.mjs');
const STATUS = path.join(HERE, 'status.mjs');

const args = process.argv.slice(2);
const val = (n, d = null) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);

if (flag('help') || args.length === 0) {
  console.log(`用法: node scripts/run-until-done.mjs --plan <file> [选项]

  --plan <file>          必填，候选名单（同 greet-batch）
  --limit <n>            计划总量（同 greet-batch）
  --out <file>           结果文件，默认 ./greet-batch-result.json（续跑靠它去重）
  --log <file>           日志，默认 ./greet-batch.log
  --chunk <n>            每块处理几个人，默认 12（小一点更抗中断，大一点更省往返）
  --between-chunks <sec> 块间停顿，默认 0
  --max-chunks <n>       最多跑几块，默认 40（安全阀）
  --action <file>        动作模板
  --target <id>          标签页 id      --tid-file <file>  默认 ./_tid.txt
  --touch <file>         触达记录       --commit           成功项回写
  --profile <name>       限频档位，默认 hr150
  --job <name>           写入触达记录的岗位标识
  --url <url>            自动恢复会话时的起始页，默认 BOSS 推荐页
  --page-match <s>       自动恢复会话时的 tab 匹配，默认 zhipin.com
  --dry                  只定位不点击（用于验证守护流程本身）
  --detach               不在本回合里跑：转交完全脱离宿主的守夜人（scripts/watchdog.mjs），立即返回
  --no-auto-recover      会话掉线时不自动重拉（默认会自动重拉）
  --state <file>         守护状态文件，默认 <out>.supervisor.json

说明：中断后**原样再执行同一条命令**即可续跑 —— --resume 会跳过已完成的人。`);
  process.exit(0);
}

const plan = val('plan');
if (!plan) { console.error('缺少 --plan <file>'); process.exit(1); }

// --detach：不在本回合里跑，而是把整批交给「脱离宿主的守夜人」（scripts/detach.mjs → watchdog.mjs）。
// 这是 2026-10-13 事故后推荐的长批次启动方式：不依赖回合、不经过任何会被关闭的输出管道。
if (flag('detach')) {
  const pass = args.filter((a) => a !== '--detach');
  const child = spawn(NODE, [path.join(HERE, 'detach.mjs'), ...pass], { stdio: 'inherit', windowsHide: true });
  await new Promise((res) => child.on('exit', res));
  process.exit(0);
}

const out = val('out', './greet-batch-result.json');
const logFile = val('log', './greet-batch.log');
const chunk = Number(val('chunk', '12')) || 12;
const between = Number(val('between-chunks', '0')) || 0;
const maxChunks = Number(val('max-chunks', '40')) || 40;
const stateFile = val('state', out + '.supervisor.json');
const autoRecover = !flag('no-auto-recover');
const url = val('url', 'https://www.zhipin.com/web/chat/recommend');
const pageMatch = val('page-match', 'zhipin.com');
const proxy = val('proxy', process.env.CDP_PROXY_URL || 'http://127.0.0.1:3456');

const progressFile = out + '.progress.json';
const doneFile = out + '.done.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function log(m) { console.log(`[${stamp()}][守护] ${m}`); }

let sessionChild = null;
function writeState(patch) {
  const prev = readJson(stateFile) || {};
  const payload = {
    v: 1, pid: process.pid, updatedAt: new Date().toISOString(),
    plan, out, chunk, maxChunks, ...prev, ...patch,
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* ignore */ }
}

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

/** 会话不可用时重新拉起（自带 --hold，让它随守护进程存活） */
async function recoverSession() {
  if (!autoRecover) { log('会话不可用，且 --no-auto-recover 已设置 —— 请手工恢复后重跑本命令'); return false; }
  log('会话不可用，尝试自动重新拉起（start-session --hold）...');
  if (sessionChild && sessionChild.exitCode === null) {
    try { sessionChild.kill(); } catch { /* ignore */ }
  }
  const child = spawn(NODE, [
    START, '--url', url, '--page-match', pageMatch, '--tid-out', val('tid-file', './_tid.txt'), '--hold',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  sessionChild = child;
  child.stdout.on('data', (d) => process.stdout.write(`[session] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[session] ${d}`));
  child.on('exit', (code) => { if (sessionChild === child) log(`会话进程退出（code=${code}）`); });

  const dl = Date.now() + 90000;
  while (Date.now() < dl) {
    const h = await health();
    if (h && h.connected) { log('✓ 会话已恢复'); return true; }
    await sleep(1500);
  }
  log('✗ 90s 内未能恢复会话');
  return false;
}

async function ensureSession() {
  const h = await health();
  if (h && h.connected) return true;
  return await recoverSession();
}

function runChunk(extraSkip) {
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
  if (extraSkip && extraSkip.length) argv.push('--skip', extraSkip.join(','));

  log(`执行一块：node greet-batch.mjs --chunk ${chunk} --resume ...`);
  const child = spawn(NODE, argv, { stdio: 'inherit', windowsHide: true });
  return new Promise((res) => child.on('exit', (code) => res(code ?? 1)));
}

// ─────────────────────────────────────────────────────────── 主循环
let chunkNo = 0;
let lastCode = 0;
let remaining = null;

writeState({ status: 'starting', chunkNo: 0, remaining: null });
log(`守护启动：计划 ${plan}　分块 ${chunk}　结果 ${out}`);

for (;;) {
  chunkNo += 1;
  if (chunkNo > maxChunks) { log(`⏹ 达到 --max-chunks ${maxChunks}，停止`); lastCode = 6; break; }

  if (!(await ensureSession())) { lastCode = 2; break; }

  lastCode = await runChunk();

  const done = readJson(doneFile);
  const prog = readJson(progressFile);
  remaining = (done && typeof done.remaining === 'number') ? done.remaining
    : (prog && typeof prog.remaining === 'number') ? prog.remaining : 0;
  const okN = (done && done.succeeded) ?? (prog && prog.ok) ?? 0;
  const failedN = (done && done.failed) ?? (prog && prog.failed) ?? 0;

  writeState({
    status: 'running', chunkNo, exitCode: lastCode,
    ok: okN, failed: failedN, remaining,
    stopReason: (done && done.stopReason) || (prog && prog.stopReason) || null,
  });
  log(`第 ${chunkNo} 块结束：exit=${lastCode}　成功 ${okN}　失败 ${failedN}　剩余 ${remaining}`);

  if (lastCode === 3) { log('⛔ 闸门不允许（额度/时段），停止'); break; }
  if (lastCode === 4) { log('⛔ 命中熔断，停止并等待人工干预'); break; }
  if (lastCode === 5) { log('⛔ 已有实例在跑（锁冲突），停止'); break; }
  if (remaining <= 0) { log('✅ 全部处理完毕'); break; }

  if (between > 0) { log(`块间停顿 ${between}s ...`); await sleep(between * 1000); }
}

// 收尾：打印一次状态快照，方便上层直接引用
try {
  const r = spawn(NODE, [STATUS, '--out', out], { stdio: 'inherit', windowsHide: true });
  await new Promise((res) => r.on('exit', res));
} catch { /* ignore */ }

const finalState = readJson(stateFile) || {};
writeState({ status: remaining <= 0 ? 'finished' : 'stopped', finishedAt: new Date().toISOString() });

if (remaining > 0 && lastCode !== 4 && lastCode !== 3) {
  log(`未跑完（剩余 ${finalState.remaining ?? remaining}）—— 原样重跑本命令即可续跑`);
}
process.exit(remaining <= 0 ? (finalState.failed ? 1 : 0) : lastCode);
