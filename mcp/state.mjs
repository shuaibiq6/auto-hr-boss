#!/usr/bin/env node
/**
 * state.mjs — MCP Server 的状态层（《03》§3 + 《05》§6）
 *
 * 在 BOSS_MCP_HOME 下维护：
 *   - jobs/<jobId>/job.json         MCP 层 job 元数据（状态机投影，唯一注册表）
 *   - history/breaker.json          当日熔断（fail-closed）
 *   - history/touch.json            全局触达记录（跨 job，唯一事实源）
 *   - plans/<planId>.json           screen_talent 落盘的名单
 *   - runtime.json / runtime.tid.txt 会话 targetId 管理
 *   - config.json                   Server 配置
 *
 * 引擎自身的产物（progress/done/watchdog/detach）仍写在 job 目录内，
 * 文件名与引擎零改动协议完全一致，MCP 只统一「放到哪」。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, HOME, ENGINE_ROOT, ensureHome, readJson, readJsonArr, writeJson, pidAlive, log, localStamp, localDate, todayStr, runNode, withFileLockSync } from './lib.mjs';

// ─────────────────────────────────────────────────────────── 幂等初始化
ensureHome();
if (!fs.existsSync(PATHS.touch)) writeJson(PATHS.touch, []);
cleanupScreenTmp();

// T3-3：清理超过 7 天的筛选临时文件（jobs/_screen_tmp 是流式中间产物，不留垃圾）
function cleanupScreenTmp() {
  const dir = path.join(PATHS.jobs, '_screen_tmp');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────── ID 生成（《03》§3.3）
const hex4 = () => crypto.randomBytes(2).toString('hex');
export function newJobId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `job-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${hex4()}`;
}
export function newPlanId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `plan-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${hex4()}`;
}

// ─────────────────────────────────────────────────────────── 配置
const DEFAULT_CONFIG = {
  v: 1,
  browser: 'edge',
  default_profile: 'hr150',
  default_chunk: 8,
  allow_js_eval: false,
  upload_dirs: [],
  url: 'https://www.zhipin.com/web/chat/recommend',
  page_match: 'zhipin.com',
  proxy: 'http://127.0.0.1:3456',
  action_template: path.join(ENGINE_ROOT, 'templates', 'actions', 'zhipin-boss-greet.json'),
};

/** 从引擎 config.env 读取浏览器偏好（WEB_ACCESS_BROWSER=edge），作为 config 缺省来源 */
function browserPreference() {
  try {
    const env = fs.readFileSync(path.join(ENGINE_ROOT, 'config.env'), 'utf8');
    const m = env.match(/^\s*WEB_ACCESS_BROWSER\s*=\s*(\S+)/m);
    const v = m && m[1] ? m[1].trim().toLowerCase() : null;
    return v === 'chrome' ? 'chrome' : v === 'edge' ? 'edge' : 'edge';
  } catch { return 'edge'; }
}

export function loadConfig() {
  const existing = readJson(PATHS.config) || {};
  const cfg = { ...DEFAULT_CONFIG, ...existing };
  // 未知字段容忍：直接透传；浏览器偏好缺省来自 config.env
  if (!cfg.browser) cfg.browser = browserPreference();
  return cfg;
}
export function saveConfig(patch = {}) {
  const cfg = { ...loadConfig(), ...patch };
  writeJson(PATHS.config, cfg);
  return cfg;
}

// ─────────────────────────────────────────────────────────── runtime（会话 targetId）
export function readRuntime() {
  return readJson(PATHS.runtime) || {};
}
export function saveRuntime(patch = {}) {
  const rt = { ...readRuntime(), ...patch, updated_at: localStamp() };
  writeJson(PATHS.runtime, rt);
  return rt;
}
export function readTid() {
  const rt = readRuntime();
  if (rt.target_id) return String(rt.target_id);
  try { return fs.readFileSync(PATHS.runtimeTid, 'utf8').trim() || null; } catch { return null; }
}
export function saveTid(tid) {
  try { fs.writeFileSync(PATHS.runtimeTid, String(tid || ''), 'utf8'); } catch { /* ignore */ }
  saveRuntime({ target_id: tid || null });
}

