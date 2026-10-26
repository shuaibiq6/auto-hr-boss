#!/usr/bin/env node
/**
 * screen-talent.mjs — 招聘方主动触达：候选人筛选闸门与匹配度排序
 *
 * 场景：你以招聘方身份，在招聘平台主动向候选人发起招呼（打招呼）。
 *       本脚本只回答「该不该触达这些人、按什么顺序触达」，不负责点击动作本身。
 *
 * 与 preflight.mjs 的分工：
 *   preflight.mjs      求职者视角 —— 我的技能 vs 岗位要求，筛选「我该投哪些岗」
 *   screen-talent.mjs  招聘方视角 —— 岗位要求 vs 候选人简历，筛选「我该联系谁」
 *   闸门结构相同，判定方向相反；通用风险模型见 references/talent-outreach.md。
 *
 * 用法：
 *   node screen-talent.mjs --init                        生成 job/talent/touch 配置模板
 *   node screen-talent.mjs --job j.json --talent t.json [--touch history.json]
 *   node screen-talent.mjs ... --table                   输出可读表格而非 JSON
 *   node screen-talent.mjs ... --out result.json         同时写结果文件
 *
 *   # 触达完成后回写历史（闭环，必须做——否则重复触达与冷却会静默失效）
 *   node screen-talent.mjs --commit result.json --touch history.json
 *   node screen-talent.mjs --commit --out result.json --touch h.json [--commit-only id1,id2]
 *
 * 退出码：0 = 有可触达候选人；2 = 无（全部被拒 / 无额度）；1 = 参数或文件错误
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
  console.log(doc
    .split('\n')
    .slice(2)
    .map((l) => l.replace(/^\s*\/\*\*?/, '').replace(/^\s*\*\s?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
  process.exit(0);
}

// ---------------------------------------------------------------- 模板

const JOB_TEMPLATE = {
  _comment: '岗位画像。coreSkills 权重 2 分、skills 权重 1 分，命中数决定匹配分；coreSkills 放「没它就别聊」的硬技能。',
  positionId: '',
  positionTitle: 'AI 应用开发工程师',
  company: '',
  direction: 'ai-app',
  city: '郑州',
  coreSkills: ['Python', 'FastAPI', '大模型', 'RAG'],
  skills: ['SQLAlchemy', 'MySQL', 'Docker', 'LangChain', '向量数据库', 'SSE', 'Redis', 'Linux', 'Git'],
  minExperienceYears: 0,
  maxExperienceYears: 3,
  minDegree: '本科',
  salaryBudgetMonthly: [12000, 18000],
  excludeKeywords: ['销售', '客服', '运营', '产品经理', '测试工程师', 'UI', '前端开发', '实施', '售前', '讲师', '培训', '美工', '主播', '带货'],
  requireCity: '郑州',
  limits: {
    dailyMax: 12,
    perPositionMax: 8,
    minGapSeconds: 60,
    maxGapSeconds: 240,
    matchThreshold: 3,
    repeatTalentCooldownDays: 30,
    staleTalentDays: 30,
    activeWindows: [['09:30', '11:30'], ['14:00', '17:30']],
  },
};

const TALENT_TEMPLATE = [
  {
    _comment: '候选人。id / url 至少一个用于去重；skills 与 resume 越完整判定越准。activeStatus 直接影响触达价值。',
    id: 'geek-001',
    name: '张示例',
    title: 'Python 后端开发工程师',
    skills: 'Python FastAPI MySQL Docker',
    experience: '3年经验',
    degree: '本科',
    school: '某某大学',
    expectSalary: '12-18K',
    expectCity: '郑州',
    activeStatus: '刚刚活跃',
    appliedToUs: false,
    resume: '负责订单系统后端开发，使用 FastAPI + SQLAlchemy 重构核心接口，QPS 提升 3 倍。',
    url: '/web/boss/geek/xxxxxxxx',
  },
];

const TOUCH_TEMPLATE = [
  {
    _comment: '已触达记录。用 id / url 去重，用 ts 计算同一候选人的冷却期——必须跨日累积。',
    id: 'geek-000',
    name: '已打过招呼的人',
    title: 'Python 开发',
    direction: 'ai-app',
    url: '/web/boss/geek/yyyyyyyy',
    ts: '2026-09-29 15:01',
    status: 'sent',
  },
];

if (args.init) {
  const dir = args.init === true ? '.' : String(args.init);
  const files = [
    ['screen.job.json', JOB_TEMPLATE],
    ['screen.talent.json', TALENT_TEMPLATE],
    ['screen.touch.json', TOUCH_TEMPLATE],
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

if (args.commit) {
  const touchPath = resolve(String(args.touch || 'screen.touch.json'));
  const srcPath = args.commit === true
    ? (args.out ? resolve(String(args.out)) : null)
    : resolve(String(args.commit));

  if (!srcPath || !existsSync(srcPath)) {
    console.error('--commit 需要一份闸门结果文件：先用 --out 生成，或 --commit <path> 指定');
    process.exit(1);
  }
  if (!existsSync(touchPath)) {
    console.error(`触达记录文件不存在：${touchPath}（先跑 --init 生成）`);
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
  const pool = (fresh.accepted || []).filter((t) => !only || only.includes(String(t.id)));

  if (!pool.length) {
    console.error('没有可提交的条目（accepted 为空，或 --commit-only 未命中任何 id）');
    process.exit(1);
  }

  let rows;
  try {
    rows = JSON.parse(readFileSync(touchPath, 'utf8')).filter((r) => !r._comment);
  } catch (e) {
    console.error(`触达记录解析失败 ${basename(touchPath)}：${e.message}`);
    process.exit(1);
  }

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const seen = new Set(rows.map((r) => String(r.id || r.url || '')).filter(Boolean));

  let added = 0;
  for (const t of pool) {
    const key = String(t.id || t.url || '');
    if (key && seen.has(key)) continue; // 幂等：重复 commit 不会写出重复行
    rows.push({
      id: t.id, name: t.name, title: t.title,
      direction: t.direction, url: t.url, ts, status: 'sent',
    });
    if (key) seen.add(key);
    added++;
  }

  writeFileSync(touchPath, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`已回写 ${added} 条（跳过重复 ${pool.length - added} 条）→ ${touchPath}，累计 ${rows.length} 条`);
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

const job = readJson(args.job, '--job')[0];
const talent = readJson(args.talent, '--talent');
const touched = args.touch ? readJson(args.touch, '--touch', false) : [];

const L = { ...JOB_TEMPLATE.limits, ...(job.limits || {}) };
const coreSkills = (job.coreSkills || []).map((s) => String(s).toLowerCase());
const skills = (job.skills || []).map((s) => String(s).toLowerCase());
const excludeKeywords = job.excludeKeywords || [];

// ---------------------------------------------------------------- 工具函数

const DEGREE_RANK = { 博士: 5, 硕士: 4, 本科: 3, 大专: 2, 专科: 2, 中专: 1, 高中: 1, 初中: 1 };

function degreeRank(s) {
  if (!s) return null;
  for (const k of Object.keys(DEGREE_RANK)) if (String(s).includes(k)) return DEGREE_RANK[k];
  return null;
}

/** 解析薪资为月薪区间，支持 "12-18K" / "10K" / "8-12K·14薪" / "6000-8000" */
function salaryRangeMonthly(raw) {
  if (!raw) return null;
  const s = String(raw);
  const perDay = s.match(/(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*元?\s*\/?\s*天/);
  if (perDay) {
    const lo = Math.round(Number(perDay[1]) * 21.75);
    const hi = Math.round(Number(perDay[2]) * 21.75);
    return { floor: lo, ceil: hi };
  }
  const kRange = s.match(/(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)\s*[kK]/);
  if (kRange) return { floor: Math.round(Number(kRange[1]) * 1000), ceil: Math.round(Number(kRange[2]) * 1000) };
  const kSingle = s.match(/(\d+(?:\.\d+)?)\s*[kK]/);
  if (kSingle) { const v = Math.round(Number(kSingle[1]) * 1000); return { floor: v, ceil: v }; }
  const yuanRange = s.match(/(\d{3,})\s*[-~到]\s*(\d{3,})/);
  if (yuanRange) return { floor: Number(yuanRange[1]), ceil: Number(yuanRange[2]) };
  const yuanSingle = s.match(/(\d{4,})/);
  if (yuanSingle) { const v = Number(yuanSingle[1]); return { floor: v, ceil: v }; }
  return null;
}

/** 解析候选人经验年限；"应届生"/"2027届"/"在校" → 0；解析不出 → null */
function talentYears(exp) {
  if (!exp) return null;
  const t = String(exp);
  if (/应届|在校|无经验|经验不限|\d{4}\s*届/.test(t)) return 0;
  const range = t.match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*年/);
  if (range) return Number(range[1]);
  const single = t.match(/(\d+(?:\.\d+)?)\s*年/);
  if (single) return Number(single[1]);
  return null;
}

