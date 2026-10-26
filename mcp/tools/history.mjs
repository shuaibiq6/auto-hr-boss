#!/usr/bin/env node
/**
 * history.mjs — boss_history（直读/直写 history/touch.json，全局唯一事实源）
 */

import { readTouch, commitTouch } from '../state.mjs';
import { ok, errResult, localDate, todayStr } from '../lib.mjs';

export const history = {
  name: 'boss_history',
  title: '触达记录',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: '读取/回写全局触达记录（history/touch.json，跨 job 唯一事实源，去重与冷却都靠它）。'
    + 'commit 仅在异常补救时用（正常链路 greet_start 已自动回写），幂等：同 id/url 不重复写。',
  inputSchema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['list', 'stats', 'commit'] },
      since: { type: 'string', description: 'YYYY-MM-DD，只列出该日起的记录' },
      job: { type: 'string', description: '只列某个 job 的记录' },
      limit: { type: 'integer', default: 100 },
      records: { type: 'array', items: { type: 'object' }, description: 'op=commit 时要回写的记录' },
    },
  },
  async handler(args = {}) {
    const rows = readTouch();
    if (args.op === 'list') {
      let out = rows;
      if (args.since) out = out.filter((r) => String(r.ts || '').slice(0, 10) >= String(args.since));
      if (args.job) out = out.filter((r) => String(r.job || '') === String(args.job));
      const total = out.length;
      const limit = Math.max(1, Number(args.limit ?? 100));
      out = out.slice(-limit); // touch 是追加序，最近的在尾部
      return ok(`触达记录 ${total} 条`, { total, rows: out });
    }
    if (args.op === 'stats') {
      const today = todayStr();
      const last7 = localDate(new Date(Date.now() - 6 * 86400000));
      const todayCount = rows.filter((r) => String(r.ts || '').startsWith(today)).length;
      const last7Count = rows.filter((r) => String(r.ts || '').slice(0, 10) >= last7).length;
      const byDirection = {};
      const byJob = {};
      for (const r of rows) {
        const d = String(r.direction || r.job || '');
        if (d) byDirection[d] = (byDirection[d] || 0) + 1;
        const j = String(r.job || '');
        if (j) byJob[j] = (byJob[j] || 0) + 1;
      }
      return ok(`触达统计：今日 ${todayCount}，近 7 日 ${last7Count}`, {
        total: rows.length, today: todayCount, last_7d: last7Count, by_direction: byDirection, by_job: byJob,
      });
    }
    if (args.op === 'commit') {
      if (!Array.isArray(args.records) || !args.records.length) return errResult('E_BAD_INPUT', 'op=commit 需要 records（数组）');
      const res = commitTouch(args.records); // 跨进程锁内原子追加（幂等去重）
      return ok(`已回写 ${res.added} 条（跳过重复 ${args.records.length - res.added} 条）`, { added: res.added, total: res.total });
    }
    return errResult('E_BAD_INPUT', `未知 op: ${args.op}`);
  },
};