// ─────────────────────────────────────────────────────────── 触达记录（全局唯一事实源）
export function readTouch() {
  return readJsonArr(PATHS.touch).filter((r) => r && !r._comment);
}
export function touchTodayCount(day = todayStr()) {
  return readTouch().filter((r) => String(r.ts || '').startsWith(day)).length;
}
export function touchIds() {
  const s = new Set();
  for (const r of readTouch()) if (r && r.id !== undefined && r.id !== null) s.add(String(r.id));
  return s;
}
/** 一次读盘返回触达统计（避免多处各自 readTouch 重复解析 touch.json，T5-3）。 */
export function readTouchStats() {
  const rows = readTouch();
  const today = todayStr();
  const last7 = localDate(new Date(Date.now() - 6 * 86400000));
  const ids = new Set();
  let todayCount = 0, last7Count = 0;
  for (const r of rows) {
    const ts = String(r.ts || '');
    if (ts.startsWith(today)) todayCount++;
    if (ts.slice(0, 10) >= last7) last7Count++;
    if (r && r.id !== undefined && r.id !== null) ids.add(String(r.id));
  }
  return { rows, today: todayCount, last_7d: last7Count, ids };
}

/**
 * 原子追加触达记录（跨进程锁内读-改-写，避免多 Host 并发丢记录 → 配额少计）。
 * 幂等：同 id/url 不重复写。返回 { added, total }。
 */
export function commitTouch(records) {
  return withFileLockSync(PATHS.touch, () => {
    const all = readTouch();
    const seen = new Set(all.map((r) => String(r.id || r.url || '')).filter(Boolean));
    const ts = localStamp();
    let added = 0;
    for (const rec of records) {
      const key = String((rec && (rec.id || rec.url)) || '');
      if (!key) continue; // T5-5：无 id/url 的记录无法去重，拒绝写入
      if (seen.has(key)) continue;
      all.push({ id: rec.id, name: rec.name, title: rec.title, direction: rec.direction, url: rec.url, ts: rec.ts || ts, status: rec.status || 'sent', job: rec.job, via: rec.via });
      seen.add(key);
      added++;
    }
    writeJson(PATHS.touch, all);
    return { added, total: all.length };
  });
}

// ─────────────────────────────────────────────────────────── 熔断（《03》§3.3 / 强制点 #2/#8）
export function readBreaker() {
  return readJson(PATHS.breaker) || null;
}
export function isBreakerOpenToday(day = todayStr()) {
  const b = readBreaker();
  return !!(b && b.date === day);
}
export function writeBreaker(reason, jobId = null) {
  writeJson(PATHS.breaker, { v: 1, date: todayStr(), reason: reason || null, job_id: jobId || null, ts: localStamp() });
  log('breaker 写入', reason, jobId);
}