/** 解析活跃度为「大约多少天前活跃」；解析不出 → null（不据此否决） */
function activeDays(status) {
  if (!status) return null;
  const t = String(status);
  if (/在线|刚刚活跃|今日活跃|今天活跃|今日在线/.test(t)) return 0;
  const day = t.match(/(\d+)\s*日内活跃/);
  if (day) return Number(day[1]);
  const week = t.match(/(\d+)\s*周内活跃/);
  if (week) return Number(week[1]) * 7;
  const month = t.match(/(\d+)\s*个?月内活跃|(\d+)\s*个月?前活跃|(\d+)\s*月前活跃/);
  if (month) return Number(month[1] || month[2] || month[3]) * 30;
  if (/本周活跃|一周内活跃|7日内/.test(t)) return 7;
  if (/两周内活跃/.test(t)) return 14;
  if (/本月活跃/.test(t)) return 30;
  return null;
}

/** 候选人文本聚合，用于技能命中判定 */
const talentText = (t) => [t.title, t.skills, t.resume, t.experience, t.degree, t.school]
  .filter(Boolean).join('\n').toLowerCase();

// ---------------------------------------------------------------- 时间基准

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

const touchToday = touched.filter((h) => String(h.ts || '').startsWith(todayStr));
const todayPosCount = new Map();
for (const h of touchToday) {
  const k = String(h.direction || h.positionId || '').trim();
  todayPosCount.set(k, (todayPosCount.get(k) || 0) + 1);
}

