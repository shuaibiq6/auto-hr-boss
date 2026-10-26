#!/usr/bin/env node
/**
 * 守夜人（watchdog）抗中断回归测试 —— 全部用**纯函数 + 真实事故数据**，不需要浏览器。
 *
 * 重点验证三件事：
 *   A. 决策：该重启就重启、该停就停（闸门/熔断/截止/上限）
 *   B. 剩余量：多源合成（结果文件 ∪ 心跳 doneIds ∪ 触达记录），
 *      即使用「10-13 那次进程被杀、结果文件压根没写出来」的数据，也必须算对
 *   C. 收敛：反复「被杀 → 重启」，最终恰好跑满、不重复、不超发
 */

import {
  decideWatchdogAction, computeRemaining,
} from '../watchdog.mjs';
import { planWindow, resumeDoneSet, idsToSet, touchDoneSet } from '../greet-batch.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}\n      得到 ${g}\n      期望 ${w}`); }
};

// ─────────────────────────────────────── A. 决策
console.log('A. 决策（decideWatchdogAction）');
eq('剩余为 0 → 收工', decideWatchdogAction({ remaining: 0 }).action, 'finish');
eq('首次启动不等退避', decideWatchdogAction({ remaining: 18, restarts: 0, backoffS: 20 }), { action: 'run', reason: '继续处理剩余 18 人', waitS: 0 });
eq('重启后要退避', decideWatchdogAction({ remaining: 18, restarts: 2, backoffS: 20 }).waitS, 20);
eq('闸门不允许(3) → 停', decideWatchdogAction({ remaining: 18, restarts: 1, lastExit: 3 }).code, 3);
eq('熔断(4) → 停', decideWatchdogAction({ remaining: 18, restarts: 1, lastExit: 4 }).code, 4);
eq('锁冲突(5) → 停', decideWatchdogAction({ remaining: 18, restarts: 1, lastExit: 5 }).code, 5);
eq('外部终止/正常退出(1/0/null) → 继续跑', decideWatchdogAction({ remaining: 18, restarts: 1, lastExit: 1 }).action, 'run');
eq('外部终止(exit 0, 未跑完) → 继续跑', decideWatchdogAction({ remaining: 18, restarts: 1, lastExit: 0 }).action, 'run');
eq('达重启上限 → 停(12)', decideWatchdogAction({ remaining: 18, restarts: 40, maxRestarts: 40 }).code, 12);
eq('过截止时刻 → 停(12)', decideWatchdogAction({ remaining: 18, restarts: 0, nowMs: 1000, deadlineMs: 999 }).code, 12);
eq('未到截止 → 继续', decideWatchdogAction({ remaining: 18, restarts: 0, nowMs: 998, deadlineMs: 999 }).action, 'run');

// ─────────────────────────────────────── B. 剩余量（多源合成）
console.log('B. 剩余量（computeRemaining）');
const mk = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), name: `p${from + i}` }));
const ALL25 = mk(25);

eq('什么都没做 → 25', computeRemaining({ all: ALL25, limit: 25, out: [], progress: {}, touch: [] }).pending, 25);
eq('只看结果文件（2 条）', computeRemaining({ all: ALL25, limit: 25, out: [{ id: '0', status: 'succeeded' }, { id: '1', status: 'succeeded' }], progress: {}, touch: [] }).pending, 23);
eq('只看心跳 doneIds（3 条）', computeRemaining({ all: ALL25, limit: 25, out: [], progress: { doneIds: ['0', '1', '2'] }, touch: [] }).pending, 22);
eq('只看触达记录（8 条）', computeRemaining({ all: ALL25, limit: 25, out: [], progress: {}, touch: mk(8).map((x) => ({ id: x.id })) }).pending, 17);

// —— 10-13 真实事故序列：25 人计划，实际发出 8 人（7 条在心跳 doneIds，第 8 人靠平台侧核验后补录），
//    结果文件**根本没写出来**（进程被杀）。此时必须算出「还剩 17 人」而不是 25 或 18。
const INCIDENT = computeRemaining({
  all: ALL25, limit: 25,
  out: [],                                                  // ← 关键：结果文件不存在
  progress: { doneIds: ['0', '1', '2', '3', '4', '5', '6'], aborted: true, abortReason: 'unknown-exit' },
  touch: ['0', '1', '2', '3', '4', '5', '6', '7'].map((id) => ({ id })),   // ← 第 8 人在触达记录里
});
eq('10-13 事故回放：结果文件缺失也能算出剩 17', INCIDENT.pending, 17);
eq('10-13 事故回放：已办集合去重后 8 人', INCIDENT.doneSetSize, 8);

