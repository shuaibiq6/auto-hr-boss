#!/usr/bin/env node
/**
 * preflight.mjs — 批量触达类操作的前置闸门
 *
 * 用途：在一批「代表用户向真人发起触达」的操作（招聘投递、给 HR 发招呼、
 * 给商家/作者留言等）执行前，对候选列表做机器可执行的准入判定，从源头
 * 消除两类风险：
 *   1) 投诉风险 —— 不匹配 / 像群发 / 打扰接收方
 *   2) 降权风险 —— 被接收方标记「不合适」，导致账号推荐权重被静默降低
 *
 * 设计依据见 references/recruiter-perspective.md（接收方视角的风险模型）。
 *
 * 用法：
 *   node preflight.mjs --init                      在当前目录生成配置模板
 *   node preflight.mjs --profile p.json --candidates c.json [--history h.json]
 *   node preflight.mjs ... --table                 输出可读表格而非 JSON
 *   node preflight.mjs ... --out result.json       同时写结果文件
 *
 *   # 触达完成后回写历史（闭环，必须做——否则同公司冷却与重复投递拦截会静默失效）
 *   node preflight.mjs --commit result.json --history preflight.history.json
 *   node preflight.mjs --commit --out result.json --history h.json [--commit-only id1,id2]
 *
 * 退出码：0 = 有可投递候选（或 commit 成功）；2 = 全部被拒 / 无额度；1 = 参数或文件错误
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const doc = src.slice(0, src.indexOf('*/'));
  const lines = doc
    .split('\n')
    .slice(1) // 去掉 shebang 行
    .map((l) => l.replace(/^\s*\/\*\*?/, '').replace(/^\s*\*\s?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  console.log(lines);
  process.exit(0);
}

// ---------------------------------------------------------------- 模板生成

const PROFILE_TEMPLATE = {
  _comment: '求职者画像。coreSkills 权重 2 分，skills 权重 1 分。',
  name: '',
  city: '',
  degree: '本科',
  graduated: false,
  experienced: false, // false 时启用「经验年限」闸门（应届/在校身份，必须为 false；缺省按 false 从严处理）
  directions: ['ai-app', 'ai-fullstack', 'python-backend'],
  coreSkills: ['FastAPI', 'SQLAlchemy', 'MySQL', 'Docker', 'pytest'],
  skills: ['Python', 'RESTful', 'Alembic', 'Pydantic', 'DeepSeek', 'SSE', 'TypeScript', 'React', 'Node.js', 'Linux', 'Git', 'Playwright'],
  minSalaryMonthly: 4000,
  excludeKeywords: ['销售', '客服', '外包', '派遣', '培训', '招生', '带货', '主播', '地推', '运营', '电销', '兼职', '刷单'],
  limits: {
    dailyMax: 12,
    perDirectionMax: 5,
    perCompanyMax: 1,
    minGapSeconds: 45,
    maxGapSeconds: 180,
    matchThreshold: 3,
    repeatCompanyCooldownDays: 30,
    activeWindows: [['09:30', '11:30'], ['14:00', '17:30']],
  },
};

const CANDIDATES_TEMPLATE = [
  {
    _comment: 'id/company/title 必填；jd 越完整判定越准。direction 需出现在 profile.directions 中。',
    id: 'job-001',
    company: '示例科技',
    title: 'AI 应用开发工程师',
    salary: '15-18K',
    tags: 'Python FastAPI 大模型',
    jd: '负责大模型应用落地，熟悉 Python / FastAPI，有 RAG 或 Agent 项目经验优先。经验不限。',
    direction: 'ai-app',
    url: '/job_detail/xxxxxxxx.html',
    hr: '张女士',
  },
];

const HISTORY_TEMPLATE = [
  {
    _comment: '已投递记录。用 company + ts 实现同公司冷却，用 url/id 实现重复投递拦截。',
    id: 'job-000',
    company: '已投过的公司',
    title: '已投过的岗位',
    direction: 'ai-app',
    url: '/job_detail/yyyyyyyy.html',
    ts: '2026-09-29 15:01',
    status: 'sent',
  },
];

if (args.init) {
  const dir = args.init === true ? '.' : String(args.init);
  const files = [
    ['preflight.profile.json', PROFILE_TEMPLATE],
    ['preflight.candidates.json', CANDIDATES_TEMPLATE],
    ['preflight.history.json', HISTORY_TEMPLATE],
  ];
  for (const [name, data] of files) {
    const p = resolve(dir, name);
    if (existsSync(p)) { console.log(`跳过（已存在）: ${p}`); continue; }
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    console.log(`已生成: ${p}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- 触达记录回写（闭环）
// 闸门只回答「该触达谁」。这个分支负责把「实际触达了谁」固化回 history。
// 没有它，同公司冷却与重复触达拦截会因漏记而静默失效——闸门看起来在跑，实际已经失效。

if (args.commit) {
  const histPath = resolve(String(args.history || 'preflight.history.json'));
  const srcPath = args.commit === true
    ? (args.out ? resolve(String(args.out)) : null)
    : resolve(String(args.commit));

  if (!srcPath || !existsSync(srcPath)) {
    console.error('--commit 需要一份闸门结果文件：先用 --out 生成，或 --commit <path> 指定');
    process.exit(1);
  }
  if (!existsSync(histPath)) {
    console.error(`history 文件不存在：${histPath}（先跑 --init 生成）`);
    process.exit(1);
  }

  let fresh;
  try {
    fresh = JSON.parse(readFileSync(srcPath, 'utf8'));
  } catch (e) {
    console.error(`结果文件解析失败 ${basename(srcPath)}：${e.message}`);
    process.exit(1);
  }

  const only = args['commit-only']
    ? String(args['commit-only']).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const pool = (fresh.accepted || []).filter((c) => !only || only.includes(String(c.id)));

  if (!pool.length) {
    console.error('没有可提交的条目（accepted 为空，或 --commit-only 未命中任何 id）');
    process.exit(1);
  }

  let rows;
  try {
    rows = JSON.parse(readFileSync(histPath, 'utf8')).filter((r) => !r._comment);
  } catch (e) {
    console.error(`history 解析失败 ${basename(histPath)}：${e.message}`);
    process.exit(1);
  }

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const seen = new Set(rows.map((r) => String(r.id || r.url || '')).filter(Boolean));

  let added = 0;
  for (const c of pool) {
    const key = String(c.id || c.url || '');
    if (key && seen.has(key)) continue; // 幂等：重复 commit 不会写出重复行
    rows.push({
      id: c.id, company: c.company, title: c.title,
      direction: c.direction, url: c.url, ts, status: 'sent',
    });
    if (key) seen.add(key);
    added++;
  }

  writeFileSync(histPath, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`已回写 ${added} 条（跳过重复 ${pool.length - added} 条）→ ${histPath}，累计 ${rows.length} 条`);
  process.exit(0);
}

// ---------------------------------------------------------------- 读取输入

function readJson(p, label, required = true) {
  if (!p) {
    if (required) { console.error(`缺少参数：${label}`); process.exit(1); }
    return null;
  }
  const path = resolve(String(p));
  if (!existsSync(path)) { console.error(`文件不存在：${path}`); process.exit(1); }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(data) ? data : [data];
  } catch (e) {
    console.error(`解析失败 ${basename(path)}：${e.message}`);
    process.exit(1);
  }
}

const profile = readJson(args.profile, '--profile')[0];
const candidates = readJson(args.candidates, '--candidates');
const history = args.history ? readJson(args.history, '--history', false) : [];

const L = { ...PROFILE_TEMPLATE.limits, ...(profile.limits || {}) };
const coreSkills = (profile.coreSkills || []).map((s) => s.toLowerCase());
const skills = (profile.skills || []).map((s) => s.toLowerCase());
const excludeKeywords = profile.excludeKeywords || [];
const directions = profile.directions || [];

// ---------------------------------------------------------------- 工具函数

const texts = (c) => [c.title, c.tags, c.jd, c.experience].filter(Boolean).join('\n').toLowerCase();

function hitCount(hay, needle) {
  if (!needle) return 0;
  // 关键词按非字母数字边界做包含匹配，中英文都适用
  return hay.includes(needle) ? 1 : 0;
}

/** 解析薪资区间为月薪下限（元）。支持 "15-18K" / "4-8K·16薪" / "200-250元/天" */
function salaryFloorMonthly(raw) {
  if (!raw) return null;
  const s = String(raw);
  const perDay = s.match(/(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*元?\s*\/?\s*天/);
  if (perDay) return Math.round(Number(perDay[1]) * 21.75);
  const kRange = s.match(/(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*[kK]/);
  if (kRange) return Math.round(Number(kRange[1]) * 1000);
  const kSingle = s.match(/(\d+(?:\.\d+)?)\s*[kK]/);
  if (kSingle) return Math.round(Number(kSingle[1]) * 1000);
  const num = s.match(/(\d{3,})/);
  return num ? Number(num[1]) : null;
}

/** 从 JD 里抽取经验年限要求，返回 { years, snippet } 或 null */
function requiredYears(jd) {
  if (!jd) return null;
  const t = String(jd);
  const pats = [
    /(\d+)\s*[-~至到]\s*(\d+)\s*年[以上以内]*(?:工作)?经验/,
    /(\d+)\s*年[以上及其]+(?:工作)?经验/,
    /经验\s*(\d+)\s*[-~至到]\s*(\d+)\s*年/,
    /(\d+)\s*年以上/,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) return { years: Number(m[1]), snippet: m[0] };
  }
  if (/经验不限|不限经验|应届|实习|在校/.test(t)) return { years: 0, snippet: '经验不限/应届可' };
  return null;
}

// ---------------------------------------------------------------- 闸门判定

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const nowMinutes = now.getHours() * 60 + now.getMinutes();
const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

const windows = (L.activeWindows || []).map(([a, b]) => [toMinutes(a), toMinutes(b)]);
const inWindow = windows.length === 0 || windows.some(([a, b]) => nowMinutes >= a && nowMinutes <= b);

const historyToday = history.filter((h) => String(h.ts || '').startsWith(todayStr));
const todayCompanyCount = new Map();
for (const h of historyToday) {
  const k = (h.company || '').trim();
  todayCompanyCount.set(k, (todayCompanyCount.get(k) || 0) + 1);
}

const seenCompanies = new Set(history.map((h) => (h.company || '').trim()).filter(Boolean));
const seenKeys = new Set();
for (const h of history) {
  if (h.url) seenKeys.add(String(h.url));
  if (h.id) seenKeys.add(String(h.id));
}

/** 同公司冷却：命中返回已投天数差，否则 null */
function companyCooldownDays(company) {
  const prev = history.filter((h) => (h.company || '').trim() === company && h.ts);
  if (!prev.length) return null;
  let minDiff = Infinity;
  for (const h of prev) {
    const d = new Date(String(h.ts).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) { minDiff = 0; continue; }
    minDiff = Math.min(minDiff, Math.floor((now - d) / 86400000));
  }
  return minDiff;
}

const scored = [];
const rejected = [];
const review = [];

for (const c of candidates) {
  const reasons = [];
  const hardReasons = [];
  const softReasons = [];
  const hay = texts(c);

  // ---- G0 硬红线
  const titleText = [c.title, c.tags].filter(Boolean).join(' ').toLowerCase();
  for (const kw of excludeKeywords) {
    const k = String(kw).toLowerCase();
    if (!k) continue;
    if (titleText.includes(k)) hardReasons.push(`岗位名/标签命中排除词「${kw}」`);
    else if (hay.includes(k)) softReasons.push(`JD 出现排除词「${kw}」，需看过正文确认是否本职`);
  }

  if (c.company && (c.id && seenKeys.has(String(c.id)) || c.url && seenKeys.has(String(c.url)))) {
    hardReasons.push('该岗位已在历史记录中（重复投递）');
  } else if (c.company) {
    const cd = companyCooldownDays(c.company);
    if (cd !== null && cd < (L.repeatCompanyCooldownDays ?? 30)) {
      hardReasons.push(`同公司冷却中（${cd} 天前投过，门槛 ${L.repeatCompanyCooldownDays ?? 30} 天）`);
    }
    if ((todayCompanyCount.get(c.company) || 0) >= (L.perCompanyMax ?? 1)) {
      hardReasons.push(`今日已投该公司 ${todayCompanyCount.get(c.company)} 次（上限 ${L.perCompanyMax ?? 1}）`);
    }
  }

  if (c.direction && directions.length && !directions.includes(c.direction)) {
    softReasons.push(`方向「${c.direction}」不在目标方向内`);
  }

  // ---- G1 匹配度
  const matchedCore = coreSkills.filter((s) => hitCount(hay, s));
  const matchedNormal = skills.filter((s) => hitCount(hay, s));
  const score = matchedCore.length * 2 + matchedNormal.length;
  const matchedSkills = [
    ...(profile.coreSkills || []).filter((_, i) => matchedCore.includes(String(profile.coreSkills[i]).toLowerCase())),
    ...(profile.skills || []).filter((_, i) => matchedNormal.includes(String(profile.skills[i]).toLowerCase())),
  ];

  // 列表页抓取的数据没有 JD 正文，命中分天然偏低，不能据此硬拒
  const infoLen = (c.jd || '').length + (c.tags || '').length;
  const lowInfo = infoLen < 180;
  const reviewReasons = [];

  if (score < (L.matchThreshold ?? 3)) {
    const msg = `技术栈命中分 ${score} < 门槛 ${L.matchThreshold ?? 3}（命中：${matchedSkills.join('/') || '无'}）`;
    if (lowInfo) reviewReasons.push(`${msg}；但候选信息量不足（${infoLen} 字），缺 JD 正文，不能据此否决——须打开详情页核实`);
    else hardReasons.push(msg);
  }

  // ---- G1b 经验与薪资
  const req = requiredYears(c.jd);
  const relaxHint = /初级|应届|不限|可放宽|实习|在校|培养|无经验|经验不作要求/.test(c.jd || '');
  if (req && req.years >= 2 && !profile.experienced) {
    if (relaxHint) {
      softReasons.push(`JD 出现「${req.snippet}」的年限要求，但同文含放宽信号——须看正文确认是「分档要求（初级档可投）」还是硬门槛`);
    } else {
      hardReasons.push(`JD 要求 ${req.years} 年以上经验（「${req.snippet}」），与应届/在校身份冲突，属「不合适」标记高发区`);
    }
  } else if (req && req.years === 1 && !profile.experienced) {
    softReasons.push('JD 要求 1 年经验，可按「优秀应届可放宽」尝试；若被标记不合适请记录');
  }

  const floor = salaryFloorMonthly(c.salary);
  if (floor !== null && profile.minSalaryMonthly && floor < profile.minSalaryMonthly) {
    softReasons.push(`薪资下限约 ¥${floor}/月，低于预期 ¥${profile.minSalaryMonthly}/月`);
  }

  const item = {
    id: c.id,
    company: c.company,
    title: c.title,
    salary: c.salary,
    direction: c.direction,
    url: c.url,
    hr: c.hr,
    score,
    matchedSkills,
    requiredYears: req ? req.years : null,
  };

  if (hardReasons.length) {
    rejected.push({ ...item, verdict: 'REJECT', reasons: [...hardReasons, ...softReasons] });
  } else if (reviewReasons.length) {
    review.push({ ...item, verdict: 'REVIEW', reasons: [...reviewReasons, ...softReasons] });
  } else {
    scored.push({ ...item, verdict: 'PASS', reasons: softReasons });
  }
}

// ---- G2 批次闸门：方向配额 + 总量配额
scored.sort((a, b) => b.score - a.score);

const perDir = new Map();
const perCompany = new Map();
const accepted = [];
const deferred = [];
const quotaLeft = Math.max(0, (L.dailyMax ?? 12) - historyToday.length);

for (const c of scored) {
  if (accepted.length >= quotaLeft) { deferred.push({ ...c, verdict: 'DEFER', reasons: [`今日额度已用尽（已投 ${historyToday.length} / 上限 ${L.dailyMax ?? 12}）`] }); continue; }
  const d = c.direction || '_';
  const comp = (c.company || '').trim();
  if ((perDir.get(d) || 0) >= (L.perDirectionMax ?? 5)) {
    deferred.push({ ...c, verdict: 'DEFER', reasons: [`方向「${d}」今日配额已满（上限 ${L.perDirectionMax ?? 5}），留到下次`] });
    continue;
  }
  if ((perCompany.get(comp) || 0) >= (L.perCompanyMax ?? 1)) {
    deferred.push({ ...c, verdict: 'DEFER', reasons: [`该公司已有 1 个岗位入选，避免同公司多投`] });
    continue;
  }
  perDir.set(d, (perDir.get(d) || 0) + 1);
  perCompany.set(comp, (perCompany.get(comp) || 0) + 1);
  accepted.push(c);
}

// ---- G3 时序闸门：生成带方差的间隔计划
function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }

const plan = [];
let cursor = now.getTime();
accepted.forEach((c, i) => {
  if (i > 0) {
    // 间隔带方差：避免定长间隔被自相关分析识别
    const base = randInt(L.minGapSeconds ?? 45, L.maxGapSeconds ?? 180);
    const jitter = Math.round(base * (0.75 + Math.random() * 0.5));
    cursor += jitter * 1000;
  }
  const t = new Date(cursor);
  plan.push({
    order: i + 1,
    company: c.company,
    title: c.title,
    direction: c.direction,
    gapFromPrevSeconds: i === 0 ? 0 : Math.round((cursor - plan[i - 1]._ts) / 1000),
    plannedAt: `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`,
    _ts: cursor,
  });
});
for (const p of plan) delete p._ts;

// ---- 汇总
const warnings = [];
if (!inWindow) {
  warnings.push(`当前 ${pad(now.getHours())}:${pad(now.getMinutes())} 不在允许投放时段（${(profile.limits?.activeWindows || PROFILE_TEMPLATE.limits.activeWindows).map((w) => w.join('-')).join(' / ')}）。落在接收方非工作时段会显得刻意，建议改期。`);
}
const directionSpread = [...perDir.entries()].map(([k, v]) => `${k}×${v}`).join('，') || '无';
if (perDir.size > 2) {
  warnings.push(`本次覆盖 ${perDir.size} 个方向（${directionSpread}）。单批方向过多会形成「什么都能投」的印象，建议收窄到 1–2 个主方向。`);
}
if (accepted.length >= 8) {
  warnings.push(`本批入选 ${accepted.length} 个，接近单日上限。建议拆成两个时段投放，不要一次跑完。`);
}
if (review.length > accepted.length && review.length > 2) {
  warnings.push(`${review.length} 个候选因信息量不足待核实。列表页的标题与标签判不准匹配度——必须打开详情页读 JD 正文后再决定，不要凭标题投。`);
}
const judged = accepted.length + rejected.length;
if (judged > 0 && rejected.length > accepted.length && candidates.length > 3) {
  warnings.push(`淘汰率 ${Math.round((rejected.length / judged) * 100)}%（不含待核）。这是健康信号——闸门在起作用；若长期为 0，说明阈值过松。`);
}

const result = {
  generatedAt: `${todayStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  config: {
    profile: args.profile ? basename(String(args.profile)) : null,
    candidates: args.candidates ? basename(String(args.candidates)) : null,
    historyFile: args.history ? basename(String(args.history)) : null,
  },
  batch: {
    inActiveWindow: inWindow,
    todaySent: historyToday.length,
    dailyMax: L.dailyMax ?? 12,
    quotaLeft,
    total: candidates.length,
    accepted: accepted.length,
    rejected: rejected.length,
    review: review.length,
    deferred: deferred.length,
    directionSpread,
  },
  accepted,
  rejected,
  review,
  deferred,
  warnings,
  plan,
};

// ---------------------------------------------------------------- 输出

const table = () => {
  const lines = [];
  lines.push('===== 前置闸门结果 ' + result.generatedAt + ' =====');
  lines.push(`今日已投 ${result.batch.todaySent}/${result.batch.dailyMax}　剩余额度 ${quotaLeft}　时段合规 ${inWindow ? '是' : '否'}`);
  lines.push(`候选 ${candidates.length}　通过 ${accepted.length}　待核 ${review.length}　否决 ${rejected.length}　暂缓 ${deferred.length}`);
  lines.push(`方向分布：${directionSpread}`);
  if (accepted.length) {
    lines.push('\n-- 通过（按匹配分降序）--');
    for (const c of accepted) lines.push(`  ${String(c.score).padStart(3)}分  ${c.company} · ${c.title}  [${c.matchedSkills.join('/') || '-'}]`);
  }
  if (review.length) {
    lines.push('\n-- 待核实（信息量不足，须打开详情页读完 JD 再定）--');
    for (const c of review) lines.push(`  ${c.company} · ${c.title}\n        ${c.reasons.join('\n        ')}`);
  }
  if (rejected.length) {
    lines.push('\n-- 否决 --');
    for (const c of rejected) lines.push(`  ${c.company} · ${c.title}\n        ${c.reasons.join('\n        ')}`);
  }
  if (deferred.length) {
    lines.push('\n-- 暂缓 --');
    for (const c of deferred) lines.push(`  ${c.company} · ${c.title}\n        ${c.reasons.join(' / ')}`);
  }
  if (plan.length) {
    lines.push('\n-- 投放计划（间隔已加抖动）--');
    for (const p of plan) lines.push(`  ${p.plannedAt}  (+${p.gapFromPrevSeconds}s)  ${p.company} · ${p.title}`);
  }
  if (warnings.length) {
    lines.push('\n-- 警告 --');
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n');
};

const rendered = args.table ? table() : JSON.stringify(result, null, 2);
console.log(rendered);
if (args.out) {
  const outPath = resolve(String(args.out));
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.error(`\n结果已写入: ${outPath}`);
  } catch (e) {
    // 写文件失败不影响结果可用性：JSON 已输出到 stdout
    console.error(`\n结果文件写入失败（已跳过，stdout 仍可用）: ${outPath} — ${e.message}`);
  }
}

process.exit(accepted.length > 0 ? 0 : 2);
