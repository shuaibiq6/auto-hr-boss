#!/usr/bin/env node
/**
 * index.mjs — 组装 12 个 v1 工具 + 查找
 */

import { envCheck, sessionStart, sessionHealth } from './env-session.mjs';
import { browser } from './browser.mjs';
import { pacing, riskCheck } from './pacing-risk.mjs';
import { screenTalent } from './screen.mjs';
import { greetStart } from './greet-start.mjs';
import { greetStatus, greetStop, greetVerify } from './greet-lifecycle.mjs';
import { history } from './history.mjs';

export const TOOLS = [
  envCheck,
  sessionStart,
  sessionHealth,
  browser,
  pacing,
  riskCheck,
  screenTalent,
  greetStart,
  greetStatus,
  greetStop,
  greetVerify,
  history,
];

export function findTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}
