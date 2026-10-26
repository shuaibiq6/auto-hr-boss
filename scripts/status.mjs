#!/usr/bin/env node
/**
 * 批次状态查询 —— 一条命令、一次调用就能看清"跑到哪了"。
 *
 * 为什么需要它（2026-10-12 的教训）：
 *   一次 47 人批次要跑约 2 小时。等待期间如果反复用**同一条命令**去扫日志，
 *   会被宿主的"重复调用保护"拦下，把人（或上层 Agent）的回合直接切断 ——
 *   这就是那次"任务中断"的直接原因。
 *   正确做法是：让执行器把状态写进文件（greet-batch 的 --progress / --done），
 *   等待方**只读文件**，而且读的东西每次都不一样（进度在变），也不会去 grep 大日志。
 *
 * 用法：
 *   node scripts/status.mjs --progress p4.greet.json.progress.json
 *   node scripts/status.mjs --out p4.greet.json            # 自动推导 progress/done 路径
 *   node scripts/status.mjs --out p4.greet.json --health   # 顺带探测代理会话是否还活着
 *   node scripts/status.mjs --out p4.greet.json --json     # 机器可读
 *
 * 退出码（方便上层循环判断）：
 *   0  仍在运行   12 本轮结束但未跑完（可续跑）   10 已完成   11 异常中止   3 找不到状态文件
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const val = (n, d = null) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);

if (flag('help') || args.length === 0) {
  console.log(`用法: node scripts/status.mjs --out <结果文件> [选项]

  --out <file>         greet-batch 的 --out（自动推导 <out>.progress.json / <out>.done.json）
  --progress <file>    直接指定进度心跳文件
  --done <file>        直接指定完成哨兵文件
  --watchdog <file>    指定守夜人状态文件（默认 <out>.watchdog.json，由 detach.mjs 生成）
  --health            额外探测 CDP 代理（--proxy 指定地址，默认 http://127.0.0.1:3456）
  --proxy <url>       代理地址
  --wait <sec>        前台等待：最多阻塞 N 秒，直到批次结束或超时（推荐 ≤540s，配合工具超时）
  --interval <sec>    等待期间的进度打印间隔，默认 15
  --json              输出机器可读 JSON

退出码: 0 运行中 / 12 本轮结束未跑完 / 10 已完成 / 11 异常中止 / 3 无状态文件`);
  process.exit(0);
}

const outFile = val('out');
const progressFile = val('progress', outFile ? outFile + '.progress.json' : null);
const doneFile = val('done', outFile ? outFile + '.done.json' : null);
// 2026-10-13 新增：守夜人（detach.mjs / watchdog.mjs）的状态文件
const watchdogFile = val('watchdog', outFile ? outFile + '.watchdog.json' : null);
const detachFile = outFile ? outFile + '.detach.json' : null;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ── 2026-10-13 新增：前台有界等待（`--wait`）
// 起因：把批次丢到后台"放着不管"时，宿主会回收那条后台任务（实测约 17 分钟后进程消失）。
// 正确姿势是让**当前回合**始终保持一个有界的等待呼叫：前台阻塞 N 秒，期间进程树不会被回收，
// 到点或批次结束就返回。重复几次即可覆盖整个长批次 —— 而且这不是"反复扫日志"。
const WAIT_SEC = Number(val('wait', '0')) || 0;
const INTERVAL_SEC = Math.max(3, Number(val('interval', '15')) || 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let progress = null;
let done = null;
let watchdog = null;
const wdTerminal = () => !!(watchdog && (watchdog.status === 'finished' || watchdog.status === 'stopped'));
// 守夜人还在跑时不要被「上一块写完的哨兵」骗成"已结束" —— 那是单块语义，不是整批语义。
const runEnded = () => (watchdog && watchdog.status === 'running')
  ? false
  : (!!done || !!(progress && (progress.finished || progress.aborted)) || wdTerminal());
const waitDeadline = Date.now() + WAIT_SEC * 1000;

/**
 * 取「最新的一份」状态。
 *
 * 2026-10-13 实测到的坑：分块运行时，`<out>.done.json` 哨兵在**每一块**收尾都会写一次，
 * 而 `--progress` 心跳是持续刷新的。若简单地 `done || progress`，就会一直读到
 * 「上一块写完的旧哨兵」——表现为**进度卡住不动、还误报"心跳 754s 未更新"**，
 * 让人以为进程死了（实际正在正常打招呼）。
 * 因此这里改成按 `updatedAt` 取更新的那一份。
 */
