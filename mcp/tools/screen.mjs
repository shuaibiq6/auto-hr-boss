#!/usr/bin/env node
/**
 * screen.mjs — boss_screen_talent（招聘端准入闸门）
 * 映射：screen-talent.mjs（结构化输入写临时文件 → spawn --out）
 */

import fs from 'node:fs';
import path from 'node:path';
import { runNode, parseJsonFromStdout, ok, errResult, PATHS } from '../lib.mjs';
import { savePlan } from '../state.mjs';

export const screenTalent = {
  name: 'boss_screen_talent',
  title: '候选人准入闸门',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  description: '招聘端准入闸门——「该联系谁、按什么顺序」。对候选人与岗位画像做匹配度排序，'
    + '输出 accepted / rejected / review / deferred 四组，并把 accepted 落盘为可执行 plan（plan_id 供 greet_start 直接引用）。'
    + 'G0 硬闸门（重复触达/冷却/异地/僵尸号）先行，匹配度准入用分再排序。',
  inputSchema: {
    type: 'object',
    required: ['job', 'talent'],
    properties: {
      job: { type: 'object', description: '岗位画像（positionTitle/coreSkills/skills/min-maxExperienceYears/minDegree/salaryBudgetMonthly/excludeKeywords/requireCity/limits…）' },
      talent: { type: 'array', items: { type: 'object' }, description: '候选人列表（id/name/title/skills/experience/degree/school/expectSalary/expectCity/activeStatus/resume/url…）' },
      use_history: { type: 'boolean', default: true, description: '用全局 touch 记录做去重与冷却判定' },
      save_plan: { type: 'boolean', default: true, description: '把 accepted 落盘为可执行 plan' },
    },
  },
  async handler(args = {}) {
    const job = args.job;
    const talent = args.talent;
    if (!job || typeof job !== 'object' || Array.isArray(job)) return errResult('E_BAD_INPUT', 'job 必填（岗位画像对象）');
    if (!Array.isArray(talent) || !talent.length) return errResult('E_BAD_INPUT', 'talent 必填（候选人数组，至少 1 人）');

    const tmpDir = path.join(PATHS.jobs, '_screen_tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const ts = Date.now();
    const jobFile = path.join(tmpDir, `job-${ts}.json`);
    const talentFile = path.join(tmpDir, `talent-${ts}.json`);
    const outFile = path.join(tmpDir, `result-${ts}.json`);
    fs.writeFileSync(jobFile, JSON.stringify(job, null, 2), 'utf8');
    fs.writeFileSync(talentFile, JSON.stringify(talent, null, 2), 'utf8');

    const argv = ['--job', jobFile, '--talent', talentFile, '--out', outFile];
    if (args.use_history !== false) argv.push('--touch', PATHS.touch);
    try {
      const r = await runNode('screen-talent.mjs', argv, { timeoutMs: 30000 });
      const j = parseJsonFromStdout(r.stdout);
      if (!j) return errResult('E_INTERNAL', '筛选脚本无输出', (r.stderr || r.stdout || '').slice(-400));

      let planId = null;
      if (args.save_plan !== false && Array.isArray(j.accepted) && j.accepted.length) {
        planId = savePlan(j.accepted);
      }
      const summary = {
        input: talent.length,
        accepted: (j.accepted || []).length,
        rejected: (j.rejected || []).length,
        review: (j.review || []).length,
        deferred: (j.deferred || []).length,
      };
      const data = {
        plan_id: planId,
        summary,
        position: j.position || null,
        batch: j.batch || null,
        accepted: j.accepted || [],
        rejected: j.rejected || [],
        review: j.review || [],
        deferred: j.deferred || [],
        warnings: j.warnings || [],
      };
      return ok(`筛选：${summary.accepted} 通过 / ${summary.rejected} 否决 / ${summary.review} 待核${planId ? `，plan_id=${planId}` : ''}`, data);
    } finally {
      // T3-3：临时文件用完即删（accepted 已落盘到 plans/，result 无留存价值）
      for (const f of [jobFile, talentFile, outFile]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    }
  },
};