const touchedKeys = new Set();
for (const h of touched) {
  if (h.id) touchedKeys.add(String(h.id));
  if (h.url) touchedKeys.add(String(h.url));
}

/** 同一候选人的冷却天数；命中返回最小天数差，否则 null */
function talentCooldownDays(t) {
  const key = String(t.id || '');
  const url = String(t.url || '');
  const prev = touched.filter((h) =>
    (key && String(h.id || '') === key) || (url && String(h.url || '') === url));
  if (!prev.length) return null;
  let minDiff = Infinity;
  for (const h of prev) {
    const d = new Date(String(h.ts || '').replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) { minDiff = 0; continue; }
    minDiff = Math.min(minDiff, Math.floor((now - d) / 86400000));
  }
  return minDiff;
}

// ---------------------------------------------------------------- 闸门判定

const scored = [];
const rejected = [];
const review = [];

for (const t of talent) {
  const hardReasons = [];
  const softReasons = [];
  const reviewReasons = [];
  const hay = talentText(t);

  // ---- G0 方向红线
  const dirText = [t.title, t.skills].filter(Boolean).join(' ').toLowerCase();
  for (const kw of excludeKeywords) {
    const k = String(kw).toLowerCase();
    if (!k) continue;
    if (dirText.includes(k)) hardReasons.push(`候选人职位/技能命中排除词「${kw}」，与岗位方向不符`);
    else if (hay.includes(k)) softReasons.push(`简历正文出现「${kw}」，需看过详情确认是否本职`);
  }

  // ---- G0 重复触达与冷却
  const key = String(t.id || t.url || '');
  if (key && touchedKeys.has(key)) {
    hardReasons.push('该候选人已在触达记录中（重复触达）');
  } else {
    const cd = talentCooldownDays(t);
    const cooldown = L.repeatTalentCooldownDays ?? 30;
    if (cd !== null && cd < cooldown) {
      hardReasons.push(`同一候选人冷却中（${cd} 天前触达过，门槛 ${cooldown} 天）`);
    }
  }

  // ---- G0 城市：异地触达是最纯粹的无效消耗
  const jc = String(job.requireCity || '').trim();
  const tc = String(t.expectCity || '').trim();
  if (jc && tc && !tc.includes(jc) && !jc.includes(tc)) {
    hardReasons.push(`期望城市「${tc}」与岗位城市「${jc}」不符——候选人不会考虑异地岗`);
  }

  // ---- G0 活跃度：僵尸号触达不会有回应，只消耗配额
  const ad = activeDays(t.activeStatus);
  const stale = L.staleTalentDays ?? 30;
  if (ad !== null && ad > stale) {
    hardReasons.push(`活跃状态「${t.activeStatus}」（约 ${ad} 天前），超出 ${stale} 天门槛——大概率无回应`);
  }

  // ---- G1 匹配度（准入用分：coreSkills×2 + skills×1）
  const matchedCore = coreSkills.filter((s) => hay.includes(s));
  const matchedNormal = skills.filter((s) => hay.includes(s));
  const score = matchedCore.length * 2 + matchedNormal.length;
  const threshold = L.matchThreshold ?? 3;

  const matchedSkills = [
    ...(job.coreSkills || []).filter((_, i) => matchedCore.includes(String(job.coreSkills[i]).toLowerCase())),
    ...(job.skills || []).filter((_, i) => matchedNormal.includes(String(job.skills[i]).toLowerCase())),
  ];

  const infoLen = (t.resume || '').length + (t.skills || '').length + (t.title || '').length;
  const lowInfo = infoLen < 60;

  if (score < threshold) {
    const msg = `技能命中分 ${score} < 门槛 ${threshold}（命中：${matchedSkills.join('/') || '无'}）`;
    if (lowInfo) reviewReasons.push(`${msg}；但候选人信息量不足（${infoLen} 字），列表卡片可能不完整——须打开详情页看清简历再定`);
    else hardReasons.push(msg);
  }

  // ---- G1b 经验区间
  const y = talentYears(t.experience);
  const minY = Number(job.minExperienceYears ?? 0);
  const maxY = Number(job.maxExperienceYears ?? 99);
  if (y !== null) {
    if (y > maxY + 2) {
      hardReasons.push(`候选人 ${y} 年经验，显著高于岗位上限 ${maxY} 年——资历溢出，薪资预期大概率谈不拢`);
    } else if (minY >= 2 && y < minY * 0.5) {
      hardReasons.push(`候选人 ${y} 年经验，远低于岗位下限 ${minY} 年`);
    } else if (y < minY) {
      softReasons.push(`候选人 ${y} 年经验，略低于岗位下限 ${minY} 年，可尝试沟通`);
    } else if (y > maxY) {
      softReasons.push(`候选人 ${y} 年经验，略高于岗位上限 ${maxY} 年，注意薪资预期`);
    }
  }

  // ---- G1b 学历
  const dr = degreeRank(t.degree);
  const need = degreeRank(job.minDegree);
  if (dr !== null && need !== null && dr < need) {
    if (need - dr >= 2) hardReasons.push(`学历「${t.degree}」低于岗位要求「${job.minDegree}」两档以上`);
    else softReasons.push(`学历「${t.degree}」低于岗位要求「${job.minDegree}」，视岗位弹性而定`);
  }

  // ---- G1b 薪资：期望高于预算上限属于必然谈崩
  const exp = salaryRangeMonthly(t.expectSalary);
  const budget = Array.isArray(job.salaryBudgetMonthly) ? job.salaryBudgetMonthly : null;
  if (exp && budget && budget.length === 2) {
    const bHi = Number(budget[1]);
    const bLo = Number(budget[0]);
    if (exp.floor > bHi) {
      hardReasons.push(`期望薪资下限 ¥${exp.floor} 高于岗位预算上限 ¥${bHi}——谈不拢，属无效触达`);
    } else if (exp.floor > bHi * 0.9) {
      softReasons.push(`期望薪资下限 ¥${exp.floor} 接近预算上限 ¥${bHi}，议价空间小`);
    } else if (exp.floor < bLo * 0.6) {
      softReasons.push(`期望薪资下限 ¥${exp.floor} 明显低于预算下限 ¥${bLo}，可能是经验或定位偏差`);
    }
  }

  // ---- 排序加分项（只影响顺序，不影响准入）
  const bonus = t.appliedToUs ? 5 : 0;

  const item = {
    id: t.id,
    name: t.name,
    title: t.title,
    experience: t.experience,
    degree: t.degree,
    school: t.school,
    expectSalary: t.expectSalary,
    expectCity: t.expectCity,
    activeStatus: t.activeStatus,
    url: t.url,
    score,
    bonus,
    rankScore: score + bonus,
    matchedSkills,
    matchedCoreCount: matchedCore.length,
    years: y,
    activeDays: ad,
  };

  if (hardReasons.length) {
    rejected.push({ ...item, verdict: 'REJECT', reasons: [...hardReasons, ...softReasons] });
  } else if (reviewReasons.length) {
    review.push({ ...item, verdict: 'REVIEW', reasons: [...reviewReasons, ...softReasons] });
  } else {
    scored.push({ ...item, verdict: 'PASS', reasons: softReasons });
  }
}

