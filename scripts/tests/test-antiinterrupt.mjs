#!/usr/bin/env node
// 位置无关：从 scripts/tests/ 用相对路径 import，任何机器克隆后可直接运行。
// 运行： node scripts/tests/test-antiinterrupt.mjs
/**
 * 抗中断能力的离线回归测试（不联网、不点页面）
 *
 * 覆盖 2026-10-13 新增的纯函数与"守护循环"的核心正确性：
 *   1) resumeDoneSet    —— 续跑跳过哪些
 *   2) mergeResults     —— 结果文件跨块累积且不重复
 *   3) planWindow       —— limit / resume / chunk 的组合语义
 *   4) 守护循环收敛性    —— 分块续跑必然终止、总数恰好等于计划量、且无重复
 *   5) buildProgressSnapshot / pidAlive —— 心跳与锁的判据
 *
 * 运行：node test-antiinterrupt.mjs
 */

import {
  resumeDoneSet, mergeResults, planWindow, buildProgressSnapshot, pidAlive,
  idsToSet, touchDoneSet, inWindowAt,
} from '../greet-batch.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      实际 ${g}\n      期望 ${w}`); }
};
const ok = (name, cond) => eq(name, !!cond, true);

console.log('== 1) resumeDoneSet：续跑应跳过哪些 ==');
{
  const prev = [
    { id: 'a', status: 'succeeded' },
    { id: 'b', status: 'skipped-already' },
    { id: 'c', status: 'unverified' },     // 未确认 → 保留重试
    { id: 'd', status: 'failed' },         // 失败 → 保留重试
    { id: 'e', status: 'dry-ok' },
    { id: 'f', status: 'skipped-nobutton' },
    { id: 'g', status: 'skipped-prior' },
    { id: null, status: 'succeeded' },     // 脏数据不应崩
    null,
  ];
  const s = resumeDoneSet(prev);
  eq('跳过集合 = a,b,e,f,g', [...s].sort(), ['a', 'b', 'e', 'f', 'g']);
  ok('未确认/失败不在跳过集合', !s.has('c') && !s.has('d'));
  eq('非数组入参返回空集', [...resumeDoneSet(null)], []);
}

console.log('\n== 2) mergeResults：跨块累积、同 id 覆盖 ==');
{
  const prev = [{ id: 'a', status: 'succeeded', n: 1 }, { id: 'b', status: 'succeeded', n: 1 }];
  const cur = [{ id: 'b', status: 'succeeded', n: 2 }, { id: 'c', status: 'succeeded', n: 1 }];
  const m = mergeResults(prev, cur);
  eq('顺序为 a,b,c', m.map((x) => x.id), ['a', 'b', 'c']);
  eq('b 被新结果覆盖', m.find((x) => x.id === 'b').n, 2);
  eq('无重复', m.length, new Set(m.map((x) => x.id)).size);
  eq('空 prev 也能合并', mergeResults([], cur).map((x) => x.id), ['b', 'c']);
}

console.log('\n== 3) planWindow：limit / resume / chunk 组合 ==');
{
  const all = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }));
  const a = planWindow(all, { limit: 47 });
  eq('limit=47 → 本批 47（无 chunk）', a.list.length, 47);
  eq('limit=47 → 剩余 0', a.remaining, 0);

  const b = planWindow(all, { limit: 47, chunk: 12 });
  eq('limit=47 chunk=12 → 本批 12', b.list.length, 12);
  eq('limit=47 chunk=12 → 剩余 35', b.remaining, 35);
  eq('limit=47 chunk=12 → 池大小 47', b.poolSize, 47);

  const done = new Set(['1', '2', '3']);
  const c = planWindow(all, { limit: 47, doneIds: done, chunk: 12 });
  eq('跳过 1-3 后本批 12 人', c.list.length, 12);
  eq('跳过 1-3 后首个是 4 号', c.list[0].id, '4');
  eq('跳过 1-3 后剩余 32', c.remaining, 32);

  ok('chunk 大于池大小时取全部', planWindow(all, { limit: 5, chunk: 99 }).list.length === 5);
  ok('doneIds 覆盖全部时本批为空且剩余 0', (() => {
    const allDone = new Set(all.slice(0, 47).map((x) => x.id));
    const r = planWindow(all, { limit: 47, doneIds: allDone, chunk: 12 });
    return r.list.length === 0 && r.remaining === 0;
  })());
}

