#!/usr/bin/env node
/**
 * pacing-risk.mjs — boss_pacing / boss_risk_check
 * 映射：直接 import pacing.mjs 纯函数（零进程开销）；risk-check.mjs --json
 */

import { HARD_LIMITS, PROFILES, resolveProfile, nextGap, buildPlan, gate } from '../engine-adapter.mjs';
import { runNode, parseJsonFromStdout, ok, errResult, localStamp } from '../lib.mjs';
import { readTid, writeBreaker, touchTodayCount, writeAttestHealth } from '../state.mjs';

function resolveProfileSafe(name) {
  try { return { profile: resolveProfile(name) }; }
  catch (e) { return { err: e.message }; }
}

// ─────────────────────────────────────────────────────────── boss_pacing
export const pacing = {
  name: 'boss_pacing',
  title: '限频节拍器',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: '限频节拍器（配额、时段、时间表、下次等待）。纯计算，不改任何状态。'
    + '档位 hard 边界：GAP 60–300s、单会话 ≤30 人、风险 ×1.5、连败 2 次熔断。'
    + 'greet_start 内部会强制再跑一次 gate，这里只做预演。',
  inputSchema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['profiles', 'plan', 'next', 'check'] },
      count: { type: 'integer', minimum: 0 },
      profile: { type: 'string', enum: ['conservative', 'balanced', 'efficient', 'hr150'] },
      start: { type: 'string', description: 'HH:MM，计划起点' },
      risk: { type: 'boolean', description: '上一次是否命中风险信号' },
      last: { type: 'integer', description: '上一次实际等待秒数' },
      today: { type: 'integer', description: 'op=check 时今日已触达数（省略则读全局 touch）' },
      at: { type: 'string', description: 'HH:MM，检查指定时刻' },
    },
  },
  async handler(args = {}) {
    const op = args.op;
    if (op === 'profiles') {
      const profiles = Object.entries(PROFILES).map(([key, p]) => ({
        key, label: p.label, desc: p.desc,
        gap: `${p.minGapSeconds}–${p.maxGapSeconds}s`, sessionMax: p.sessionMax, dailyMax: p.dailyMax,
        activeWindows: p.activeWindows.map((w) => w.join('-')).join(' / '),
      }));
      return ok(`限频档位 ${profiles.length} 个（默认 hr150）`, { hard_limits: HARD_LIMITS, profiles });
    }
    const { profile, err } = resolveProfileSafe(args.profile);
    if (err) return errResult('E_BAD_INPUT', err);

    if (op === 'plan') {
      const count = Number(args.count ?? 0);
      if (!(count > 0)) return errResult('E_BAD_INPUT', 'plan 需要 count > 0');
      const r = buildPlan(profile, { count, start: args.start });
      return ok(`计划「${r.profile}」：${r.plan.length} 人，总等待 ${(r.totalSeconds / 60).toFixed(1)} 分钟`, r);
    }
    if (op === 'next') {
      const r = nextGap(profile, { risk: !!args.risk, last: args.last ?? null, index: 1 });
      return ok(`下一次等待 ${r.seconds}s（${r.reason}）`, { ...r, profile: profile.key });
    }
    if (op === 'check') {
      const today = args.today != null ? Number(args.today) : touchTodayCount();
      const r = gate(profile, { todayTouched: today, at: args.at });
      const text = r.allowed ? `闸门放行：剩余额度 ${r.quotaLeft}/${r.dailyMax}` : `闸门拒绝：${r.reasons.join('；')}`;
      return ok(text, { ...r, profile: profile.key });
    }
    return errResult('E_BAD_INPUT', `未知 op: ${op}`);
  },
};

// ─────────────────────────────────────────────────────────── boss_risk_check
export const riskCheck = {
  name: 'boss_risk_check',
  title: '页面风控探针',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: '页面风控探针（验证码 / 答题 / 操作频繁 / 登录墙）。'
    + 'verdict=BLOCK 时 Server 同时写入当日熔断（fail-closed），当天不再允许 live。',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string', description: 'targetId；省略则用缓存' } },
  },
  async handler(args = {}) {
    const target = args.target || readTid();
    if (!target) return errResult('E_TAB_NOT_FOUND', '未指定 target 且无缓存 targetId', null, '先跑 boss_session_start / boss_session_health');
    const r = await runNode('risk-check.mjs', ['--target', target, '--json'], { timeoutMs: 30000 });
    const j = parseJsonFromStdout(r.stdout);
    if (!j) {
      if (r.code === 3) return errResult('E_LOGIN_REQUIRED', '页面不可见或登录失效', (r.stderr || '').slice(-300), '本机窗口登录 / 还原窗口后重试');
      if (r.code === 4) { writeBreaker('risk_check 命中风控信号（exit 4）', null); return errResult('E_RISK_BLOCK', '命中风控信号，当日停止操作', (r.stderr || '').slice(-300), '当日不重试'); }
      return errResult('E_INTERNAL', '风险探针失败', (r.stderr || r.stdout || '').slice(-300));
    }
    const raw = j.signals || {};
    const signals = {
      quiz_hits: raw.quizKeywords || [],
      captcha_elements: raw.captchaElements || [],
      risk_keywords: raw.riskKeywords || [],
      login_wall: !!raw.loginWall,
    };
    const data = { verdict: j.verdict, url: j.url, title: j.title, visible: j.visible, auto_woke: j.autoWoke, signals, signals_raw: raw, actions: j.actions || [] };
    if (j.verdict === 'BLOCK') {
      writeBreaker('risk_check 检出风控信号（BLOCK）', null); // 强制点 #8
      return errResult('E_RISK_BLOCK', `命中风控信号：${(j.actions && j.actions[0]) || '立即终止当天全部操作，不要重试、不要刷新硬闯。'}`, data, '当日不重试；次日 breaker.json 自动过期');
    }
    writeAttestHealth({ ok_at: localStamp(), risk_verdict: j.verdict || 'OK', source: 'risk_check' }); // T1-1 体检凭证
    if (j.verdict === 'WARN') return ok('存在可疑信号（未到熔断阈值），谨慎继续', data);
    return ok('风控探针通过', data);
  },
};
