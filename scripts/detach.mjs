#!/usr/bin/env node
/**
 * 脱离启动器 —— 把「守夜人 + 批次」放进一个**完全独立**的进程树里，然后立刻返回。
 *
 * 为什么不直接用 run-until-done：
 *   2026-10-13 的实测表明，把批次挂在当前工具调用/后台任务下运行时，
 *   一旦外部条件变化（回合结束、后台任务被摘除、输出管道被关闭），
 *   进程可能被外部终止。虽然探针证明"后台进程也能长期存活"，但**依赖这个前提是在赌**。
 *   本脚本用 `detached: true` + `unref()` 让守夜人脱离父进程树，
 *   输出直接重定向到日志文件（不经过任何会被关闭的管道），从而去掉"管道断了就崩"这条路径。
 *
 * 用法（参数与 watchdog.mjs 完全一致，原样透传）：
 *   node scripts/detach.mjs --plan p5.plan25.json --limit 25 --chunk 6 \
 *     --touch screen.touch.json --commit --out p5.greet.json --log p5.greet.log
 *
 *   node scripts/detach.mjs --status --out p5.greet.json     # 看守夜人是否还活着
 *   node scripts/detach.mjs --stop   --out p5.greet.json     # 停掉守夜人（连带子进程）
 *
 * 说明：`--status` / `--stop` 之后**原样再跑一次正常命令**即可续跑（--resume 幂等）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const WATCHDOG = path.join(HERE, 'watchdog.mjs');

const args = process.argv.slice(2);
const val = (n, d = null) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);

if (flag('help')) {
  console.log(`用法: node scripts/detach.mjs --plan <file> [watchdog 的全部选项]

  --status   查看已启动的守夜人状态（读 <out>.detach.json + <out>.watchdog.json）
  --stop     停止守夜人及其子进程
  --out <file>  结果文件（用于定位状态文件），默认 ./greet-batch-result.json

其余选项原样透传给 scripts/watchdog.mjs（--plan/--limit/--chunk/--touch/--commit/...）。`);
  process.exit(0);
}

const out = val('out', './greet-batch-result.json');
const detachFile = out + '.detach.json';
const wdStateFile = out + '.watchdog.json';
const wdLog = out + '.watchdog.log';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
};

// ── --status
if (flag('status')) {
  const info = readJson(detachFile);
  const wd = readJson(wdStateFile);
  if (!info && !wd) { console.log(`没有找到守夜人记录（${detachFile} / ${wdStateFile}）`); process.exit(3); }
  const alive = isAlive(info && info.pid);
  console.log(`守夜人：${alive ? '存活' : '已退出'}`);
  if (info) {
    console.log(`  PID      ${info.pid}`);
    console.log(`  启动于   ${info.startedAt}`);
    console.log(`  日志     ${info.wdLog || wdLog}`);
  }
  if (wd) {
    console.log(`  状态     ${wd.status}　轮次 ${wd.restarts ?? 0}/${wd.maxRestarts ?? '-'}　剩余 ${wd.remaining ?? '-'} 人`);
    if (wd.stopReason) console.log(`  停止原因 ${wd.stopReason}`);
    console.log(`  心跳更新 ${wd.updatedAt}`);
  }
  console.log('');
  console.log(`查看进度：node scripts/status.mjs --out ${out} --health`);
  process.exit(alive ? 0 : 12);
}

// ── --stop
if (flag('stop')) {
  const info = readJson(detachFile);
  if (!info || !info.pid) { console.log('没有找到守夜人记录，无需停止'); process.exit(0); }
  if (!isAlive(info.pid)) { console.log(`守夜人 PID ${info.pid} 已不在运行`); process.exit(0); }
  // Windows 上用 taskkill /T 连带子进程；其它平台用进程组
  if (process.platform === 'win32') {
    const p = spawn('taskkill', ['/F', '/T', '/PID', String(info.pid)], { stdio: 'inherit', windowsHide: true });
    p.on('exit', () => process.exit(0));
  } else {
    try { process.kill(-Number(info.pid), 'SIGTERM'); } catch { try { process.kill(Number(info.pid), 'SIGTERM'); } catch { /* ignore */ } }
    process.exit(0);
  }
}

// ── 正常启动
const plan = val('plan');
if (!plan) { console.error('缺少 --plan <file>（或改用 --status / --stop）'); process.exit(1); }

// 打开日志文件句柄用于探测可写性；子进程的 stdio 走 'ignore'。
// 为什么不用 fd 接 stdout：watchdog 自己已经把结构化日志 append 到 <out>.watchdog.log，
// 若再把 stdout 也指到同一文件，每行会被写两遍（2026-10-13 实测）。
// 'ignore' 还彻底避开了"读取端消失导致 EPIPE"这条路径 —— 这正是本次要消除的故障模式。
let fdProbe;
try {
  const dir = path.dirname(path.resolve(wdLog));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fdProbe = fs.openSync(wdLog, 'a');
  fs.closeSync(fdProbe);
} catch (e) {
  console.error(`无法写入守夜人日志 ${wdLog}：${e.message}`);
  process.exit(1);
}

const child = spawn(NODE, [WATCHDOG, ...args], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
});
child.unref();

try {
  fs.writeFileSync(detachFile, JSON.stringify({
    v: 1,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    plan,
    out,
    chunk: val('chunk', '6'),
    limit: val('limit'),
    touch: val('touch'),
    commit: flag('commit'),
    wdLog,
    wdState: wdStateFile,
    cmd: `node ${WATCHDOG} ${args.join(' ')}`,
  }, null, 2), 'utf8');
} catch (e) {
  console.error(`写 ${detachFile} 失败：${e.message}`);
}

console.log('已脱离启动守夜人（不受本回合/管道生命周期影响）：');
console.log(`  PID      ${child.pid}`);
console.log(`  日志     ${wdLog}`);
console.log(`  状态     ${wdStateFile}`);
console.log('');
console.log('  # 看进度（可反复执行，不打扰批处理）');
console.log(`  node scripts/status.mjs --out ${out} --health`);
console.log('  # 停止');
console.log(`  node scripts/detach.mjs --stop --out ${out}`);
process.exit(0);