console.log('\n== 4) 守护循环收敛性：分块续跑必然终止、总数恰好、无重复 ==');
{
  const all = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }));
  const LIMIT = 47, CHUNK = 12;
  let prevResults = [];
  const processedOrder = [];
  let rounds = 0;
  for (;;) {
    const { list, remaining } = planWindow(all, { limit: LIMIT, doneIds: resumeDoneSet(prevResults), chunk: CHUNK });
    if (!list.length) { eq('无剩余时本批为空', remaining, 0); break; }
    rounds += 1;                       // 只统计"真的干了活"的轮次，与守护进程一致
    if (rounds > 50) break;
    const cur = list.map((t) => { processedOrder.push(t.id); return { ...t, status: 'succeeded' }; });
    prevResults = mergeResults(prevResults, cur);
  }
  eq('总处理人数恰好 = 计划量 47', processedOrder.length, LIMIT);
  eq('处理过程无重复', new Set(processedOrder).size, LIMIT);
  eq('最终结果文件条数 = 47', prevResults.length, LIMIT);
  ok(`轮数合理（实际 ${rounds} 轮，期望 4 轮）`, rounds === 4);
}

console.log('\n== 5) 心跳快照与锁判据 ==');
{
  const s = buildProgressSnapshot({ pid: 123, total: 47, done: 20, ok: 20, remaining: 27, current: { id: 'x' } });
  eq('版本号', s.v, 1);
  eq('字段透传', [s.pid, s.total, s.done, s.ok, s.remaining], [123, 47, 20, 20, 27]);
  eq('默认值', [s.failed, s.skipped, s.graceful, s.finished, s.aborted], [0, 0, false, false, false]);
  ok('updatedAt 是 ISO 串', /^\d{4}-\d{2}-\d{2}T/.test(s.updatedAt));
  eq('当前 PID 判定为存活', pidAlive(process.pid), true);
  eq('不存在的 PID 判定为死亡', pidAlive(999999999), false);
  eq('空 PID 判定为死亡', pidAlive(null), false);
}

console.log('\n== 6) 多源已办集合（进程被杀时结果文件可能不存在） ==');
{
  // 场景：进程被宿主回收，结果文件压根没写，只有心跳里的 doneIds 与触达记录可用
  const prevProgress = { doneIds: ['a', 'b', 'c'] };
  const prevTouch = [{ id: 'c' }, { id: 'd' }, { name: '无id的脏记录' }, null];
  const prevResults = [];   // 结果文件缺失

  const fromProgress = idsToSet(prevProgress.doneIds);
  const fromTouch = touchDoneSet(prevTouch);
  const union = new Set([...resumeDoneSet(prevResults), ...fromProgress, ...fromTouch]);
  eq('心跳 doneIds 可还原', [...fromProgress].sort(), ['a', 'b', 'c']);
  eq('触达记录可还原（忽略脏数据）', [...fromTouch].sort(), ['c', 'd']);
  eq('多源并集 a,b,c,d', [...union].sort(), ['a', 'b', 'c', 'd']);
  eq('空入参不炸', [...idsToSet(null), ...touchDoneSet(undefined)], []);

  // 端到端语义：25 人计划里前 7 人已发（只有触达记录），--resume 后应只剩 18 人
  const all = Array.from({ length: 25 }, (_, i) => ({ id: 'p' + (i + 1) }));
  const touchOnly = all.slice(0, 7).map((x) => ({ id: x.id }));
  const done = new Set([...resumeDoneSet([]), ...idsToSet([]), ...touchDoneSet(touchOnly)]);
  const { list, remaining } = planWindow(all, { limit: 25, doneIds: done, chunk: null });
  eq('结果文件缺失时仍能正确续跑：本批 18 人', list.length, 18);
  eq('首个是第 8 人', list[0].id, 'p8');
  eq('剩余 0（一次跑完）', remaining, 0);
}

console.log('\n== 7) 守窗判定（秒精度，含"等完 GAP 之后"的越窗防护） ==');
{
  const hr150 = { activeWindows: [['09:00', '11:50'], ['13:30', '18:00']] };
  const at = (h, m, s = 0) => new Date(2026, 9, 13, h, m, s);
  eq('09:00 边界内', inWindowAt(hr150, at(9, 0)), true);
  eq('11:50 边界内（含）', inWindowAt(hr150, at(11, 50)), true);
  eq('11:50:01 已越窗', inWindowAt(hr150, at(11, 50, 1)), false);
  eq('11:52（等完 GAP 后）判定为越窗 —— 这正是要拦住的情况', inWindowAt(hr150, at(11, 52)), false);
  eq('午休 12:30 窗口外', inWindowAt(hr150, at(12, 30)), false);
  eq('13:30 下午窗口开启', inWindowAt(hr150, at(13, 30)), true);
  eq('18:00 边界内（含）', inWindowAt(hr150, at(18, 0)), true);
  eq('无时段配置时默认放行', inWindowAt({}, at(12, 30)), true);
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);