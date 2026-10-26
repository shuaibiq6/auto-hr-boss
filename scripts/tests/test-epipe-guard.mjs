#!/usr/bin/env node
/**
 * 断管守卫回归测试（2026-10-13）。
 *
 * 背景：批次的 stdout 是宿主捕获的管道。当读取端消失（回合结束 / 后台任务被摘除 / 管道关闭）时，
 * 下一次 console.log 触发 EPIPE，Node 默认把未处理的流错误**升级成未捕获异常并终止进程** ——
 * 这正是 2026-10-13「25 人批次停在 7/25、日志戛然而止、心跳只有 aborted:true 没有原因」的候选成因。
 *
 * 本测试用**同构 A/B 对照**验证守卫是否真的有意义：
 *   A. 带守卫（= greet-batch.mjs / watchdog.mjs 现在的写法）→ 断管后应继续跑到自然结束
 *   B. 不带守卫（= 修复前的写法）              → 断管后应立刻被带走
 * 若 B 不再被带走，说明本测试已失效（Node 行为变了），需重新评估。
 *
 * 运行：node scripts/tests/test-epipe-guard.mjs
 * 退出码：0 通过 / 1 失败
 */

import { spawn } from 'node:child_process';

const GUARDED = [
  'let outputBroken = false;',
  'try {',
  "  process.stdout.on('error', (e) => {",
  '    const c = e && e.code;',
  "    if (c === 'EPIPE' || c === 'ERR_STREAM_DESTROYED' || c === 'ERR_STREAM_WRITE_AFTER_END') outputBroken = true;",
  '  });',
  "  process.stderr.on('error', () => {});",
  '} catch {}',
  'let n = 0;',
  'const t = setInterval(() => {',
  '  n++;',
  "  if (!outputBroken) { try { console.log('tick ' + n); } catch { outputBroken = true; } }",
  '  if (n >= 40) { clearInterval(t); process.exit(0); }',
  '}, 100);',
].join('\n');

const UNGUARDED = [
  'let n = 0;',
  'const t = setInterval(() => {',
  '  n++;',
  "  console.log('tick ' + n);",
  '  if (n >= 40) { clearInterval(t); process.exit(0); }',
  '}, 100);',
].join('\n');

function run(code, closeAfterMs = 700) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    c.stdout.on('data', () => { /* 先正常读取，保证管道是通的 */ });
    c.stderr.on('data', () => { });
    setTimeout(() => {
      try { c.stdout.destroy(); } catch { /* ignore */ }
      try { c.stderr.destroy(); } catch { /* ignore */ }
    }, closeAfterMs);
    const t0 = Date.now();
    c.on('exit', (code2, sig) => res({ code: code2, sig, aliveMs: Date.now() - t0 }));
  });
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

const a = await run(GUARDED);
const b = await run(UNGUARDED);

console.log('A 有守卫（= 现在的写法）');
console.log(`   存活 ${a.aliveMs}ms　退出码=${a.code}　跑完 40 次=${a.aliveMs >= 3800 ? '是' : '否'}`);
console.log('B 无守卫（= 修复前的写法）');
console.log(`   存活 ${b.aliveMs}ms　退出码=${b.code}　跑完 40 次=${b.aliveMs >= 3800 ? '是' : '否'}`);
console.log('');

check('守卫版在断管后仍跑到自然结束（exit 0）', a.aliveMs >= 3800 && a.code === 0);
check('无守卫版在断管后被带走（这就是要消除的故障）', b.aliveMs < 3800);
check('两者行为有可观测差异（守卫确实起了作用）', a.aliveMs - b.aliveMs > 1500);

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
