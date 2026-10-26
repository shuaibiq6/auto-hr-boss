#!/usr/bin/env node
/**
 * browser.mjs — boss_browser（薄封装 CDP 代理端点）
 * 映射：cdp-proxy.mjs 的 /health /targets /new /close /back /eval /click /clickAt
 *       /clickHuman /clickSafe /type /focus /restore-window /mouseMove /wheel /setFiles
 *       /scroll /screenshot /info（已移除 /navigate：防站内 SPA 硬跳）
 */

import fs from 'node:fs';
import path from 'node:path';
import { ok, errResult, PATHS } from '../lib.mjs';
import { loadConfig, readTid } from '../state.mjs';
import { proxyCall } from '../proxy.mjs';

const WARN_1 = 'click/click_human 不保证业务生效——生产操作请一律 click_safe，并以页面业务状态判定成败，不要以返回值为准。';
const WARN_2 = 'eval 是任意 JS 执行权（默认关闭，需 config.allow_js_eval=true 才可用）——只用于读页面/本任务必需的操作，不得注入与任务无关的脚本。';

const OPS = ['targets', 'new_tab', 'close_tab', 'info', 'back', 'eval', 'click_safe',
  'click', 'click_human', 'type', 'set_files', 'scroll', 'wheel', 'mouse_move', 'focus',
  'restore_window', 'screenshot'];

const NEEDS_TARGET = new Set(['close_tab', 'info', 'back', 'eval', 'click_safe', 'click',
  'click_human', 'type', 'set_files', 'scroll', 'wheel', 'mouse_move', 'focus', 'screenshot']);

/** 把代理的非 2xx 响应映射为 E_* 错误结果。 */
function proxyErr(op, r) {
  const msg = (r.body && (r.body.error || r.body.message)) || '';
  if (r.status === 0) return errResult('E_PROXY_UNREACHABLE', 'CDP 代理不可达', msg, '先跑 boss_session_start');
  if (op === 'click_safe') {
    if (r.status === 409) return errResult('E_BLOCKED', '元素被遮挡（clickSafe 拒绝）', { blocker: r.body?.blocker, notes: r.body?.notes }, '查看 blocker 诊断后再决定；不盲目重试');
    if (r.status === 404) return errResult('E_BLOCKED', '未找到元素（选择器失配或卡片已消失）', { error: r.body?.error, notes: r.body?.notes }, '检查选择器或刷新页面重试');
    return errResult('E_BLOCKED', 'clickSafe 失败', r.body);
  }
  if (op === 'eval') return errResult('E_EVAL_THROW', 'eval 抛异常', msg || r.body);
  if (/attach|target|tab|未找到/i.test(String(msg))) return errResult('E_TAB_NOT_FOUND', '目标标签页无效', msg || r.body, '先跑 boss_session_health');
  return errResult('E_INTERNAL', `操作失败（HTTP ${r.status}）`, r.body || msg);
}