// ─────────────────────────────────────────────────────────── dry 演练凭证（T1-1：live 前置体检）
/** 名单摘要：按 id/url 排序后的 sha1 前 16 位，作为「同一批人」的稳定标识。 */
export function planHashOf(plan) {
  const ids = (Array.isArray(plan) ? plan : []).map((t) => String((t && (t.id ?? t.url)) ?? '')).sort();
  return crypto.createHash('sha1').update(JSON.stringify(ids)).digest('hex').slice(0, 16);
}
export function readAttest() {
  return readJson(PATHS.attest) || null;
}
/** 当日 dry 凭证（跨日自动失效，需重新 dry）。 */
export function getAttestPlan(hash) {
  const a = readAttest();
  if (!a || a.date !== todayStr() || !a.plans) return null;
  return a.plans[hash] || null;
}
export function writeAttestPlan(hash, patch = {}) {
  return withFileLockSync(PATHS.attest, () => {
    const a = readAttest();
    const base = a && a.date === todayStr() ? a : { v: 1, date: todayStr(), plans: {}, health: null };
    base.plans[hash] = { ...(base.plans[hash] || {}), ...patch };
    writeJson(PATHS.attest, base);
    return base.plans[hash];
  });
}
/** 当日体检凭证（账户级：session_health(deep) / risk_check 通过时写入，供审计）。 */
export function writeAttestHealth(patch = {}) {
  return withFileLockSync(PATHS.attest, () => {
    const a = readAttest();
    const base = a && a.date === todayStr() ? a : { v: 1, date: todayStr(), plans: {}, health: null };
    base.health = { ...(base.health || {}), ...patch };
    writeJson(PATHS.attest, base);
    return base.health;
  });
}
/** live 前置体检：本批必须先 dry 演练通过（凭证当日有效）。 */
export function requireDryAttest(hash) {
  const att = getAttestPlan(hash);
  if (!att || !att.dry_ok_at) {
    return { ok: false, code: 'E_DRY_REQUIRED', message: '本批尚未通过 dry 演练——先 boss_greet_start(mode=dry) 同 plan 跑通，再切 live' };
  }
  return { ok: true, attest: att };
}

// ─────────────────────────────────────────────────────────── job 注册表
export const JOB_STATUSES = ['starting', 'running', 'stopped', 'finished', 'aborted', 'blocked'];
export function jobDir(jobId) { return path.join(PATHS.jobs, jobId); }
export function jobFile(jobId) { return path.join(jobDir(jobId), 'job.json'); }
export function jobOut(jobId) { return path.join(jobDir(jobId), 'greet.result.json'); }
export function jobPlanFile(jobId) { return path.join(jobDir(jobId), 'plan.json'); }

export function readJob(jobId) {
  if (!jobId) return null;
  if (jobId.includes('..') || jobId.includes('/') || jobId.includes('\\')) return null; // 防路径穿越
  return readJson(jobFile(jobId));
}
export function writeJob(jobId, patch = {}) {
  const prev = readJob(jobId) || { v: 1, job_id: jobId };
  const next = { ...prev, ...patch, job_id: jobId, updated_at: localStamp() };
  writeJson(jobFile(jobId), next);
  return next;
}
export function listJobs() {
  let names = [];
  try { names = fs.readdirSync(PATHS.jobs); } catch { return []; }
  return names
    .map((n) => readJson(path.join(PATHS.jobs, n, 'job.json')))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}
export function isActiveJob(j) {
  return !!(j && (j.status === 'starting' || j.status === 'running'));
}
/** 账号级互斥：返回仍在活动状态的 live job（dry 不参与互斥）。 */
export function findActiveLiveJob() {
  return listJobs().find((j) => j.mode === 'live' && isActiveJob(j)) || null;
}
/** 返回「最该被查看」的 job：优先活动 live，其次最近一个。 */
export function findCurrentJob() {
  const jobs = listJobs(); // T5-3：一次 listJobs，避免再经 findActiveLiveJob 内部重复读盘
  const active = jobs.find((j) => j.mode === 'live' && isActiveJob(j));
  return active || jobs[0] || null;
}

// ─────────────────────────────────────────────────────────── plan 存取
export function savePlan(list) {
  const planId = newPlanId();
  writeJson(path.join(PATHS.plans, planId + '.json'), list);
  return planId;
}
export function readPlan(planId) {
  if (!planId) return null;
  if (planId.includes('..') || planId.includes('/') || planId.includes('\\')) return null;
  const arr = readJsonArr(path.join(PATHS.plans, planId + '.json'));
  return arr.length ? arr : null;
}
export function planPath(planId) { return path.join(PATHS.plans, planId + '.json'); }

/**
 * 解析 greet_start 的 plan 参数为数组（《03》§5.8）：
 *   string：plan_id（来自 screen_talent）或 `@abs:` 绝对路径；
 *   array：内联候选人数组。
 */
