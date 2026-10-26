#!/usr/bin/env node
/**
 * 限频节拍器（pacing）—— 批量触达任务的「等待时间」唯一真值源
 *
 * 为什么要有这个文件：
 *   之前的 GAP 是驱动脚本自己 `sleep(random(75,210))`，规则散落在各处、无法审计、
 *   也无法保证"红线优先"。这里把它收拢成一个可测试、可审计、可被任何语言调用的节拍器：
 *   驱动脚本每轮只做一件事 —— 问它「下一次该等多久」。
 *
 * 设计原则（顺序不可颠倒）：
 *   ① **红线优先**：任何档位都不得越过硬边界（下限 60s / 上限 300s / 单会话 30 人）。
 *   ② **其次体验**：带方差（避免定长特征）、可预估完工时间、进度可读、非工作时段提前警告。
 *   ③ 想要更快，只允许「拆会话 / 降 N」两条路，**不允许压缩 GAP**。
 *
 * 安全档：
 *   conservative  红线优先    GAP 120–300s  单会话 10  日 20
 *   balanced      风险/体验平衡 GAP  75–210s  单会话 25  日 45
 *   efficient     体验优先    GAP  60–150s  单会话 30  日 60
 *   hr150(*)      招聘日 150  GAP 115–185s  单会话 30  日 150   ← 本版默认
 *   (*) 默认档。
 *       本副本（boss-hr-outreach-safe）面向 BOSS 招聘端「单日 150 触达」场景，
 *       默认档改为 hr150：窗口固定 09:00–11:50 / 13:30–18:00，GAP 均值 145s。
 *       推导过程见 references/hr-daily-150-plan.md。
 *
 * 用法：
 *   node scripts/pacing.mjs profiles                          列出所有档位
 *   node scripts/pacing.mjs plan --count 25 [--profile balanced] [--start 14:17] [--job screen.job.json]
 *   node scripts/pacing.mjs next [--profile balanced] [--risk] [--last 128]     取下一次等待秒数
 *   node scripts/pacing.mjs check --today 45 [--profile balanced] [--at 22:10]  日额度 / 时段检查
 *   任意子命令加 --json 输出机器可读结果
 *
 *   --job <file>  从闸门配置（screen.job*.json 的 limits 段）读取 min/maxGapSeconds、
 *                 dailyMax、activeWindows，覆盖档位默认值 —— 保证「计划」与「闸门」同源。
 *
 * 退出码：0 允许 / 3 额度或时段不允许 / 1 参数错误
 *
 * 作为库使用：
 *   import { nextGap, buildPlan, gate, PROFILES } from './pacing.mjs';
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// ─────────────────────────────────────────────────────────── 硬边界（红线，不可被任何档位越过）
export const HARD_LIMITS = {
  gapFloorSeconds: 60,      // 单次间隔绝对下限：再快就是机器节奏
  gapCeilSeconds: 300,      // 单次间隔绝对上限：再慢就不像"一个人在干活"
  sessionMax: 30,           // 单次会话（一次连续执行）人数上限
  riskMultiplier: 1.5,      // 命中风险信号时该次间隔的放大系数
  consecutiveFailureStop: 2, // 连续 N 次触达失败（校验不通过）即熔断，停止当天剩余操作
};

// ─────────────────────────────────────────────────────────── 安全档
export const PROFILES = {
  conservative: {
    label: '红线优先',
    desc: '企业账号 / 首次使用 / 平台近期有动作时用。宁可慢，不求多。',
    minGapSeconds: 120, maxGapSeconds: 300,
    sessionMax: 10, dailyMax: 20,
    activeWindows: [['09:30', '11:30'], ['14:00', '17:30']],
  },
  balanced: {
    label: '风险与体验平衡',
    desc: '已验证过的默认档。基线 75–210s 不压缩，风险信号自动拉长。',
    minGapSeconds: 75, maxGapSeconds: 210,
    sessionMax: 25, dailyMax: 45,
    activeWindows: [['09:30', '11:30'], ['14:00', '17:30']],
  },
  efficient: {
    label: '体验优先',
    desc: '任务时间敏感时用。已贴近安全下限，仍受硬边界保护。',
    minGapSeconds: 60, maxGapSeconds: 150,
    sessionMax: 30, dailyMax: 60,
    activeWindows: [['09:00', '12:00'], ['13:30', '18:00']],
  },
  hr150: {
    label: '招聘日 150',
    desc: 'BOSS 招聘端「单日 150 触达」专用档。窗口对齐 09:00–11:50 / 13:30–18:00，'
        + 'GAP 115–185s（均值 145s，远离 60s 机器下限），按 6 个会话拆分执行。'
        + '日上限 150 是「时间窗口 ÷ 安全 GAP」反推出来的物理上限，'
        + '不是配额上限——请先读 references/hr-daily-150-plan.md。',
    minGapSeconds: 115, maxGapSeconds: 185,
    sessionMax: 30, dailyMax: 150,
    activeWindows: [['09:00', '11:50'], ['13:30', '18:00']],
  },
};

const DEFAULT_PROFILE = 'hr150';
const JITTER_RATIO = 0.15;   // ±15% 抖动：足以打破定长特征，又不会跑出安全带

// ─────────────────────────────────────────────────────────── 工具
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toSec = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 3600 + m * 60; };

export function resolveProfile(name) {
  const key = name || DEFAULT_PROFILE;
  const p = PROFILES[key];
  if (!p) {
    const err = new Error(`未知档位 "${key}"，可选：${Object.keys(PROFILES).join(' / ')}`);
    err.code = 'BAD_PROFILE';
    throw err;
  }
  return { key, ...p };
}

// 读闸门配置的 limits 段做覆盖（保持「计划」与「闸门」同源）
function readJobLimits(file) {
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j?.limits || j?.job?.limits || null;
  } catch { return null; }
}

function applyJobLimits(profile, limits) {
  if (!limits) return profile;
  const merged = { ...profile, _overriddenBy: [] };
  for (const k of ['minGapSeconds', 'maxGapSeconds', 'dailyMax', 'activeWindows']) {
    if (limits[k] !== undefined) { merged[k] = limits[k]; merged._overriddenBy.push(k); }
  }
  if (limits.limits?.minGapSeconds) { /* 兼容嵌套 */ }
  return merged;
}

