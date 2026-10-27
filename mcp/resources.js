#!/usr/bin/env node
/**
 * resources.js — MCP Resources（boss:// 协议）
 * 静态资产（references/templates/SKILL）原样暴露；动态资产（jobs/history/env）实时生成。
 * 大文件支持 ?part=N 分页（Q5）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_ROOT, REFERENCES_DIR, TEMPLATES_DIR, PATHS, readJson } from './lib.mjs';
import { listJobs, readJob, jobDir, jobOut, readTouch, fetchEngineStatus, projectStatus, loadConfig } from './state.mjs';

const FILE_MAP = {
  'docs/skill': { file: path.join(ENGINE_ROOT, 'SKILL.md'), name: 'SKILL.md 全文（操作手册）', mime: 'text/markdown' },
  'docs/pacing-policy': { file: path.join(REFERENCES_DIR, 'pacing-policy.md'), name: '限频策略全文', mime: 'text/markdown' },
  'docs/hr-daily-150': { file: path.join(REFERENCES_DIR, 'hr-daily-150-plan.md'), name: '日 150 排班方案', mime: 'text/markdown' },
  'docs/talent-outreach': { file: path.join(REFERENCES_DIR, 'talent-outreach.md'), name: '招聘方风险模型', mime: 'text/markdown' },
  'docs/environment-setup': { file: path.join(REFERENCES_DIR, 'environment-setup.md'), name: '环境与故障排查', mime: 'text/markdown' },
  'docs/cdp-api': { file: path.join(REFERENCES_DIR, 'cdp-api.md'), name: 'CDP API 参考', mime: 'text/markdown' },
  'docs/recruiter-perspective': { file: path.join(REFERENCES_DIR, 'recruiter-perspective.md'), name: '求职方视角风险模型', mime: 'text/markdown' },
  'docs/migration': { file: path.join(REFERENCES_DIR, 'migration-2.5.3.md'), name: 'GET→POST 迁移指南', mime: 'text/markdown' },
  'docs/changelog': { file: path.join(ENGINE_ROOT, 'CHANGELOG.md'), name: '事故史（CHANGELOG）', mime: 'text/markdown' },
  'site-patterns/zhipin-boss': { file: path.join(REFERENCES_DIR, 'site-patterns', 'zhipin-boss.md'), name: '站点作战手册（803 行）', mime: 'text/markdown' },
  'site-patterns/zhipin': { file: path.join(REFERENCES_DIR, 'site-patterns', 'zhipin.com.md'), name: '站点通用经验', mime: 'text/markdown' },
  'templates/actions/zhipin-boss-greet': { file: path.join(TEMPLATES_DIR, 'actions', 'zhipin-boss-greet.json'), name: '动作模板', mime: 'application/json' },
  'templates/config-env': { file: path.join(TEMPLATES_DIR, 'config.env.template'), name: 'config.env 模板', mime: 'text/plain' },
};

const INDEX_TEXT = `# boss-hr-outreach MCP 文档索引

## 工具（12 个，boss_ 前缀）
1. boss_env_check        环境自检
2. boss_session_start    拉起/复用浏览器会话链路
3. boss_session_health   会话健康检查（deep=风控探针）
4. boss_browser          通用浏览器操作（薄封装 CDP 代理）
5. boss_pacing           限频节拍器（配额/时段/时间表）
6. boss_risk_check       页面风控探针（BLOCK→写熔断）
7. boss_screen_talent    招聘端准入闸门（该联系谁）
8. boss_greet_start      启动批量打招呼 Job（dry/live）
9. boss_greet_status     查询 Job 状态与进度
10. boss_greet_stop      停止 Job
11. boss_greet_verify    平台侧独立核验（验收唯一依据）
12. boss_history         读取/回写全局触达记录

## 推荐流程
env_check → session_start → session_health(deep) → screen_talent → greet_start(dry) → greet_status → greet_start(live) → 轮询 status → verify → history

## 安全强制点（Server 端不可绕过，11 个）
mode 必填 / 熔断 fail-closed / 账号级互斥 / 额度+时段闸门 / 交叉去重 /
白名单 / respect_window 默认关 / 风控写 breaker / --commit 恒开 / 结果以 verify 为准 /
live 前置 dry 凭证

## 知识资产（本索引下方各 URI）
站点作战手册、风险模型、限频政策、动作模板、事故史均原样保留。`;

// 具体资源（URI 固定，通过 resources/list 暴露）
export const RESOURCES = [
  { uri: 'boss://docs/index', name: '文档索引', description: '工具清单 + 推荐流程 + 强制点摘要', mimeType: 'text/markdown' },
  ...Object.entries(FILE_MAP).map(([key, m]) => ({ uri: `boss://${key}`, name: m.name, description: `本地路径：${m.file}`, mimeType: m.mime })),
  { uri: 'boss://jobs', name: 'Job 列表（最近 20）', description: '活动 job 优先', mimeType: 'application/json' },
  { uri: 'boss://history/touch', name: '触达记录', description: 'recent=100 截尾', mimeType: 'application/json' },
  { uri: 'boss://env/status', name: '环境快照', description: 'BOSS_MCP_HOME + 配置 + Node', mimeType: 'application/json' },
];

// 资源模板（含变量的动态 URI，按 MCP 规范应通过 resources/templates/list 暴露，而非 resources/list）
export const RESOURCE_TEMPLATES = [
  { uriTemplate: 'boss://jobs/{jobId}/progress', name: 'Job 进度快照', description: '状态机 + 引擎心跳', mimeType: 'application/json' },
  { uriTemplate: 'boss://jobs/{jobId}/result', name: 'Job 结果文件', description: 'greet.result.json', mimeType: 'application/json' },
  { uriTemplate: 'boss://jobs/{jobId}/log', name: 'Job 日志尾部', description: '默认 tail=200', mimeType: 'text/plain' },
];

const PART_SIZE = 8000;

function paginate(text, uri) {
  const qIdx = uri.indexOf('?');
  if (qIdx === -1) return { text };
  const q = new URLSearchParams(uri.slice(qIdx + 1));
  if (!q.has('part')) return { text };
  const part = Math.max(1, Number(q.get('part')) || 1);
  const total = Math.ceil(text.length / PART_SIZE) || 1;
  const chunk = text.slice((part - 1) * PART_SIZE, part * PART_SIZE);
  return { text: chunk, part, total_parts: total, truncated: part < total };
}

function readFileRes(file, uri, mime) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { uri, mimeType: 'text/plain', text: `资源不存在或不可读：${file}` }; }
  const p = paginate(text, uri);
  return { uri, mimeType: mime, text: p.text, part: p.part, total_parts: p.total_parts, truncated: p.truncated };
}

export async function readResource(uri) {
  if (uri === 'boss://docs/index') return { uri, mimeType: 'text/markdown', text: INDEX_TEXT };

  for (const [key, m] of Object.entries(FILE_MAP)) {
    if (uri === `boss://${key}` || uri.startsWith(`boss://${key}?`)) return readFileRes(m.file, uri, m.mime);
  }

  if (uri === 'boss://jobs') {
    const jobs = listJobs().slice(0, 20).map((j) => ({ job_id: j.job_id, status: j.status, mode: j.mode, progress: j.progress, created_at: j.created_at }));
    return { uri, mimeType: 'application/json', text: JSON.stringify(jobs, null, 2) };
  }
  if (uri === 'boss://env/status') {
    const cfg = loadConfig();
    const snap = { home: PATHS.home, node: process.version, platform: process.platform, config: cfg };
    return { uri, mimeType: 'application/json', text: JSON.stringify(snap, null, 2) };
  }

  const jobMatch = uri.match(/^boss:\/\/jobs\/([^/?]+)\/progress/);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const job = readJob(jobId);
    if (!job) throw { rpcCode: -32002, message: `Resource not found: ${uri}`, data: { code: 'E_JOB_NOT_FOUND', job_id: jobId } };
    const { exit, engine } = await fetchEngineStatus(jobId, { wait: 0, health: true });
    const proj = projectStatus(job, engine, exit);
    return { uri, mimeType: 'application/json', text: JSON.stringify({ job_id: jobId, status: proj.status, progress: proj.progress, counts: proj.counts, watchdog: proj.watchdog, breaker_open: proj.breaker_open }, null, 2) };
  }

  const resultMatch = uri.match(/^boss:\/\/jobs\/([^/?]+)\/result/);
  if (resultMatch) {
    const jobId = decodeURIComponent(resultMatch[1]);
    const out = jobOut(jobId);
    const data = readJson(out) ?? readJson(out + '.done') ?? { error: 'no result yet' };
    return { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }

  const logMatch = uri.match(/^boss:\/\/jobs\/([^/?]+)\/log/);
  if (logMatch) {
    const jobId = decodeURIComponent(logMatch[1]);
    const qIdx = uri.indexOf('?');
    const q = qIdx >= 0 ? new URLSearchParams(uri.slice(qIdx + 1)) : new URLSearchParams();
    const tail = Number(q.get('tail') || 200);
    let lines = [];
    try {
      const s = fs.readFileSync(path.join(jobDir(jobId), 'greet.log'), 'utf8');
      lines = s.split(/\r?\n/).filter((l) => l.length).slice(-tail);
    } catch { lines = []; }
    return { uri, mimeType: 'text/plain', text: lines.length ? lines.join('\n') : '(暂无日志)' };
  }

  if (uri === 'boss://history/touch' || uri.startsWith('boss://history/touch?')) {
    const qIdx = uri.indexOf('?');
    const q = qIdx >= 0 ? new URLSearchParams(uri.slice(qIdx + 1)) : new URLSearchParams();
    const recent = Number(q.get('recent') || 100);
    const all = readTouch(); // T5-3：一次读盘（原先 slice 与 length 各读一次）
    const rows = all.slice(-recent);
    return { uri, mimeType: 'application/json', text: JSON.stringify({ total: all.length, rows }, null, 2) };
  }

  throw { rpcCode: -32002, message: `Resource not found: ${uri}` };
}