export const browser = {
  name: 'boss_browser',
  title: '通用浏览器操作',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description: `通用浏览器操作（薄封装 CDP 代理）。两个警告：1) ${WARN_1} 2) ${WARN_2}`
    + ' 已移除 navigate（防站内 SPA 硬跳导致登录失效）；站内跳转一律点击站内导航。'
    + ' op=screenshot 返回 image content block（若无 file 参数）。eval 受 config.allow_js_eval 开关约束（默认关）。',
  inputSchema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: OPS },
      target: { type: 'string', description: 'targetId；省略则用会话缓存' },
      selector: { type: 'string', description: 'CSS 选择器；支持 frame:<src子串> ||| <css> 语法' },
      expression: { type: 'string', description: 'op=eval 时的 JS 表达式' },
      url: { type: 'string', description: 'op=new_tab 时的地址' },
      file: { type: 'string', description: 'op=screenshot 的输出路径（省略则仅返回 image）' },
      files: { type: 'array', items: { type: 'string' }, description: 'op=set_files 的文件路径' },
      text: { type: 'string', description: 'op=type 的文本' },
      replace: { type: 'boolean', description: 'op=type 先清空再输入' },
      enter: { type: 'boolean', description: 'op=type 结尾回车' },
      x: { type: 'number' }, y: { type: 'number' }, dy: { type: 'number' }, steps: { type: 'number' },
      direction: { type: 'string', description: 'op=scroll 的滚动方向' },
      format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
    },
  },
  async handler(args = {}) {
    const cfg = loadConfig();
    const proxy = cfg.proxy;
    const op = args.op;

    if (op === 'eval' && cfg.allow_js_eval === false) {
      return errResult('E_BAD_INPUT', 'eval 已被 config.allow_js_eval=false 关闭', null, '如需使用，把 <BOSS_MCP_HOME>/config.json 的 allow_js_eval 改回 true');
    }
    if (NEEDS_TARGET.has(op) && op !== 'restore_window' && !args.target && !readTid()) {
      return errResult('E_TAB_NOT_FOUND', '该 op 需要 target，且无缓存 targetId', null, '先跑 boss_session_start / boss_session_health');
    }
    const target = args.target || readTid();
    const q = (extra) => { const s = new URLSearchParams(); if (target) s.set('target', target); for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') s.set(k, v); return s.toString(); };

    switch (op) {
      case 'targets': {
        const r = await proxyCall('GET', '/targets', { proxy });
        if (!r.ok) return proxyErr(op, r);
        const pages = (Array.isArray(r.body) ? r.body : []).filter((t) => t.type === 'page')
          .map((t) => ({ id: t.targetId, url: t.url, title: t.title }));
        return ok(`当前 ${pages.length} 个 page 标签页`, { targets: pages });
      }
      case 'new_tab': {
        if (!args.url) return errResult('E_BAD_INPUT', 'new_tab 需要 url');
        const r = await proxyCall('POST', '/new', { body: args.url, proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已新建标签页', { target_id: r.body?.targetId || null });
      }
      case 'close_tab': {
        const r = await proxyCall('GET', '/close?' + q({}), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已关闭标签页', r.body);
      }
      case 'info': {
        const r = await proxyCall('GET', '/info?' + q({}), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('标签页信息', r.body);
      }
      case 'back': {
        const r = await proxyCall('GET', '/back?' + q({}), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已后退', r.body);
      }
      case 'eval': {
        if (!args.expression) return errResult('E_BAD_INPUT', 'eval 需要 expression');
        const r = await proxyCall('POST', '/eval?' + q({}), { body: args.expression, proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('eval 完成', { value: r.body?.value ?? r.body });
      }
      case 'click_safe': {
        if (!args.selector) return errResult('E_BAD_INPUT', 'click_safe 需要 selector');
        const r = await proxyCall('POST', '/clickSafe?' + q({}), { body: args.selector, proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('clickSafe 已点击', r.body);
      }
      case 'click': {
        if (!args.selector) return errResult('E_BAD_INPUT', 'click 需要 selector');
        const r = await proxyCall('POST', '/click?' + q({}), { body: args.selector, proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已点击（不保证业务生效，生产请用 click_safe）', r.body);
      }
      case 'click_human': {
        if (!args.selector) return errResult('E_BAD_INPUT', 'click_human 需要 selector');
        const r = await proxyCall('POST', '/clickHuman?' + q({}), { body: args.selector, proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('拟人点击完成', r.body);
      }
      case 'type': {
        if (args.text === undefined) return errResult('E_BAD_INPUT', 'type 需要 text');
        const body = args.selector
          ? { selector: args.selector, text: args.text, replace: !!args.replace, enter: !!args.enter }
          : args.text;
        const r = await proxyCall('POST', '/type?' + q({}), { body, proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已输入', r.body);
      }
      case 'set_files': {
        if (!args.files || !args.files.length) return errResult('E_BAD_INPUT', 'set_files 需要 files');
        // T1-3：文件上传路径约束——仅允许 BOSS_MCP_HOME 或 config.upload_dirs 声明的目录，拒绝系统目录
        const allowedDirs = [PATHS.home, ...(cfg.upload_dirs || [])].filter(Boolean).map((d) => path.resolve(String(d)).toLowerCase());
        for (const f of args.files) {
          const abs = path.resolve(String(f)).toLowerCase();
          const okDir = allowedDirs.some((d) => abs === d || abs.startsWith(d + path.sep.toLowerCase()));
          if (!okDir) return errResult('E_BAD_INPUT', `set_files 拒绝未授权目录下的文件：${f}`, null, '文件上传仅允许 <BOSS_MCP_HOME> 或 config.upload_dirs 声明的目录，请先把文件拷入后再引用');
        }
        const body = { selector: args.selector || 'input[type=file]', files: args.files };
        const r = await proxyCall('POST', '/setFiles?' + q({}), { body, proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已设置文件', r.body);
      }
      case 'scroll': {
        const r = await proxyCall('GET', '/scroll?' + q({ y: args.y, direction: args.direction }), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已滚动', r.body);
      }
      case 'wheel': {
        const r = await proxyCall('GET', '/wheel?' + q({ dy: args.dy, steps: args.steps }), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已滚动', r.body);
      }
      case 'mouse_move': {
        const r = await proxyCall('GET', '/mouseMove?' + q({ steps: args.steps, selector: args.selector }), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已移动鼠标', r.body);
      }
      case 'focus': {
        const r = await proxyCall('GET', '/focus?' + q({}), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已聚焦窗口', r.body);
      }
      case 'restore_window': {
        const s = new URLSearchParams();
        if (target) s.set('target', target);
        if (args.all) s.set('all', '1');
        const r = await proxyCall('GET', '/restore-window?' + s.toString(), { proxy });
        if (!r.ok) return proxyErr(op, r);
        return ok('已还原窗口', r.body);
      }
      case 'screenshot': {
        const s = new URLSearchParams();
        if (target) s.set('target', target);
        s.set('format', args.format || 'png');
        const r = await proxyCall('GET', '/screenshot?' + s.toString(), { proxy, timeoutMs: 30000 });
        if (!r.ok) return proxyErr(op, r);
        if (Buffer.isBuffer(r.body)) {
          let file = args.file || null;
          if (file) {
            try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(path.resolve(file), r.body); }
            catch (e) { file = null; }
          }
          const mimeType = args.format === 'jpeg' ? 'image/jpeg' : 'image/png';
          return { text: '截图完成', data: { file }, isError: false, code: null, image: { data: r.body.toString('base64'), mimeType } };
        }
        return ok('截图已保存', r.body);
      }
      default:
        return errResult('E_BAD_INPUT', `未知 op: ${op}`);
    }
  },
};
