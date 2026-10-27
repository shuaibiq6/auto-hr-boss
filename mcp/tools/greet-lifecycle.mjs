#!/usr/bin/env node
/**
 * greet-lifecycle.mjs — boss_greet_status / boss_greet_stop / boss_greet_verify
 * 映射：status.mjs --json / detach.mjs --stop / verify-greets.mjs --json --out
 */

import fs from 'node:fs';
import path from 'node:path';
import { runNode, parseJsonFromStdout, ok, errResult, PATHS, readJsonArr, localStamp } from '../lib.mjs';
import {
  readJob, writeJob, findCurrentJob, isActiveJob, fetchEngineStatus, projectStatus, jobOut, jobPlanFile, jobDir, loadConfig,
} from '../state.mjs';
import { proxyCall } from '../proxy.mjs';

// ─────────────────────────────────────────────────────────── boss_greet_status
export const greetStatus = {
  name: 'boss_greet_status',
  title: '查询 Job 状态',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: '查询 Job 状态与进度（聚合 status.mjs + job 注册表）。'
    + 'wait_seconds>0 时有界阻塞等待变化（供无 progress 通知的客户端轮询）。'
    + '语义：stopped/aborted 都可续跑（再调 greet_start 同 plan 即可）；blocked 为当日终态。'
    + '结果以 verify 为准（日志 ✅ 不作为验收依据）。',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: '省略 = 活动 job；再无则最近 job' },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 50, default: 0 },
      include: { type: 'array', items: { type: 'string', enum: ['watchdog', 'proxy_health', 'log_tail'] }, default: [] },
    },
  },
  async handler(args = {}) {
    const current = findCurrentJob(); // T5-3：避免对 findCurrentJob 重复调用（内部每次 listJobs 读盘）
    const jobId = args.job_id || (current && current.job_id);
    if (!jobId) return errResult('E_JOB_NOT_FOUND', '无 job（先跑 boss_greet_start）');
    const job = readJob(jobId);
    if (!job) return errResult('E_JOB_NOT_FOUND', `job 不存在：${jobId}`);

    const wait = Math.max(0, Math.min(50, Number(args.wait_seconds ?? 0)));
    const { exit, engine } = await fetchEngineStatus(jobId, { wait, health: true });
    const proj = projectStatus(job, engine, exit);

    const persisted = { status: proj.status, progress: proj.progress, counts: proj.counts, stop_reason: proj.stop_reason, abort_reason: proj.abort_reason, heartbeat_age_sec: proj.heartbeat_age_sec, watchdog: proj.watchdog, breaker_open: proj.breaker_open };
    writeJob(jobId, persisted);

    const data = {
      job_id: jobId,
      status: proj.status,
      mode: job.mode,
      progress: proj.progress,
      counts: proj.counts,
      current: proj.current,
      stop_reason: proj.stop_reason,
      abort_reason: proj.abort_reason,
      heartbeat_age_sec: proj.heartbeat_age_sec,
      watchdog: proj.watchdog,
      breaker_open: proj.breaker_open,
      verify: job.verify || { status: 'pending' },
      engine_status: engine ? engine.status : null,
    };

    const include = args.include || [];
    if (include.includes('proxy_health')) {
      const h = await proxyCall('GET', '/health', { proxy: loadConfig().proxy });
      data.proxy_health = { connected: !!(h.ok && h.body && h.body.connected), ok: h.ok };
    }
    if (include.includes('log_tail')) {
      data.log_tail = tailFile(path.join(jobDir(jobId), 'greet.log'), 200);
    }

    const text = `job ${jobId} 状态 ${proj.status}，进度 ${proj.progress.done}/${proj.progress.total}（ok ${proj.counts.ok} / failed ${proj.counts.failed} / skipped ${proj.counts.skipped}）`;
    return ok(text, data);
  },
};