// ---------------------------------------------------------------- G2 批次闸门

// 匹配度从高到低；同分时优先「主动投递过我们」的人
scored.sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || String(a.name || '').localeCompare(String(b.name || '')));

const perPosition = new Map();
const accepted = [];
const deferred = [];
const quotaLeft = Math.max(0, (L.dailyMax ?? 12) - touchToday.length);

for (const t of scored) {
  if (accepted.length >= quotaLeft) {
    deferred.push({ ...t, verdict: 'DEFER', reasons: [`今日触达额度已用尽（已触达 ${touchToday.length} / 上限 ${L.dailyMax ?? 12}）`] });
    continue;
  }
  const posKey = String(t.direction || job.positionId || '_');
  if ((perPosition.get(posKey) || 0) >= (L.perPositionMax ?? 8)) {
    deferred.push({ ...t, verdict: 'DEFER', reasons: [`该方向/职位今日配额已满（上限 ${L.perPositionMax ?? 8}），留到下次`] });
    continue;
  }
  perPosition.set(posKey, (perPosition.get(posKey) || 0) + 1);
  accepted.push(t);
}

// ---------------------------------------------------------------- G3 时序闸门

function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }

const plan = [];
let cursor = now.getTime();
accepted.forEach((t, i) => {
  if (i > 0) {
    // 间隔带方差：定长间隔本身就是可被统计识别的特征
    const base = randInt(L.minGapSeconds ?? 60, L.maxGapSeconds ?? 240);
    const jitter = Math.round(base * (0.75 + Math.random() * 0.5));
    cursor += jitter * 1000;
  }
  const d = new Date(cursor);
  plan.push({
    order: i + 1,
    name: t.name,
    title: t.title,
    rankScore: t.rankScore,
    plannedAt: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    gapFromPrevSeconds: i === 0 ? 0 : Math.round((cursor - plan[i - 1]._ts) / 1000),
    _ts: cursor,
  });
});
for (const p of plan) delete p._ts;