// limit 冻结语义：无论跑多少轮，都不越过 limit
eq('limit 冻结（100 人池只做 25）', computeRemaining({ all: mk(100), limit: 25, out: [], progress: {}, touch: [] }).pending, 25);
eq('limit 已达标 → 0', computeRemaining({ all: mk(100), limit: 25, out: [], progress: {}, touch: mk(25).map((x) => ({ id: x.id })) }).pending, 0);

// 心跳里的 failed/unverified 不该算「已办」（要让它们被重试）
eq('未确认项不算已办', computeRemaining({ all: mk(5), limit: 5, out: [{ id: '0', status: 'unverified' }, { id: '1', status: 'failed' }], progress: {}, touch: [] }).pending, 5);

// ─────────────────────────────────────── C. 收敛：被杀 → 重启 → 跑满
console.log('C. 收敛（模拟外部反复终止）');
function simulate({ total, limit, chunk, killEvery, maxRounds = 100 }) {
  const all = mk(total);
  const touch = [];                 // 触达记录（逐条落盘；被杀也保留）
  const progress = { doneIds: [] }; // 心跳 doneIds
  let results = [];                 // 结果文件（收尾才写 → 被杀时丢失）
  let rounds = 0, processed = [];
  for (;;) {
    if (rounds >= maxRounds) return { done: false, reason: '未收敛（超过轮次上限）' };
    const { pending } = computeRemaining({ all, limit, out: results, progress, touch });
    const d = decideWatchdogAction({ remaining: pending, restarts: rounds, maxRestarts: 200 });
    if (d.action === 'finish') return { done: true, processed, rounds };
    if (d.action === 'stop') return { done: false, reason: d.reason };

    // 模拟「跑一块」：本块处理 chunk 个
    const doneSet = new Set([
      ...resumeDoneSet(results), ...idsToSet(progress.doneIds), ...touchDoneSet(touch),
    ]);
    const { list } = planWindow(all, { limit, doneIds: doneSet, chunk });
    const cur = list.map((t) => ({ id: t.id, status: 'succeeded' }));
    // 增量落盘：心跳与触达记录**每条都写**（被杀也留得住）
    for (const r of cur) { progress.doneIds.push(r.id); touch.push({ id: r.id }); }
    processed.push(...cur.map((r) => r.id));

    rounds += 1;
    // killEvery：模拟进程在这一轮结束时被外部杀掉 → 结果文件没写出来
    if (killEvery && rounds % killEvery === 0) { results = []; }
    else { results = results.concat(cur); }
  }
}

const s1 = simulate({ total: 25, limit: 25, chunk: 6, killEvery: 0 });
eq('不中断：25 人 5 轮跑完', { done: s1.done, rounds: s1.rounds }, { done: true, rounds: 5 });
eq('不中断：恰好处理 25 人次', s1.processed.length, 25);
eq('不中断：无重复', new Set(s1.processed).size, 25);

const s2 = simulate({ total: 25, limit: 25, chunk: 6, killEvery: 1 });   // 每轮都被杀
eq('每轮都被杀：仍能跑完', s2.done, true);
eq('每轮都被杀：恰好 25 人次', s2.processed.length, 25);
eq('每轮都被杀：无重复（绝不重复触达）', new Set(s2.processed).size, 25);

const s3 = simulate({ total: 47, limit: 47, chunk: 5, killEvery: 3 });
eq('47 人 / 每 3 轮被杀一次：跑完', s3.done, true);
eq('47 人 / 每 3 轮被杀一次：恰好 47 人次', s3.processed.length, 47);
eq('47 人 / 每 3 轮被杀一次：无重复', new Set(s3.processed).size, 47);

const s4 = simulate({ total: 100, limit: 25, chunk: 4, killEvery: 2 });
eq('池 100 但 limit=25：恰好 25 人次（不多发）', s4.processed.length, 25);

// ─────────────────────────────────────── 汇总
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
