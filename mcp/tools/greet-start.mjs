#!/usr/bin/env node
/**
 * greet-start.mjs — boss_greet_start（批量打招呼 Job，立即返回）
 * 映射：detach.mjs → watchdog.mjs → greet-batch.mjs（脱离进程执行）
 * 实现 Server 强制点 #1–#10（详见《03》§10）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { runNode, ok, errResult, PATHS, localStamp } from '../lib.mjs';
import {
  newJobId, loadConfig, touchIds, touchTodayCount,
  isBreakerOpenToday, readBreaker, findActiveLiveJob, resolvePlan, jobDir, jobOut, jobPlanFile, writeJob,
  planHashOf, writeAttestPlan, requireDryAttest,
} from '../state.mjs';
import { PROFILES, resolveProfile, gate } from '../engine-adapter.mjs';

const PROFILE_WHITELIST = Object.keys(PROFILES); // ['conservative','balanced','efficient','hr150']

const DISCLOSURE = '温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。';

export const greetStart = {
  name: 'boss_greet_start',
  title: '启动批量打招呼',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  description: `启动批量打招呼 Job（立即返回，真正执行交给脱离进程的守夜人）。`
    + `mode 必填：dry=只校验不点击（演练）；live=真实触达（受全部安全闸门约束）。`
    + `所有安全闸门由 Server 强制、不可绕过；live 前必须先对本批跑通 dry 演练（当日凭证）。`
    + `respect_window 默认关（连续跑完、跨午休不中断，配合全局去重不重复触达）。live 模式风险披露：${DISCLOSURE}`,
  inputSchema: {
    type: 'object',
    required: ['mode', 'plan'],
    properties: {
      mode: { type: 'string', enum: ['dry', 'live'], description: '必填。dry=只校验不点击；live=真实触达' },
      plan: {
        oneOf: [
          { type: 'string', description: 'plan_id（来自 boss_screen_talent）或 @abs:<绝对路径>' },
          { type: 'array', items: { type: 'object' }, description: '内联候选人数组' },
        ],
      },
      limit: { type: 'integer', minimum: 1, maximum: 150, description: '处理上限（冻结，续跑不超发）' },
      chunk: { type: 'integer', minimum: 1, maximum: 10, default: 8 },
      profile: { type: 'string', enum: PROFILE_WHITELIST, default: 'hr150' },
      deadline: { type: 'string', description: 'HH:MM，到达即优雅停机' },
      respect_window: { type: 'boolean', default: false, description: 'true=到达限频窗口边界即优雅停机；false（默认）=连续跑完' },
      job_name: { type: 'string', description: '备注名（写入触达记录 job 字段）' },
    },
  },
  async handler(args = {}) {
    const mode = args.mode;
    // 强制点 #1：mode 必填
    if (mode !== 'dry' && mode !== 'live') return errResult('E_BAD_INPUT', 'mode 必填（dry 或 live），无默认值');

    const cfg = loadConfig();

    // 强制点 #2：熔断 fail-closed（仅 live；dry 不点击，允许在熔断期演练）
    if (mode === 'live' && isBreakerOpenToday()) {
      return errResult('E_CIRCUIT_OPEN', '当日熔断已开（风控信号），不再允许 live', readBreaker(), '当日不重试；次日 breaker.json 自动过期');
    }

    // 强制点 #3：账号级互斥（live 独占；dry 不参与）
    if (mode === 'live') {
      const active = findActiveLiveJob();
      if (active) return errResult('E_JOB_ACTIVE', `已有活动 live job（${active.job_id}）`, { active_job_id: active.job_id }, '先 boss_greet_status / boss_greet_stop 再启动');
    }

    // 强制点 #6：白名单校验（defense-in-depth）。profile 缺省 hr150（不依赖客户端应用 schema 默认）
    const profileName = args.profile || cfg.default_profile || 'hr150';
    if (!PROFILE_WHITELIST.includes(profileName)) return errResult('E_BAD_INPUT', `profile 非法：${profileName}`);
    let profile;
    try { profile = resolveProfile(profileName); } catch (e) { return errResult('E_BAD_INPUT', e.message); }
    const chunk = Math.max(1, Math.min(10, Number(args.chunk ?? 8)));
    const limitRaw = args.limit != null ? Number(args.limit) : null;

    // 强制点 #5：名单校验 + 交叉去重
    const plan = resolvePlan(args.plan);
    if (!Array.isArray(plan) || !plan.length) return errResult('E_BAD_INPUT', 'plan 为空或格式非法', null, '先跑 boss_screen_talent 生成 plan，或传内联数组');
    const touched = touchIds();
    const alreadyTouched = plan.filter((t) => t && touched.has(String(t.id || t.url || ''))).length;
    const limit = Math.min(limitRaw ?? plan.length, plan.length, 150);
    const hash = planHashOf(plan);
    const respectWindow = !!args.respect_window;

    // 强制点 #10（T1-1）：live 前置体检——本批必须先 dry 演练通过（当日凭证）
    if (mode === 'live') {
      const dryCheck = requireDryAttest(hash);
      if (!dryCheck.ok) return errResult('E_DRY_REQUIRED', dryCheck.message, { plan_hash: hash }, '先 boss_greet_start(mode=dry) 同 plan 跑通一次');
    }

    // 强制点 #4：闸门（live 必过）
    let gateResult = null;
    if (mode === 'live') {
      const todayTouched = touchTodayCount();
      gateResult = gate(profile, { todayTouched });
      if (!gateResult.allowed) {
        return errResult('E_GATE_DENIED', `闸门拒绝：${gateResult.reasons.join('；')}`, gateResult, '等待进入允许时段 / 次日再试；不压缩间隔');
      }
    }

    // 建 job
    const jobId = newJobId();
    const dir = jobDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jobPlanFile(jobId), JSON.stringify(plan, null, 2), 'utf8');

    const jobName = args.job_name || jobId;
    const job = writeJob(jobId, {
      status: 'starting', mode, profile: profileName, chunk, limit,
      plan_total: plan.length, already_touched: alreadyTouched, will_process: limit,
      plan_file: jobPlanFile(jobId), job_name: args.job_name || null,
      created_at: localStamp(), detach: null,
    });

    // 组装 detach 命令（强制点 #7 respect_window 默认关=连续跑完；#9 --commit 恒开）
    const detachArgs = [
      '--plan', jobPlanFile(jobId),
      '--limit', String(limit),
      '--chunk', String(chunk),
      '--touch', PATHS.touch, '--commit',
      '--out', jobOut(jobId),
      '--log', path.join(dir, 'greet.log'),
      '--profile', profileName,
      '--url', cfg.url,
      '--page-match', cfg.page_match,
      '--tid-file', PATHS.runtimeTid,
      '--job', jobName,
    ];
    if (args.deadline) detachArgs.push('--deadline', args.deadline);
    if (respectWindow) detachArgs.push('--respect-window');
    if (mode === 'dry') detachArgs.push('--dry');

    const warnings = [];
    if (alreadyTouched > 0) warnings.push(`${alreadyTouched} 人已在触达记录中，将被引擎跳过（跨会话去重）`);
    if (limit < plan.length) warnings.push(`本批只处理 ${limit}/${plan.length}（limit 冻结）`);
    if (mode === 'live') warnings.push(DISCLOSURE);
    if (mode === 'dry') warnings.push('dry 模式：只定位不点击，用于演练与校验流程');

    const safety = {
      gate: mode === 'live' ? {
        allowed: gateResult.allowed, today_touched: gateResult.todayTouched, daily_max: gateResult.dailyMax,
        in_window: gateResult.inWindow, quota_left: gateResult.quotaLeft,
      } : { allowed: true, note: 'dry 不参与闸门' },
      mutex: { clear: true },
      breaker: { open: isBreakerOpenToday() },
      profile: profileName,
      respect_window: respectWindow,
      commit: true,
      dedup: { already_touched: alreadyTouched },
      dry_attest: mode === 'live' ? { plan_hash: hash, ok: true } : { plan_hash: hash, note: 'dry 演练' },
    };

    const base = { job_id: jobId, accepted: true, mode, will_process: limit, plan: { total: plan.length, already_touched: alreadyTouched, will_process: limit }, safety, warnings };

    // 测试隔离：离线测试设置 BOSS_MCP_TEST_NO_SPAWN=1，不真正拉起脱离进程（避免启动浏览器/代理）。
    if (process.env.BOSS_MCP_TEST_NO_SPAWN === '1') {
      if (mode === 'dry') writeAttestPlan(hash, { dry_ok_at: localStamp(), dry_ok_count: limit });
      writeJob(jobId, { status: 'starting', no_spawn: true });
      return ok(`[no-spawn] 校验通过，跳过真实拉起 ${mode} job ${jobId}（处理 ${limit}/${plan.length}）`, base);
    }

    const r = await runNode('detach.mjs', detachArgs, { timeoutMs: 20000 });
    const detachInfo = readJsonSafe(jobOut(jobId) + '.detach.json');
    const started = writeJob(jobId, { detach: detachInfo ? { pid: detachInfo.pid, started_at: detachInfo.startedAt } : null, status: 'running' });
    if (mode === 'dry') writeAttestPlan(hash, { dry_ok_at: localStamp(), dry_ok_count: limit });

    return ok(`已启动 ${mode} job ${jobId}（处理 ${limit}/${plan.length}）`, { ...base, detach: started.detach });
  },
};

function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