// ---------------------------------------------------------------- 汇总

const warnings = [];
if (!inWindow) {
  warnings.push(`当前 ${pad(now.getHours())}:${pad(now.getMinutes())} 不在允许时段（${(job.limits?.activeWindows || JOB_TEMPLATE.limits.activeWindows).map((w) => w.join('-')).join(' / ')}）。候选人在非工作时段收到招呼，更容易记住「这人半夜发消息」。`);
}
if (accepted.length >= 8) {
  warnings.push(`本批入选 ${accepted.length} 人，接近单日上限。建议拆成两个时段，不要一次跑完。`);
}
if (review.length > accepted.length && review.length > 2) {
  warnings.push(`${review.length} 人因信息量不足待核实。列表卡片判不准匹配度——必须打开详情页读完简历再决定。`);
}
const judged = accepted.length + rejected.length;
if (judged > 0 && rejected.length > accepted.length && talent.length > 3) {
  warnings.push(`淘汰率 ${Math.round((rejected.length / judged) * 100)}%（不含待核）。这是健康信号——闸门在起作用；若长期为 0，说明阈值过松。`);
}
const staleCount = accepted.filter((t) => t.activeDays !== null && t.activeDays > 7).length;
if (staleCount > 0) {
  warnings.push(`入选中有 ${staleCount} 人活跃度已超过 7 天，回应率会明显偏低，可考虑置换。`);
}

