#!/usr/bin/env node
/**
 * engine-adapter.mjs — 引擎（scripts/）导出契约的集中适配层（T3-1）
 *
 * 把「直接 import '../../scripts/pacing.mjs'」收拢到这一处：
 *   1) 启动期做契约断言：引擎若改了导出名/类型，这里给出明确错误，而非工具里的深层堆栈；
 *   2) 工具一律从这里取引擎导出，改一处即可全局生效。
 */

import * as pacing from '../scripts/pacing.mjs';

const CONTRACT = {
  PROFILES: 'object',
  HARD_LIMITS: 'object',
  resolveProfile: 'function',
  nextGap: 'function',
  buildPlan: 'function',
  gate: 'function',
};

const missing = Object.entries(CONTRACT)
  .filter(([k, t]) => typeof pacing[k] !== t)
  .map(([k, t]) => `${k}（期望 ${t}，实际 ${typeof pacing[k]}）`);

if (missing.length) {
  throw new Error(`引擎契约变更：scripts/pacing.mjs 的导出与 MCP 层不符 → ${missing.join('、')}`);
}

export const { PROFILES, HARD_LIMITS, resolveProfile, nextGap, buildPlan, gate } = pacing;

/** 供启动期显式自检调用（可选）。 */
export function checkEngineContract() {
  return { ok: true, engine: 'pacing.mjs', exports: Object.keys(CONTRACT) };
}