// ─────────────────────────────────────────────────────────── boss_greet_stop
export const greetStop = {
  name: 'boss_greet_stop',
  title: '停止 Job',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: '停止一个 Job 的守夜人及其子进程（Windows: taskkill /T；其他平台进程组信号）。'
    + '停止后可原样重跑 greet_start 续跑（--resume 幂等）。',
  inputSchema: {
    type: 'object',
    required: ['job_id'],
    properties: {
      job_id: { type: 'string' },
      reason: { type: 'string', description: '停止原因（写入 job.json 便于审计）' },
    },
  },
  async handler(args = {}) {
    const jobId = args.job_id;
    const job = readJob(jobId);
    if (!job) return errResult('E_JOB_NOT_FOUND', `job 不存在：${jobId}`);
    const r = await runNode('detach.mjs', ['--stop', '--out', jobOut(jobId)], { timeoutMs: 20000 });
    if (isActiveJob(job)) writeJob(jobId, { status: 'stopped', stop_reason: args.reason || '手动停止' });
    return ok(`已停止 ${jobId}`, { job_id: jobId, stopped: true, graceful: true, note: '原样重跑 greet_start 可续跑' });
  },
};

// ─────────────────────────────────────────────────────────── boss_greet_verify
export const greetVerify = {
  name: 'boss_greet_verify',
  title: '平台侧核验',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: '平台侧独立核验（验收唯一依据，不采信日志 ✅）。跑完立刻核验——列表重载后卡片与 id 都会变，无法回溯。'
    + 'not_sent>0 属有效业务结果（isError=false），advisory 给出重跑指引。',
  inputSchema: {
    type: 'object',
    required: ['job_id'],
    properties: {
      job_id: { type: 'string' },
      limit: { type: 'integer', description: '只核验前 N 条（默认该 job 已处理数）' },
    },
  },
  async handler(args = {}) {
    const jobId = args.job_id;
    const job = readJob(jobId);
    if (!job) return errResult('E_JOB_NOT_FOUND', `job 不存在：${jobId}`);
    const out = jobOut(jobId);
    const verifyOut = path.join(jobDir(jobId), 'verify.result.json');
    const limit = args.limit != null ? Number(args.limit) : (job.progress && job.progress.done) || 0;

    const argv = ['--plan', jobPlanFile(jobId), '--tid-file', PATHS.runtimeTid, '--out', verifyOut, '--json'];
    if (limit > 0) argv.push('--limit', String(limit));

    const r = await runNode('verify-greets.mjs', argv, { timeoutMs: 90000 });
    const j = parseJsonFromStdout(r.stdout);
    if (!j) {
      if (r.code === 3) return errResult('E_VERIFY_FAILED', '无法核验（页面不可见/登录失效/目标缺失）', (r.stderr || '').slice(-300), '先 boss_session_health，恢复后重试');
      return errResult('E_INTERNAL', '核验失败', (r.stderr || r.stdout || '').slice(-300));
    }
    const summary = {
      total: j.total ?? 0,
      sent: j.sent ?? 0,
      not_sent: (j.notSent || 0) + (j.cardGone || 0) + (j.missingFrame || 0) + (j.unknown || 0),
      card_gone: j.cardGone ?? 0,
      missing_frame: j.missingFrame ?? 0,
      unknown: j.unknown ?? 0,
      error: j.error ?? 0,
    };
    const rows = readJsonArr(verifyOut);
    const verifiedAt = localStamp();
    writeJob(jobId, { verify: { status: summary.not_sent > 0 ? 'partial' : 'ok', verified_at: verifiedAt, summary } });

    const advisory = summary.not_sent > 0
      ? `存在 ${summary.not_sent} 条未送达——建议放入下一批重跑；不要以日志 ✅ 为准。`
      : null;
    const text = summary.not_sent > 0
      ? `核验：${summary.sent}/${summary.total} 送达，${summary.not_sent} 条未送达（见 advisory）`
      : `核验：${summary.sent}/${summary.total} 全部送达`;
    return ok(text, { job_id: jobId, verified_at: verifiedAt, summary, rows, advisory });
  },
};

function tailFile(file, n = 200) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    const lines = s.split(/\r?\n/).filter((l) => l.length);
    return lines.slice(-n);
  } catch { return null; }
}