const pickState = () => {
  const cands = [done, progress].filter((x) => x && typeof x === 'object');
  if (!cands.length) return null;
  return cands.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
};

for (;;) {
  progress = progressFile ? readJson(progressFile) : null;
  done = doneFile ? readJson(doneFile) : null;
  watchdog = watchdogFile ? readJson(watchdogFile) : null;
  if (runEnded() || Date.now() >= waitDeadline) break;
  const p = pickState();
  const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  if (p) {
    console.log(`[wait] ${clock}　进度 ${p.done ?? 0}/${p.total ?? 0}　成功 ${p.ok ?? 0}　剩余 ${p.remaining ?? 0}${p.current ? `　当前 ${p.current.name || p.current.id}` : ''}`);
  } else if (watchdog) {
    console.log(`[wait] ${clock}　守夜人 ${watchdog.status}　轮次 ${watchdog.restarts ?? 0}　剩余 ${watchdog.remaining ?? '-'}`);
  } else {
    console.log(`[wait] ${clock}　尚未生成状态文件（批次可能还没启动）`);
  }
  if (watchdog) console.log(`[wait] ${clock}　守夜人：${watchdog.status}　轮次 ${watchdog.restarts ?? 0}/${watchdog.maxRestarts ?? '-'}　剩余 ${watchdog.remaining ?? '-'} 人`);
  await sleep(Math.min(INTERVAL_SEC * 1000, Math.max(1000, waitDeadline - Date.now())));
}

const state = pickState() || (watchdog ? {
  total: watchdog.remaining ?? 0,
  done: 0, ok: 0, failed: 0, skipped: 0,
  remaining: watchdog.remaining ?? 0,
  finished: watchdog.status === 'finished',
  aborted: watchdog.status === 'stopped',
  stopReason: watchdog.stopReason || null,
  updatedAt: watchdog.updatedAt || null,
  pid: watchdog.pid ?? null,
  plan: watchdog.plan ?? null,
} : null);

if (!state) {
  console.error(`找不到状态文件${progressFile ? `：${progressFile}` : ''}`);
  console.error('（批次可能还没启动，或用了别的 --out）');
  process.exit(3);
}

const ageSec = state.updatedAt ? Math.round((Date.now() - new Date(state.updatedAt).getTime()) / 1000) : null;

// 状态语义要分清三件事（否则会把"本轮结束"误报成"批次完成"）：
//   running  —— 还在跑
//   stopped  —— 本轮结束了，但**没跑完**（安全停机 / 达到 chunk 上限），重跑即续跑
//   finished —— 名单全部处理完
//   aborted  —— 进程异常消失（心跳里 aborted=true 且没有哨兵）
// 注：runEnded 已在上面「前台有界等待」那段定义（闭包读取最终值）
const aborted = !!state.aborted;
// ⚠ 必须调用 runEnded() —— 写成裸的 runEnded 会拿到函数对象（恒为真），
// 于是状态永远显示「本轮结束」、退出码永远 12（2026-10-13 发现并修复）。
const ended = runEnded();
const batchFinished = ended && !aborted && !!state.finished;
const statusKey = aborted ? 'aborted' : batchFinished ? 'finished' : ended ? 'stopped' : 'running';
const statusText = { running: '运行中', stopped: '本轮结束（未跑完，可续跑）', finished: '已完成', aborted: '异常中止' }[statusKey];

