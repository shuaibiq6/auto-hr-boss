#!/usr/bin/env node
/**
 * risk-check.mjs — 平台风控信号自检（触达前后各跑一次）
 *
 * 为什么要有这个脚本：
 *   风控自检是批量触达里唯一「必须每次执行」的动作，此前每次都由 Agent 现写脚本，
 *   结果反复踩同一个坑——用 [class*=slider] 查验证码会命中首页轮播 .omnibus-slider-main，
 *   把正常页面误判成风控拦截。本脚本把「带尺寸判断的精确选择器组」固化为默认值，
 *   并把「页面不可见导致 Input 命令挂起」的已知坑一并纳入自检。
 *
 * 用法：
 *   node risk-check.mjs --target <tabId>
 *   node risk-check.mjs --target <tabId> --json
 *   node risk-check.mjs --target <tabId> --proxy http://127.0.0.1:3456
 *
 * 退出码：
 *   0 = 正常，可继续操作
 *   3 = 需要干预（页面不可见 / 登录失效），脚本已尝试自动唤醒，请按提示处理
 *   4 = 命中风控信号 —— 立即终止当天全部触达操作
 *   1 = 参数或网络错误
 */

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const n = argv[i + 1];
  if (n === undefined || n.startsWith('--')) args[k] = true;
  else { args[k] = n; i++; }
}