const result = {
  generatedAt: `${todayStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  position: {
    positionId: job.positionId || null,
    positionTitle: job.positionTitle || null,
    company: job.company || null,
    city: job.requireCity || job.city || null,
    direction: job.direction || null,
  },
  batch: {
    inActiveWindow: inWindow,
    todayTouched: touchToday.length,
    dailyMax: L.dailyMax ?? 12,
    quotaLeft,
    total: talent.length,
    accepted: accepted.length,
    rejected: rejected.length,
    review: review.length,
    deferred: deferred.length,
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
  lines.push('===== 候选人筛选结果 ' + result.generatedAt + ' =====');
  lines.push(`岗位：${result.position.positionTitle || '-'}　城市：${result.position.city || '-'}`);
  lines.push(`今日已触达 ${result.batch.todayTouched}/${result.batch.dailyMax}　剩余额度 ${quotaLeft}　时段合规 ${inWindow ? '是' : '否'}`);
  lines.push(`候选 ${talent.length}　通过 ${accepted.length}　待核 ${review.length}　否决 ${rejected.length}　暂缓 ${deferred.length}`);

  if (accepted.length) {
    lines.push('\n-- 建议触达名单（按匹配度降序）--');
    for (const t of accepted) {
      const extra = t.bonus ? ` +${t.bonus}(主动投递)` : '';
      lines.push(`  ${String(t.rankScore).padStart(3)}分${extra}  ${t.name || '(未具名)'} · ${t.title || '-'}  [${t.matchedSkills.join('/') || '-'}]`);
      lines.push(`        ${t.experience || '-'} · ${t.degree || '-'}${t.school ? ' · ' + t.school : ''} · 期望 ${t.expectSalary || '-'} · ${t.activeStatus || '活跃度未知'}`);
    }
  }
  if (review.length) {
    lines.push('\n-- 待核实（信息量不足，须打开详情页读完简历再定）--');
    for (const t of review) lines.push(`  ${t.name || '(未具名)'} · ${t.title || '-'}\n        ${t.reasons.join('\n        ')}`);
  }
  if (rejected.length) {
    lines.push('\n-- 否决 --');
    for (const t of rejected) lines.push(`  ${t.name || '(未具名)'} · ${t.title || '-'}\n        ${t.reasons.join('\n        ')}`);
  }
  if (deferred.length) {
    lines.push('\n-- 暂缓 --');
    for (const t of deferred) lines.push(`  ${t.name || '(未具名)'} · ${t.title || '-'}　${t.reasons.join(' / ')}`);
  }
  if (plan.length) {
    lines.push('\n-- 触达计划（间隔已加抖动）--');
    for (const p of plan) lines.push(`  ${p.plannedAt}  (+${p.gapFromPrevSeconds}s)  ${p.name || '(未具名)'} · ${p.title || '-'}`);
  }
  if (warnings.length) {
    lines.push('\n-- 警告 --');
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n');
};

console.log(args.table ? table() : JSON.stringify(result, null, 2));

if (args.out) {
  const outPath = resolve(String(args.out));
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.error(`\n结果已写入: ${outPath}`);
  } catch (e) {
    console.error(`\n结果文件写入失败（已跳过，stdout 仍可用）: ${outPath} — ${e.message}`);
  }
}

process.exit(accepted.length > 0 ? 0 : 2);