// ─────────────────────────────────────────────────────────── 核心：取下一次间隔
/**
 * 计算下一次触达前的等待秒数。
 * @param {object} profile  resolveProfile(...) 的结果
 * @param {object} opts
 *   risk      {boolean} 上一次是否命中风险信号（重试 / 页面不可见 / 校验走冗余分支 / 明显变慢）
 *   last      {number}  上一次实际等待秒数（可选，仅用于日志对比）
 *   index     {number}  本批次内的序号（0 基；0 表示首次，不等待）
 * @returns {{seconds:number, base:number, reason:string, risk:boolean, atCeil:boolean}}
 */
export function nextGap(profile, opts = {}) {
  const { risk = false, last = null, index = 1 } = opts;

  if (index <= 0) {
    return { seconds: 0, base: 0, reason: '首次触达，无需等待', risk: false, atCeil: false };
  }

  const lo = Math.max(HARD_LIMITS.gapFloorSeconds, profile.minGapSeconds ?? HARD_LIMITS.gapFloorSeconds);
  const hi = Math.min(HARD_LIMITS.gapCeilSeconds, profile.maxGapSeconds ?? 210);

  const base = randInt(lo, Math.max(lo, hi));
  // 抖动：倍率落在 [1-0.15, 1+0.15]，再 clamp 回安全带
  const jitterFactor = 1 + (Math.random() * 2 - 1) * JITTER_RATIO;
  let seconds = Math.round(base * jitterFactor);
  seconds = clamp(seconds, lo, hi);

  let reason = `基线 ${base}s ±${Math.round(JITTER_RATIO * 100)}% 抖动`;
  let atCeil = false;

  if (risk) {
    const stretched = Math.round(seconds * HARD_LIMITS.riskMultiplier);
    const capped = Math.min(stretched, HARD_LIMITS.gapCeilSeconds);
    atCeil = capped < stretched;
    seconds = capped;
    reason = `命中风险信号 → ${HARD_LIMITS.riskMultiplier}× → ${seconds}s${atCeil ? '（已触硬上限）' : ''}`;
  }

  if (last !== null) reason += `　（上次实际 ${last}s）`;

  return { seconds, base, reason, risk, atCeil };
}

// ─────────────────────────────────────────────────────────── 计划
/**
 * 生成整批的执行计划（时间表）。
 * @returns {{profile, windows, totalSeconds, plan:[{order,gapSeconds,plannedAt,clockSeconds,risk}], warnings:string[]}}
 */
