#!/usr/bin/env node
/**
 * env-session.mjs — boss_env_check / boss_session_start / boss_session_health
 * 映射：setup-env.mjs / start-session.mjs（不带 --hold）/ cdp-proxy /health /targets /info + risk-check
 */

import path from 'node:path';
import { runNode, parseJsonFromStdout, ok, errResult, PATHS, ENGINE_ROOT, localStamp } from '../lib.mjs';
import { loadConfig, saveRuntime, readTid, saveTid, writeBreaker, writeAttestHealth } from '../state.mjs';
import { proxyCall } from '../proxy.mjs';

const DOCS_HINT = path.join(ENGINE_ROOT, 'references', 'environment-setup.md');

// ─────────────────────────────────────────────────────────── boss_env_check
export const envCheck = {
  name: 'boss_env_check',
  title: '环境自检',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: '环境自检（新机部署、故障排查第一步）。检查 Node>=22 / 浏览器 / 端口 / 目录写权限，'
    + '返回可读报告。fix=true 自动修复可修复项（建目录、生成 config）。自检结果本身是有效输出，'
    + '即使有阻塞项也不视为错误（isError=false）。',
  inputSchema: {
    type: 'object',
    properties: {
      fix: { type: 'boolean', default: false, description: '自动修复可修复项（建目录、生成 config）' },
      browser: { type: 'string', enum: ['edge', 'chrome'], description: '临时覆盖浏览器偏好（不写入 config，仅提示）' },
    },
  },
  async handler(args = {}) {
    const argv = ['--json'];
    if (args.fix) argv.push('--fix');
    const r = await runNode('setup-env.mjs', argv, { timeoutMs: 60000 });
    const j = parseJsonFromStdout(r.stdout);
    if (!j) {
      return errResult('E_INTERNAL', '环境自检失败：无法解析报告', (r.stderr || r.stdout || '').slice(-400), `完整日志见引擎脚本输出；部署指南 ${DOCS_HINT}`);
    }
    const checks = (j.checks || []).map((c) => ({ name: c.id, status: c.level, title: c.title, detail: c.detail, hint: c.hint }));
    const data = {
      ok: !!j.ok,
      exit_code: j.exitCode ?? r.code,
      summary: j.summary || null,
      host: j.host || null,
      root: j.root || null,
      primary_browser: j.primaryBrowser || null,
      installed_browsers: j.installedBrowsers || [],
      fixed: j.fixed || [],
      checks,
      docs_hint: DOCS_HINT,
    };
    const fails = (j.summary && j.summary.fails) || 0;
    const warns = (j.summary && j.summary.warns) || 0;
    const text = fails
      ? `环境自检：${fails} 项阻塞、${warns} 项待确认 —— 先解决 FAIL 项再继续`
      : warns
        ? `环境自检：可运行，但有 ${warns} 项待确认`
        : '环境自检：全绿，可直接使用';
    return ok(text, data);
  },
};

// ─────────────────────────────────────────────────────────── boss_session_start
export const sessionStart = {
  name: 'boss_session_start',
  title: '拉起浏览器会话',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: '拉起或复用「浏览器 + CDP 代理 + 目标标签页」整条链路（幂等：已就绪则复用）。'
    + '结束后在浏览器窗口人工登录一次 zhipin.com（登录态保存在副本 profile）。'
    + '此工具不清理用户的日常浏览器，只结束带调试端口的旧实例。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', default: 'https://www.zhipin.com/web/chat/recommend' },
      page_match: { type: 'string', default: 'zhipin.com', description: '目标 tab 的 URL 匹配关键词' },
      browser: { type: 'string', enum: ['edge', 'chrome'] },
      restart: { type: 'boolean', default: false, description: 'true=结束旧调试实例重新拉起；false=能复用则复用' },
    },
  },
  async handler(args = {}) {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) {
      return errResult('E_ENV_MISSING', `Node.js 版本过低（当前 ${process.version}），本引擎要求 >= 22`, null, '安装 Node 22 LTS：https://nodejs.org/ ，或先用 boss_env_check 诊断');
    }
    const cfg = loadConfig();
    const url = args.url || cfg.url;
    const pageMatch = args.page_match || cfg.page_match;
    const browser = args.browser || cfg.browser;
    const argv = ['--url', url, '--page-match', pageMatch, '--browser', browser, '--tid-out', PATHS.runtimeTid];
    if (!args.restart) argv.push('--reuse');
    const r = await runNode('start-session.mjs', argv, { timeoutMs: 90000 });
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout || '').slice(-500);
      return errResult('E_BROWSER_NOT_READY', '会话链路未就绪（浏览器/代理未能在时限内拉起）', tail, '先跑 boss_env_check 确认浏览器已安装、端口空闲；若浏览器缺失属 E_ENV_MISSING；常见是授权弹窗需在本机点一下');
    }
    const tid = readTid();
    const reused = /复用已运行/.test(r.stdout || '');
    const health = await proxyCall('GET', '/health', { proxy: cfg.proxy });
    const proxyConnected = !!(health.ok && health.body && health.body.connected);
    let page = null;
    if (tid) {
      const info = await proxyCall('GET', '/info?target=' + encodeURIComponent(tid), { proxy: cfg.proxy });
      if (info.ok && info.body && typeof info.body === 'object') page = { url: info.body.url, title: info.body.title };
    }
    if (tid) saveTid(tid);
    saveRuntime({ url, page_match: pageMatch, browser });
    const data = {
      target_id: tid,
      reused,
      browser: { id: browser, label: browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge' },
      proxy: { port: 3456, connected: proxyConnected },
      page: page || { url, title: null },
      login_hint: '若目标页被重定向到登录页，请在本机浏览器窗口完成登录后重试（登录态保存在副本 profile，一次即可）。',
      docs_hint: DOCS_HINT,
    };
    return ok(`会话就绪${tid ? `，targetId=${tid}` : '（未匹配到目标页）'}${proxyConnected ? '' : '，代理未连接'}`, data);
  },
};