if (args.help || args.h) {
  const src = (await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8');
  console.log(src.slice(0, src.indexOf('*/'))
    .split('\n').slice(2)
    .map((l) => l.replace(/^\s*\/\*\*?/, '').replace(/^\s*\*\s?/, ''))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim());
  process.exit(0);
}

if (!args.target) {
  console.error('缺少必需参数：--target <tabId>（先用 curl http://localhost:3456/targets 查）');
  process.exit(1);
}

const PROXY = String(args.proxy || 'http://127.0.0.1:3456').replace(/\/$/, '');
const TID = String(args.target);

// 带尺寸判断的选择器组 —— 只有真实可见的验证码容器才算命中。
// 注意：不要用 [class*=slider]，它会命中首页轮播 .omnibus-slider-main（实测踩过）。
const PROBE_JS = `(() => {
  const sizeOk = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 40 || r.height <= 30) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.05;
  };
  const SELS = [
    '.uc-figure', '.geetest_panel', '.geetest_widget', '.nc_wrapper', '.bcap-wrapper',
    '.verify-bar', '.verify-slide', '.captcha-wrap', '.captcha-box', '.zhipin-captcha',
    '[class*="captcha-wrap"]', '[class*="captcha-box"]', '[class*="verify-bar"]', '[class*="verify-slide"]'
  ];
  const hits = [];
  for (const s of SELS) {
    try { for (const el of document.querySelectorAll(s)) if (sizeOk(el)) { hits.push(s); break; } } catch (e) {}
  }
  const bodyText = document.body ? (document.body.innerText || '') : '';
  const KW = ['安全验证','请完成验证','操作过于频繁','账号异常','访问受限','行为异常','请稍后再试','拖动滑块','系统检测到','异常操作','请验证身份'];
  const kwHits = KW.filter((k) => bodyText.includes(k));
  // 要求答题的优先级高于验证码：验证码可能是常规人机校验，答题是已判定违规后的处置动作
  const QUIZ = ['请回答','验证问答','请完成以下问题','答题','请回答问题'];
  const quizHits = QUIZ.filter((k) => bodyText.includes(k));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    vis: document.visibilityState,
    hasFocus: document.hasFocus(),
    ow: outerWidth, oh: outerHeight,
    iw: innerWidth, ih: innerHeight,
    captchaEls: [...new Set(hits)],
    kwHits, quizHits,
    // 2026-10-10 修复：原判据只认 /web/user/login 与标题「请登录|登录后」，漏判 BOSS 实际登录页
    // （路径 /web/user/ 含 ?ka=bticket，标题「【BOSS直聘注册登录】…」）→ 会把登录页误报为 OK。
    loginWall: /\\/web\\/user/i.test(location.pathname) || /请登录|登录后|注册登录/.test(document.title)
  });
})()`;

async function evalInPage(expr) {
  const res = await fetch(`${PROXY}/eval?target=${encodeURIComponent(TID)}`, {
    method: 'POST',
    body: expr,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`proxy 返回 HTTP ${res.status}`);
  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  // proxy 的 /eval 可能返回 { result: { result: { value } } } 或直接返回值
  const v = parsed?.result?.result?.value ?? parsed?.value ?? parsed;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

async function focusPage() {
  try {
    await fetch(`${PROXY}/focus?target=${encodeURIComponent(TID)}`, { signal: AbortSignal.timeout(10000) });
    await new Promise((r) => setTimeout(r, 1000));
    return true;
  } catch { return false; }
}

let state;
try {
  state = await evalInPage(PROBE_JS);
} catch (e) {
  console.error(`自检失败：${e.message}`);
  console.error('检查 CDP Proxy 是否在运行（node scripts/check-deps.mjs），以及 targetId 是否有效。');
  process.exit(1);
}

if (typeof state !== 'object' || state === null) {
  console.error(`自检失败：页面返回了非预期结果 —— ${JSON.stringify(state)}`);
  process.exit(1);
}

// 已知坑：页面不可见时 Input 域命令会永久挂起。自动唤醒一次再复检。
let autoWoke = false;
if (state.vis === 'hidden' || !state.ow) {
  autoWoke = await focusPage();
  if (autoWoke) {
    try { state = await evalInPage(PROBE_JS); } catch { /* 保持原状态 */ }
  }
}

const stillHidden = state.vis === 'hidden' || !state.ow;
const blocked = state.quizHits.length > 0 || state.captchaEls.length > 0 || state.kwHits.length > 0;

let verdict, exitCode, actions = [];
if (state.quizHits.length > 0) {
  verdict = 'BLOCK';
  exitCode = 4;
  actions.push('出现「被要求答题」——这是平台已判定违规之后的处置动作，优先级高于验证码。立即终止当天全部触达操作。');
} else if (state.captchaEls.length > 0 || state.kwHits.length > 0) {
  verdict = 'BLOCK';
  exitCode = 4;
  actions.push('命中验证码 / 风控文案。立即终止当天全部触达操作，不要重试、不要刷新硬闯。');
} else if (stillHidden) {
  verdict = 'WARN';
  exitCode = 3;
  actions.push('页面仍不可见（visibilityState=hidden 或 outerWidth=0）。此时 Input 域命令（点击/滚轮）会永久挂起。');
  actions.push('手动把浏览器窗口还原并置于前台，再重跑一次本脚本；或直接复用 /focus 返回的 vis:visible 确认。');
} else if (state.loginWall) {
  verdict = 'WARN';
  exitCode = 3;
  actions.push('当前页面疑似登录页。请在浏览器中完成登录后重跑。');
} else {
  verdict = 'OK';
  exitCode = 0;
}

const report = {
  checkedAt: new Date().toISOString(),
  target: TID,
  verdict,
  url: state.url,
  title: state.title,
  visible: !stillHidden,
  autoWoke,
  signals: {
    captchaElements: state.captchaEls,
    riskKeywords: state.kwHits,
    quizKeywords: state.quizHits,
    loginWall: state.loginWall,
  },
  actions,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[风控自检] ${verdict}${autoWoke ? '（已自动唤醒窗口）' : ''}`);
  console.log(`  页面：${state.title || '(无标题)'}`);
  console.log(`  URL ：${state.url}`);
  console.log(`  可见：${stillHidden ? '否 ← 会导致 Input 命令挂起' : '是'}`);
  if (state.captchaEls.length) console.log(`  验证码容器：${state.captchaEls.join(', ')}`);
  if (state.kwHits.length) console.log(`  风险文案：${state.kwHits.join('、')}`);
  if (state.quizHits.length) console.log(`  答题信号：${state.quizHits.join('、')}`);
  if (actions.length) {
    console.log('  处置：');
    for (const a of actions) console.log(`    - ${a}`);
  }
}

process.exit(exitCode);