export function buildPlan(profile, { count, start = null, now = new Date() } = {}) {
  const n = Math.max(0, Math.min(Number(count) || 0, HARD_LIMITS.sessionMax));
  const warnings = [];

  if (Number(count) > HARD_LIMITS.sessionMax) {
    warnings.push(`请求 ${count} 人 > 单会话硬上限 ${HARD_LIMITS.sessionMax} 人，已截断。请拆成多次会话执行。`);
  }
  if (Number(count) > (profile.sessionMax ?? HARD_LIMITS.sessionMax)) {
    warnings.push(`请求 ${count} 人 > 档位「${profile.label}」建议单会话 ${profile.sessionMax} 人。建议拆会话，不要压缩间隔。`);
  }

  // 起点
  let cursor;
  if (start) {
    const [h, m] = String(start).split(':').map(Number);
    cursor = new Date(now); cursor.setHours(h, m, 0, 0);
  } else {
    cursor = new Date(now.getTime());
  }

  const plan = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const g = nextGap(profile, { index: i });
      cursor = new Date(cursor.getTime() + g.seconds * 1000);
      plan.push({
        order: i + 1,
        gapSeconds: g.seconds,
        gapReason: g.reason,
        plannedAt: hhmm(cursor),
        plannedAtFull: `${hhmm(cursor)}:${pad(cursor.getSeconds())}`,
        risk: false,
      });
    } else {
      plan.push({
        order: 1, gapSeconds: 0, gapReason: '首次触达，无需等待',
        plannedAt: hhmm(cursor), plannedAtFull: `${hhmm(cursor)}:${pad(cursor.getSeconds())}`, risk: false,
      });
    }
  }

  const totalSeconds = plan.reduce((s, p) => s + p.gapSeconds, 0);
  const windows = profile.activeWindows || PROFILES[DEFAULT_PROFILE].activeWindows;
  const inWindow = isInWindows(cursor, windows);
  if (!inWindow) {
    warnings.push(`预计结束时间 ${hhmm(cursor)} 落在允许时段之外（${windows.map((w) => w.join('-')).join(' / ')}）。` +
      `非工作时段触达更容易被接收方记住，建议在时段内执行。`);
  }
  if (plan.length && totalSeconds / 60 > 90) {
    warnings.push(`本批预计耗时 ${(totalSeconds / 60).toFixed(0)} 分钟。单次会话超过 90 分钟不利于"一个人在干活"的行为形态，建议拆会话。`);
  }

  return { profile: profile.key ?? profile.label, windows, totalSeconds, plan, warnings, inWindow };
}

function isInWindows(date, windows) {
  const cur = date.getHours() * 3600 + date.getMinutes() * 60;
  return (windows || []).some(([a, b]) => cur >= toSec(a) && cur <= toSec(b));
}

// ─────────────────────────────────────────────────────────── 额度 / 时段闸门
/**
 * @returns {{allowed:boolean, reasons:string[], quotaLeft:number, todayTouched:number, dailyMax:number, inWindow:boolean, windows}}
 */
export function gate(profile, { todayTouched = 0, at = null } = {}) {
  const dailyMax = profile.dailyMax ?? PROFILES[DEFAULT_PROFILE].dailyMax;
  const quotaLeft = Math.max(0, dailyMax - todayTouched);
  const windows = profile.activeWindows || PROFILES[DEFAULT_PROFILE].activeWindows;

  let when = new Date();
  if (at) { const [h, m] = String(at).split(':').map(Number); when = new Date(); when.setHours(h, m, 0, 0); }
  const inWindow = isInWindows(when, windows);

  const reasons = [];
  if (quotaLeft <= 0) reasons.push(`今日触达额度已用尽（${todayTouched}/${dailyMax}）`);
  if (!inWindow) reasons.push(`当前 ${hhmm(when)} 不在允许时段（${windows.map((w) => w.join('-')).join(' / ')}）`);

  return { allowed: reasons.length === 0, reasons, quotaLeft, todayTouched, dailyMax, inWindow, windows };
}

// ─────────────────────────────────────────────────────────── CLI
function parseArgs(argv) {
  const o = { profile: null, count: null, start: null, job: null, risk: false, last: null, today: null, at: null, json: false };
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  for (let i = cmd === argv[0] ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[i + 1];
    if (a === '--json') o.json = true;
    else if (a === '--risk') o.risk = true;
    else if (a === '--profile') { o.profile = val(); i++; }
    else if (a === '--count') { o.count = Number(val()); i++; }
    else if (a === '--start') { o.start = val(); i++; }
    else if (a === '--job') { o.job = val(); i++; }
    else if (a === '--last') { o.last = Number(val()); i++; }
    else if (a === '--today') { o.today = Number(val()); i++; }
    else if (a === '--at') { o.at = val(); i++; }
  }
  return { cmd, o };
}