export function resolvePlan(plan) {
  if (Array.isArray(plan)) return plan;
  if (typeof plan === 'string') {
    if (plan.startsWith('@abs:')) { const a = readJsonArr(plan.slice(5)); return a.length ? a : null; }
    const byId = readPlan(plan);
    if (byId) return byId;
    const arr = readJsonArr(plan); // 兜底：把字符串当作路径
    return arr.length ? arr : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────── 引擎状态投影（《03》§3.2）
const RISK_RE = /熔断|风控|验证码|答题|频繁|拦截|captcha|quiz/i;

export function engineCircuitSignal(engine) {
  if (!engine) return null;
  const wd = engine.watchdog || {};
  if (Number(wd.lastExit) === 4) return 'watchdog 命中熔断（exit 4）';
  const texts = [engine.stopReason, engine.abortReason, wd.stopReason].filter(Boolean);
  const hit = texts.find((t) => RISK_RE.test(String(t)));
  if (hit) return `风控/熔断信号：${hit}`;
  return null;
}

/**
 * 把引擎 status.mjs 的 JSON payload 投影到 MCP job 状态机。
 * 返回 { status, counts, progress, current, stop_reason, abort_reason, watchdog, heartbeat_age_sec, verify, engine }
 */
export function projectStatus(job, engine, engineExit) {
  const mode = job && job.mode;
  let status = engine && engine.status ? engine.status : null;

  // 强制点 #8：检测到风控/熔断信号 → 写 breaker（fail-closed）
  const signal = engineCircuitSignal(engine);
  if (signal && !isBreakerOpenToday()) writeBreaker(signal, job && job.job_id);

  const breakerOpen = isBreakerOpenToday();
  if (status == null) {
    // status.mjs exit 3（无状态文件）：detach 已写但引擎尚未产出 → starting；否则 aborted
    const detach = engine && engine.detachFile ? readJson(engine.detachFile) : null;
    status = detach ? 'starting' : (job ? 'aborted' : 'starting');
  }

  // blocked：live 且未完成，且当日熔断已开（或存在风控信号）
  if (mode === 'live' && status !== 'finished' && status !== 'running' && (breakerOpen || signal)) {
    status = 'blocked';
  }

  const heartbeat = engine && engine.ageSeconds != null ? engine.ageSeconds : null;

  return {
    status,
    progress: { total: engine?.total ?? 0, done: engine?.done ?? 0, remaining: engine?.remaining ?? 0 },
    counts: { ok: engine?.ok ?? 0, failed: engine?.failed ?? 0, skipped: engine?.skipped ?? 0 },
    current: engine?.current || null,
    stop_reason: engine?.stopReason || null,
    abort_reason: engine?.abortReason || null,
    heartbeat_age_sec: heartbeat,
    watchdog: engine?.watchdog ? {
      alive: !!engine.watchdog.alive,
      status: engine.watchdog.status || null,
      pid: engine.watchdog.pid ?? null,
      restarts: engine.watchdog.restarts ?? 0,
      remaining: engine.watchdog.remaining ?? null,
    } : null,
    breaker_open: breakerOpen,
    engine,
  };
}

/** 调 status.mjs 拿到引擎实时状态（复用取最新逻辑，不重复发明）。 */
export async function fetchEngineStatus(jobId, { wait = 0, health = true } = {}) {
  const out = jobOut(jobId);
  const args = ['--out', out, '--json'];
  if (health) args.push('--health');
  if (wait > 0) args.push('--wait', String(Math.max(1, Math.min(50, wait))));
  const r = await runNode('status.mjs', args, { timeoutMs: (wait > 0 ? wait : 12) * 1000 + 8000 });
  return { exit: r.code, engine: r.code === 3 ? null : parseEngineJson(r.stdout) };
}

function parseEngineJson(stdout) {
  try {
    const t = String(stdout || '').trim();
    const i = t.indexOf('{');
    if (i === -1) return null;
    return JSON.parse(t.slice(i));
  } catch { return null; }
}