// ─────────────────────────────────────────────────────────── boss_session_health
export const sessionHealth = {
  name: 'boss_session_health',
  title: '会话健康检查',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: '会话健康检查（跑批前/排障时）。返回代理连通性、tab 数量、目标页信息、登录态与风控探针。'
    + 'deep=true 时追加风控自检（命中 BLOCK 会写当日熔断）。',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'targetId；省略则自动定位 page_match 命中的 tab' },
      deep: { type: 'boolean', default: false },
    },
  },
  async handler(args = {}) {
    const cfg = loadConfig();
    const proxy = cfg.proxy;
    const health = await proxyCall('GET', '/health', { proxy });
    const proxyConnected = !!(health.ok && health.body && health.body.connected);
    if (!health.ok) {
      return errResult('E_PROXY_UNREACHABLE', 'CDP 代理不可达', health.body && health.body.error, '先跑 boss_session_start 拉起链路');
    }
    const targets = await proxyCall('GET', '/targets', { proxy });
    const pages = (targets.ok && Array.isArray(targets.body)) ? targets.body.filter((t) => t.type === 'page') : [];
    let targetId = args.target || readTid();
    let page = null;
    if (targetId) {
      page = pages.find((t) => t.targetId === targetId) || null;
      if (!page) targetId = null;
    }
    if (!targetId) {
      const hit = pages.find((t) => (t.url || '').includes(cfg.page_match)) || pages[0] || null;
      if (hit) { targetId = hit.targetId; page = hit; saveTid(targetId); }
    }
    let info = null;
    if (targetId) {
      const i = await proxyCall('GET', '/info?target=' + encodeURIComponent(targetId), { proxy });
      if (i.ok && i.body && typeof i.body === 'object') info = i.body;
    }
    const url = info ? info.url : (page && page.url) || null;
    const loginOk = url ? !/\/web\/user\//i.test(url) : null;

    let risk = null;
    if (args.deep && targetId) {
      const rr = await runNode('risk-check.mjs', ['--target', targetId, '--json'], { timeoutMs: 25000 });
      risk = parseJsonFromStdout(rr.stdout);
      if (risk && risk.verdict === 'BLOCK') writeBreaker('session_health(deep) 检出风控信号', null); // 强制点 #8
      else if (risk) writeAttestHealth({ ok_at: localStamp(), risk_verdict: risk.verdict || 'OK', source: 'session_health(deep)' }); // T1-1 体检凭证
    }

    const data = {
      proxy_connected: proxyConnected,
      browser: (health.body && health.body.browser) || null,
      tab_count: pages.length,
      target: targetId ? {
        id: targetId,
        url: url || (page && page.url) || null,
        title: info ? info.title : (page && page.title) || null,
        visible: risk ? !!risk.visible : null,
      } : null,
      risk: risk ? {
        verdict: risk.verdict,
        url: risk.url,
        visible: risk.visible,
        signals: risk.signals || null,
        actions: risk.actions || [],
      } : null,
      expectations: {
        login_ok: loginOk,
        frame_present: !!targetId,
      },
      docs_hint: DOCS_HINT,
    };
    if (!targetId) return errResult('E_TAB_NOT_FOUND', '未找到目标标签页', { pages: pages.map((p) => p.url) }, '先跑 boss_session_start 再检查');
    const verdict = risk ? risk.verdict : (loginOk === false ? 'WARN(登录)' : 'OK');
    return ok(`会话健康：代理${proxyConnected ? '在线' : '离线'}，tab ${pages.length} 个，目标 ${targetId}，风控 ${verdict}`, data);
  },
};