function printHelp() {
  console.log(`限频节拍器 · 用法

  node scripts/pacing.mjs profiles
  node scripts/pacing.mjs plan --count 25 [--profile balanced] [--start 14:17] [--job screen.job.json] [--json]
  node scripts/pacing.mjs next [--profile balanced] [--risk] [--last 128] [--json]
  node scripts/pacing.mjs check --today 45 [--profile balanced] [--at 22:10] [--json]

档位：${Object.keys(PROFILES).join(' / ')}（默认 ${DEFAULT_PROFILE}）
硬边界：GAP ${HARD_LIMITS.gapFloorSeconds}–${HARD_LIMITS.gapCeilSeconds}s，单会话 ≤ ${HARD_LIMITS.sessionMax} 人
退出码：0 允许 / 3 不允许 / 1 参数错误`);
}

function main() {
  const { cmd, o } = parseArgs(process.argv.slice(2));

  let profile;
  try { profile = resolveProfile(o.profile); }
  catch (e) { console.error(e.message); process.exit(1); }

  const jobLimits = readJobLimits(o.job);
  const eff = applyJobLimits(profile, jobLimits);

  switch (cmd) {
    case 'profiles': {
      const out = Object.entries(PROFILES).map(([k, p]) => ({
        key: k, label: p.label, desc: p.desc,
        gap: `${p.minGapSeconds}–${p.maxGapSeconds}s`, sessionMax: p.sessionMax, dailyMax: p.dailyMax,
        activeWindows: p.activeWindows.map((w) => w.join('-')).join(' / '),
      }));
      if (o.json) console.log(JSON.stringify({ hardLimits: HARD_LIMITS, profiles: out }, null, 2));
      else {
        console.log('\n安全档：');
        for (const p of out) {
          console.log(`  ${p.key === DEFAULT_PROFILE ? '★' : ' '} ${p.key.padEnd(14)} ${p.label.padEnd(10)} GAP ${p.gap.padEnd(12)} 单会话 ${String(p.sessionMax).padStart(2)}  日 ${String(p.dailyMax).padStart(2)}  时段 ${p.activeWindows}`);
          console.log(`    ${p.desc}`);
        }
        console.log(`\n硬边界（任何档位都不可越过）：GAP ${HARD_LIMITS.gapFloorSeconds}–${HARD_LIMITS.gapCeilSeconds}s　单会话 ≤ ${HARD_LIMITS.sessionMax}　风险 ×${HARD_LIMITS.riskMultiplier}　连败 ${HARD_LIMITS.consecutiveFailureStop} 次熔断\n`);
      }
      break;
    }

    case 'plan': {
      if (o.count === null || Number.isNaN(o.count)) { console.error('plan 需要 --count <N>'); process.exit(1); }
      const r = buildPlan(eff, { count: o.count, start: o.start });
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`\n计划 · 档位 ${eff.label}（${eff.key}）${jobLimits ? ' · 参数已与闸门配置对齐' : ''}`);
        console.log(`预计总等待 ${(r.totalSeconds / 60).toFixed(1)} 分钟（${r.totalSeconds}s），共 ${r.plan.length} 人`);
        console.log('─'.repeat(64));
        for (const p of r.plan) {
          console.log(`  ${String(p.order).padStart(2)}. ${p.plannedAtFull}  ${p.gapSeconds ? `+${String(p.gapSeconds).padStart(3)}s` : '  起点'}  ${p.gapReason}`);
        }
        if (r.warnings.length) { console.log('\n提示：'); r.warnings.forEach((w) => console.log(`  · ${w}`)); }
        console.log('');
      }
      break;
    }

    case 'next': {
      const r = nextGap(eff, { risk: o.risk, last: o.last, index: 1 });
      if (o.json) console.log(JSON.stringify({ ...r, profile: eff.key }, null, 2));
      else console.log(`下一次等待：${r.seconds}s　（${r.reason}）`);
      break;
    }

    case 'check': {
      const r = gate(eff, { todayTouched: o.today ?? 0, at: o.at });
      if (o.json) console.log(JSON.stringify({ ...r, profile: eff.key }, null, 2));
      else {
        console.log(`\n额度：今日 ${r.todayTouched}/${r.dailyMax}　剩余 ${r.quotaLeft}`);
        console.log(`时段：${r.inWindow ? '在允许时段内' : '不在允许时段'}`);
        console.log(`结论：${r.allowed ? '允许执行' : '不允许 —— ' + r.reasons.join('；')}\n`);
      }
      process.exit(r.allowed ? 0 : 3);
    }

    default:
      printHelp();
  }
}

// 仅在直接执行时跑 CLI（被 import 时不跑）
const invokedDirectly = !!(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invokedDirectly) main();