let health = null;
if (flag('health')) {
  const proxy = val('proxy', 'http://127.0.0.1:3456');
  const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.NO_PROXY = '*'; process.env.no_proxy = '*';
  try {
    const r = await fetch(proxy + '/health', { signal: AbortSignal.timeout(4000) });
    health = await r.json();
  } catch (e) { health = { status: 'unreachable', error: String(e.message).slice(0, 80) }; }
  finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const payload = {
  status: statusKey,
  finished: batchFinished,
  runEnded: ended,
  aborted,
  plan: state.plan || null,
  profile: state.profile || null,
  total: state.total ?? 0,
  done: state.done ?? 0,
  ok: state.ok ?? 0,
  allOk: state.allOk ?? null,
  failed: state.failed ?? 0,
  skipped: state.skipped ?? 0,
  remaining: state.remaining ?? 0,
  current: state.current || null,
  stopReason: state.stopReason || null,
  abortReason: state.abortReason || null,
  graceful: !!state.graceful,
  startedAt: state.startedAt || null,
  updatedAt: state.updatedAt || null,
  ageSeconds: ageSec,
  pid: state.pid || null,
  watchdog: watchdog ? {
    status: watchdog.status || null,
    pid: watchdog.pid ?? null,
    restarts: watchdog.restarts ?? 0,
    maxRestarts: watchdog.maxRestarts ?? null,
    remaining: watchdog.remaining ?? null,
    stopReason: watchdog.stopReason || null,
    updatedAt: watchdog.updatedAt || null,
    alive: (() => { try { process.kill(Number(watchdog.pid), 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } })(),
  } : null,
  detachFile,
  progressFile, doneFile,
  health: health ? { connected: !!health.connected, status: health.status } : null,
};

if (flag('json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const pct = payload.total ? Math.round((payload.done / payload.total) * 100) : 0;
  console.log(`批次状态：${statusText}`);
  // 有守夜人时进度是"整批视角"，但 ok/failed/skipped 仍是"本块"计数 —— 标注清楚，避免误读为总数
  const okLabel = payload.watchdog ? "本块成功" : "成功";
  console.log(`  进度：${payload.done}/${payload.total}（${pct}%）　${okLabel} ${payload.ok}　失败 ${payload.failed}　跳过 ${payload.skipped}`);
  console.log(`  剩余待处理：${payload.remaining} 人`);
  if (payload.current) console.log(`  正在处理：${payload.current.name || ''}（${payload.current.id}）第 ${payload.current.idx} 个`);
  if (payload.stopReason) console.log(`  停机原因：${payload.stopReason}`);
  if (payload.abortReason) console.log(`  ⛔ 终止原因：${payload.abortReason}（外部终止/异常，非脚本自身停机）`);
  console.log(`  心跳更新：${payload.updatedAt || '(未知)'}${ageSec != null ? `　（${ageSec}s 前）` : ''}`);
  if (payload.watchdog) {
    const w = payload.watchdog;
    console.log(`  守夜人：${w.status}${w.alive ? '（存活）' : '（已退出）'}　轮次 ${w.restarts}${w.maxRestarts ? '/' + w.maxRestarts : ''}　剩余 ${w.remaining ?? '-'} 人`);
    if (w.stopReason) console.log(`    停止原因：${w.stopReason}`);
  }
  if (statusKey === 'stopped' && payload.remaining > 0) {
    console.log(`  ↻ 未跑完：原样重跑同一条命令即可续跑（--resume 会跳过已完成的人）`);
  }
  if (ageSec != null && ageSec > 300 && !ended) {
    console.log(`  ⚠ 心跳已 ${ageSec}s 未更新 —— 进程可能已死。加 --json 看 pid，必要时重跑续跑命令。`);
  }
  if (health) console.log(`  代理会话：${health.connected ? '连接正常' : '未连接/不可达'}`);
}

process.exit(batchFinished ? 10 : aborted ? 11 : ended ? 12 : 0);
