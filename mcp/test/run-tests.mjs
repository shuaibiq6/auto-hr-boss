#!/usr/bin/env node
/**
 * run-tests.mjs — 离线契约/单元测试（不启动浏览器、不真实触达）
 * 运行：node test/run-tests.mjs
 *
 * 覆盖：lib 帧/JSON/错误码、state（job/熔断/plan/去重）、pacing 纯函数、
 *       工具 handler 的强制点拒绝路径、以及一次真实的 server 握手（initialize→tools/list→tools/call）。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// 必须在导入任何业务模块前设置 BOSS_MCP_HOME（lib 在 import 时解析 HOME）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-mcp-test-'));
process.env.BOSS_MCP_HOME = TMP;
// 离线测试隔离：greet_start 只走校验、不真正 spawn 脱离进程（避免启动浏览器/代理）
process.env.BOSS_MCP_TEST_NO_SPAWN = '1';

const lib = await import('../lib.mjs');
const state = await import('../state.mjs');
const adapter = await import('../engine-adapter.mjs');
const toolsMod = await import('../tools/index.mjs');

const { PATHS, parseJsonFromStdout, mapExitCode, writeJson, readJsonArr } = lib;
const { HARD_LIMITS, PROFILES, resolveProfile, buildPlan, gate, nextGap } = adapter;

// ─────────────────────────────────────────────────────────── 断言
let pass = 0, fail = 0;
const failures = [];
function assert(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, got, want) { assert(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

console.log('\n== lib.mjs ==');
{
  const j = parseJsonFromStdout('进度行...\n{"a":1,"b":[2,3]}');
  assert('parseJsonFromStdout 提取 JSON', j && j.a === 1 && j.b[1] === 3, JSON.stringify(j));
  eq('parseJsonFromStdout 空串→null', parseJsonFromStdout(''), null);

  const e = mapExitCode('risk-check', 4);
  assert('mapExitCode risk-check 4→E_RISK_BLOCK', e.code === 'E_RISK_BLOCK');
  const e2 = mapExitCode('greet-batch', 3);
  assert('mapExitCode greet-batch 3→E_GATE_DENIED', e2.code === 'E_GATE_DENIED');
  eq('mapExitCode 0→null', mapExitCode('greet-batch', 0), null);
}

console.log('\n== state.mjs ==');
{
  const id = state.newJobId(new Date(2026, 9, 18, 9, 30, 12));
  assert('jobId 格式', /^job-20261018-093012-[0-9a-f]{4}$/.test(id), id);
  const pid = state.newPlanId(new Date(2026, 9, 18, 9, 30));
  assert('planId 格式', /^plan-20261018-0930-[0-9a-f]{4}$/.test(pid), pid);

  state.writeBreaker('测试熔断', null);
  assert('writeBreaker→isBreakerOpenToday', state.isBreakerOpenToday() === true);
  // 不同日期不匹配
  const b = lib.readJson(PATHS.breaker);
  b.date = '2000-01-01'; lib.writeJson(PATHS.breaker, b);
  assert('breaker 仅当日有效', state.isBreakerOpenToday() === false);
  fs.rmSync(PATHS.breaker, { force: true });

  // resolvePlan：数组 / plan_id / @abs
  assert('resolvePlan(数组)', state.resolvePlan([{ id: 'a' }]).length === 1);
  const planId = state.savePlan([{ id: 'b' }, { id: 'c' }]);
  const viaId = state.resolvePlan(planId);
  assert('resolvePlan(plan_id)', viaId && viaId.length === 2, JSON.stringify(viaId));
  const abs = path.join(TMP, 'abs-plan.json');
  fs.writeFileSync(abs, JSON.stringify([{ id: 'd' }]), 'utf8');
  assert('resolvePlan(@abs:)', state.resolvePlan('@abs:' + abs).length === 1);
  assert('resolvePlan(非法)→null', state.resolvePlan('no-such-plan-xyz') === null || state.resolvePlan('no-such-plan-xyz') === null);

  // projectStatus：风控信号 → blocked + 写 breaker
  const job = { job_id: 'job-x', mode: 'live' };
  const engine = { status: 'stopped', stopReason: '命中熔断（风控信号/连败），需人工干预', done: 0, total: 10, ok: 0, failed: 0, skipped: 0, remaining: 10 };
  const proj = state.projectStatus(job, engine, 0);
  assert('风控信号→blocked', proj.status === 'blocked', proj.status);
  assert('风控信号→写 breaker', state.isBreakerOpenToday() === true);
  fs.rmSync(PATHS.breaker, { force: true });

  // T1-1：dry 凭证（live 前置体检）
  const h1 = state.planHashOf([{ id: 'a' }, { id: 'b' }]);
  const h2 = state.planHashOf([{ id: 'b' }, { id: 'a' }]);
  assert('planHashOf 确定性', h1 === state.planHashOf([{ id: 'a' }, { id: 'b' }]));
  assert('planHashOf 顺序无关', h1 === h2);
  eq('无凭证 requireDryAttest→E_DRY_REQUIRED', state.requireDryAttest(h1).code, 'E_DRY_REQUIRED');
  state.writeAttestPlan(h1, { dry_ok_at: 'x', dry_ok_count: 2 });
  eq('有凭证 requireDryAttest→ok', state.requireDryAttest(h1).ok, true);
  assert('getAttestPlan 可见', !!state.getAttestPlan(h1));
}

console.log('\n== engine-adapter 契约 + pacing 纯函数 ==');
{
  assert('engine-adapter 契约通过', adapter.checkEngineContract().ok === true);
  const hr = resolveProfile('hr150');
  eq('hr150 dailyMax=150', hr.dailyMax, 150);
  eq('HARD_LIMITS gapFloor=60', HARD_LIMITS.gapFloorSeconds, 60);
  let threw = false; try { resolveProfile('bogus'); } catch (e) { threw = e.code === 'BAD_PROFILE'; }
  assert('未知档位抛 BAD_PROFILE', threw);

  const plan40 = buildPlan(resolveProfile('hr150'), { count: 40 });
  eq('buildPlan 截断到 30', plan40.plan.length, 30);
  assert('buildPlan 有超上限警告', plan40.warnings.some((w) => w.includes('30')));

  const gFull = gate(resolveProfile('hr150'), { todayTouched: 150 });
  eq('gate 额度用尽→false', gFull.allowed, false);
  const gNight = gate(resolveProfile('hr150'), { todayTouched: 0, at: '03:00' });
  eq('gate 非时段→false', gNight.allowed, false);
  const gOk = gate(resolveProfile('hr150'), { todayTouched: 10, at: '10:00' });
  eq('gate 放行→true', gOk.allowed, true);

  eq('nextGap 首次=0', nextGap(resolveProfile('hr150'), { index: 0 }).seconds, 0);
  const ng = nextGap(resolveProfile('hr150'), { index: 1 });
  assert('nextGap 落在 115–185', ng.seconds >= 115 && ng.seconds <= 185, ng.seconds);
}

console.log('\n== 工具注册 ==');
{
  const { TOOLS, findTool } = toolsMod;
  eq('工具数=12', TOOLS.length, 12);
  const names = TOOLS.map((t) => t.name);
  assert('全部 boss_ 前缀', names.every((n) => n.startsWith('boss_')));
  assert('名字唯一', new Set(names).size === names.length);
  const want = ['boss_env_check', 'boss_session_start', 'boss_session_health', 'boss_browser', 'boss_pacing', 'boss_risk_check', 'boss_screen_talent', 'boss_greet_start', 'boss_greet_status', 'boss_greet_stop', 'boss_greet_verify', 'boss_history'];
  assert('工具集合与契约一致', want.every((n) => findTool(n)), JSON.stringify(names));
}

console.log('\n== boss_pacing ==');
{
  const pacing = toolsMod.findTool('boss_pacing');
  const profiles = await pacing.handler({ op: 'profiles' });
  assert('profiles 返回 4 档', profiles.data && profiles.data.profiles.length === 4);
  const check = await pacing.handler({ op: 'check', profile: 'hr150', today: 150, at: '10:00' });
  eq('check 额度用尽 allowed=false', check.data.allowed, false);
  const plan = await pacing.handler({ op: 'plan', profile: 'balanced', count: 5 });
  assert('plan 5 人', plan.data.plan.length === 5);
  const bad = await pacing.handler({ op: 'bogus' });
  eq('未知 op→E_BAD_INPUT', bad.code, 'E_BAD_INPUT');
}

console.log('\n== boss_history ==');
{
  const h = toolsMod.findTool('boss_history');
  const today = lib.todayStr();
  const c1 = await h.handler({ op: 'commit', records: [{ id: 'g1', name: '甲', title: 'x', ts: `${today} 10:00` }, { id: 'g2', name: '乙', title: 'y', ts: `${today} 10:01` }] });
  eq('commit 新增 2', c1.data.added, 2);
  const c2 = await h.handler({ op: 'commit', records: [{ id: 'g1', name: '甲', title: 'x' }, { id: 'g3', name: '丙', title: 'z' }] });
  eq('commit 幂等（新增 1）', c2.data.added, 1);
  const list = await h.handler({ op: 'list' });
  eq('list total=3', list.data.total, 3);
  const stats = await h.handler({ op: 'stats' });
  eq('stats today 匹配', stats.data.today, 3);
}

console.log('\n== boss_screen_talent ==');
{
  const st = toolsMod.findTool('boss_screen_talent');
  const job = { positionTitle: 'AI 应用开发工程师', company: '测试', direction: 'ai-app', city: '郑州', coreSkills: ['Python', 'FastAPI'], skills: ['MySQL', 'Docker'], minExperienceYears: 1, maxExperienceYears: 3, minDegree: '本科', salaryBudgetMonthly: [12000, 18000], excludeKeywords: ['销售', '客服'], requireCity: '郑州', limits: { dailyMax: 12, matchThreshold: 2 } };
  const talent = [
    { id: 'geek-1', name: '张三', title: 'Python 后端开发工程师', skills: 'Python FastAPI MySQL Docker', experience: '3年经验', degree: '本科', expectSalary: '12-18K', expectCity: '郑州', activeStatus: '刚刚活跃', resume: '负责后端开发，FastAPI 重构核心接口。' },
    { id: 'geek-2', name: '李四', title: '销售经理', skills: '销售 客户', experience: '5年经验', degree: '大专', expectSalary: '8-10K', expectCity: '北京', activeStatus: '3日内活跃', resume: '负责销售。' },
  ];
  const r = await st.handler({ job, talent, use_history: false, save_plan: true });
  eq('screen 无错误', r.isError, false);
  assert('accepted=1', r.data.summary.accepted === 1, JSON.stringify(r.data.summary));
  assert('rejected=1', r.data.summary.rejected === 1, JSON.stringify(r.data.summary));
  assert('返回 plan_id', !!r.data.plan_id, r.data.plan_id);
  assert('plan_id 可被 resolvePlan', state.resolvePlan(r.data.plan_id).length === 1);
}

console.log('\n== boss_greet_start 强制点（拒绝路径） ==');
{
  const gs = toolsMod.findTool('boss_greet_start');

  // #1 mode 必填
  const noMode = await gs.handler({ plan: [{ id: 'x' }] });
  eq('#1 mode 缺省→E_BAD_INPUT', noMode.code, 'E_BAD_INPUT');

  // #6 profile 白名单
  const badProfile = await gs.handler({ mode: 'dry', plan: [{ id: 'x' }], profile: 'bogus' });
  eq('#6 profile 非法→E_BAD_INPUT', badProfile.code, 'E_BAD_INPUT');

  // #5 名单非法
  const emptyPlan = await gs.handler({ mode: 'dry', plan: [] });
  eq('#5 空名单→E_BAD_INPUT', emptyPlan.code, 'E_BAD_INPUT');

  // #3 互斥：造一个活动 live job
  state.writeJob('job-20260101-000000-aaaa', { status: 'running', mode: 'live', created_at: '2026-01-01 00:00' });
  const mutex = await gs.handler({ mode: 'live', plan: [{ id: 'x' }] });
  eq('#3 互斥→E_JOB_ACTIVE', mutex.code, 'E_JOB_ACTIVE');
  state.writeJob('job-20260101-000000-aaaa', { status: 'finished' });

  // #4 闸门：写满 150 条当日触达（先注入 dry 凭证，让流程走到闸门而非被 #10 拦下）
  const touchArr = Array.from({ length: 150 }, (_, i) => ({ id: `t${i}`, name: 'n', title: 't', ts: `${lib.todayStr()} 09:0${i % 10}` }));
  lib.writeJson(PATHS.touch, touchArr);
  state.writeAttestPlan(state.planHashOf([{ id: 'fresh' }]), { dry_ok_at: 'x', dry_ok_count: 1 });
  const gateDenied = await gs.handler({ mode: 'live', plan: [{ id: 'fresh' }] });
  eq('#4 闸门额度用尽→E_GATE_DENIED', gateDenied.code, 'E_GATE_DENIED');
  lib.writeJson(PATHS.touch, []);

  // #2 熔断 fail-closed
  state.writeBreaker('测试', null);
  const circuit = await gs.handler({ mode: 'live', plan: [{ id: 'x' }] });
  eq('#2 熔断→E_CIRCUIT_OPEN', circuit.code, 'E_CIRCUIT_OPEN');
  // dry 在熔断期仍允许（不点击）
  const dryOk = await gs.handler({ mode: 'dry', plan: [{ id: 'x' }] });
  eq('#2 dry 熔断期放行', dryOk.code, null);
  fs.rmSync(PATHS.breaker, { force: true });

  // #10 dry 成功后写入当日凭证
  assert('#10 dry 写入当日凭证', !!state.getAttestPlan(state.planHashOf([{ id: 'x' }]))?.dry_ok_at);

  // #10 live 前置体检：未 dry 的 live 被拒（在闸门之前，确定性；此刻无活动 job、无熔断、额度未满）
  lib.writeJson(PATHS.touch, []);
  const noDry = await gs.handler({ mode: 'live', plan: [{ id: 'never-dried' }] });
  eq('#10 live 未 dry→E_DRY_REQUIRED', noDry.code, 'E_DRY_REQUIRED');
}

console.log('\n== boss_risk_check（无会话拒绝路径） ==');
{
  const rc = toolsMod.findTool('boss_risk_check');
  const r = await rc.handler({});
  eq('无 target→E_TAB_NOT_FOUND', r.code, 'E_TAB_NOT_FOUND');
}

console.log('\n== server 握手（initialize→tools/list→tools/call） ==');
{
  const responses = await rpcExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'boss_pacing', arguments: { op: 'profiles' } } },
    { jsonrpc: '2.0', id: 4, method: 'resources/templates/list' },
  ]);
  const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
  const init = byId[1];
  assert('initialize 返回 serverInfo', init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'boss-hr-outreach', JSON.stringify(init && init.result));
  const list = byId[2];
  assert('tools/list 返回 12 工具', list && list.result && list.result.tools && list.result.tools.length === 12);
  const greetTool = list && list.result.tools.find((t) => t.name === 'boss_greet_start');
  assert('greet_start 标注 destructiveHint', !!(greetTool && greetTool.annotations && greetTool.annotations.destructiveHint === true));
  assert('greet_start 有 title', !!(greetTool && typeof greetTool.title === 'string' && greetTool.title.length));
  const call = byId[3];
  assert('tools/call 返回 4 档', call && call.result && call.result.structuredContent && call.result.structuredContent.profiles.length === 4, JSON.stringify(call && call.result));
  assert('tools/call 有 text content', !!(call && call.result && Array.isArray(call.result.content)), JSON.stringify(call && call.result && call.result.content));
  const tmpl = byId[4];
  assert('resources/templates/list 返回 3 个模板', !!(tmpl && tmpl.result && Array.isArray(tmpl.result.resourceTemplates) && tmpl.result.resourceTemplates.length === 3), JSON.stringify(tmpl && tmpl.result));
}

// ─────────────────────────────────────────────────────────── 帧解析（供 server 握手）
function parseFrame(buffer) {
  const s = buffer.toString('utf8');
  // 标准：换行分隔 JSON
  const nl = s.indexOf('\n');
  if (nl !== -1) {
    const line = s.slice(0, nl);
    const rest = buffer.subarray(Buffer.byteLength(line, 'utf8') + 1);
    let msg = null; try { msg = JSON.parse(line); } catch { msg = null; }
    return { msg, rest };
  }
  // 兼容：Content-Length 头（回退）
  const header = s.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
  if (header) {
    const headerLen = header[0].length;
    const bodyLen = Number(header[1]);
    if (buffer.length >= headerLen + bodyLen) {
      const body = buffer.subarray(headerLen, headerLen + bodyLen);
      const rest = buffer.subarray(headerLen + bodyLen);
      let msg = null; try { msg = JSON.parse(body.toString('utf8')); } catch { msg = null; }
      return { msg, rest };
    }
    return null;
  }
  return null;
}

function rpcExchange(messages) {
  return new Promise((resolve) => {
    const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
    const child = spawn(process.execPath, [serverPath], { env: { ...process.env, BOSS_MCP_HOME: TMP }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = Buffer.alloc(0);
    const responses = [];
    child.stdout.on('data', (d) => {
      out = Buffer.concat([out, d]);
      let parsed;
      while ((parsed = parseFrame(out))) { out = parsed.rest; if (parsed.msg) responses.push(parsed.msg); }
    });
    child.on('error', (e) => { resolve(responses); });
    child.on('exit', () => resolve(responses));
    for (const m of messages) {
      child.stdin.write(JSON.stringify(m) + '\n');
    }
    child.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────── 汇总
console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
} else {
  console.log('全部通过 ✅');
  process.exit(0);
}
