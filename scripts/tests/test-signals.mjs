#!/usr/bin/env node
/**
 * test-signals.mjs — decideSendSignals 的离线回归测试
 *
 * 用例全部取自 2026-10-09 那次真实实跑的日志（那一次日志声称 7 条成功、实际只发出 2 条）。
 * 目的：把"陈旧遮罩导致假成功"这一事故固化为回归用例，防止以后再犯。
 *
 * 运行： node test-signals.mjs
 * 退出码：0 全部通过 / 1 有失败
 */
import { pathToFileURL } from 'node:url';

const SKILL = process.env.SKILL_DIR || 'C:/Users/liuho/.workbuddy/skills/boss-hr-outreach-safe';
const mod = await import(pathToFileURL(`${SKILL}/scripts/greet-batch.mjs`).href);
const { decideSendSignals } = mod;

if (typeof decideSendSignals !== 'function') {
  console.error('✗ 未能从 greet-batch.mjs 导入 decideSendSignals');
  process.exit(1);
}

const A_GREET = {
  successSignals: { continueTexts: ['继续沟通', '继续聊'], modalAppearsMeansSent: true, counterDropMeansSent: true },
};
const A_NO_MODAL = {
  successSignals: { continueTexts: ['继续沟通'], modalAppearsMeansSent: false, counterDropMeansSent: true },
};

// 旧实现（修复前）的判定，用于对照
const oldOk = (s, greetsBefore, action) => {
  const cont = !!s.cont && (action.successSignals.continueTexts || ['继续沟通']).some((x) => String(s.cont).includes(x));
  const byModal = action.successSignals.modalAppearsMeansSent !== false && s.dlg > 0;
  const byCount = action.successSignals.counterDropMeansSent !== false && s.greets < greetsBefore;
  return cont || byModal || byCount;
};

const cases = [
  {
    name: 'A 真实成功（段先生 15:36:30）',
    desc: '点击生效：按钮变「继续沟通」+ 全页计数 456→455',
    input: { s: { cont: '继续沟通', btn: '继续沟通', dlg: 1, greets: 455 }, greetsBefore: 456, dlgBefore: 0, action: A_GREET },
    expect: { ok: true, via: '文案' },
  },
  {
    name: 'B ★假成功（王开印 15:38:59）',
    desc: '点击被 409 拒绝（上一轮遮罩没关）；按钮仍是「打招呼」、计数不变、但有陈旧遮罩',
    input: { s: { cont: null, btn: '打招呼', dlg: 1, greets: 455 }, greetsBefore: 455, dlgBefore: 1, action: A_GREET },
    expect: { ok: false, via: null },
  },
  {
    name: 'C 新出现的遮罩（dlgBefore=0）',
    desc: '与 B 同样的状态，但遮罩是「本轮才出现」的 → 应当采信回执弹窗信号',
    input: { s: { cont: null, btn: '打招呼', dlg: 1, greets: 455 }, greetsBefore: 455, dlgBefore: 0, action: A_GREET },
    expect: { ok: true, via: '回执弹窗' },
  },
  {
    name: 'D 真实成功（计数下降路径）',
    desc: '第二批实跑：按钮未变、有陈旧遮罩，但全页计数 238→237',
    input: { s: { cont: null, btn: '打招呼', dlg: 1, greets: 237 }, greetsBefore: 238, dlgBefore: 1, action: A_GREET },
    expect: { ok: true, via: '计数下降' },
  },
  {
    name: 'E 完全无变化',
    desc: '无文案变化、无新遮罩、计数不变 → 必须判为未确认',
    input: { s: { cont: null, btn: '打招呼', dlg: 0, greets: 455 }, greetsBefore: 455, dlgBefore: 0, action: A_GREET },
    expect: { ok: false, via: null },
  },
  {
    name: 'F 陈旧遮罩 + 模板禁用弹窗信号',
    desc: '与 B 同状态，模板设 modalAppearsMeansSent=false（上一轮我临时用的兜底模板）',
    input: { s: { cont: null, btn: '打招呼', dlg: 1, greets: 455 }, greetsBefore: 455, dlgBefore: 1, action: A_NO_MODAL },
    expect: { ok: false, via: null },
  },
  {
    name: 'G 卡片已消失但计数下降',
    desc: '追加式列表被重排后卡片暂时找不到，仍可用计数信号兜底',
    input: { s: { cont: null, btn: '(none)', dlg: 0, greets: 200, cardGone: true }, greetsBefore: 201, dlgBefore: 0, action: A_GREET },
    expect: { ok: true, via: '计数下降' },
  },
];

let pass = 0, fail = 0;
console.log('\n=== decideSendSignals 离线回归测试（用例取自 2026-10-09 真实实跑）===\n');
for (const c of cases) {
  const r = decideSendSignals(c.input);
  const okOk = r.ok === c.expect.ok;
  const okVia = r.via === c.expect.via;
  const good = okOk && okVia;
  const before = oldOk(c.input.s, c.input.greetsBefore, c.input.action);
  if (good) pass++; else fail++;
  console.log(`${good ? '✓' : '✗'} ${c.name}`);
  console.log(`    ${c.desc}`);
  console.log(`    期望 ok=${c.expect.ok} via=${c.expect.via}　实得 ok=${r.ok} via=${r.via}` +
    `　（修复前旧逻辑会判 ok=${before}${before !== r.ok ? '  ← 差异' : ''}）`);
  if (r.staleModal) console.log('    标记：检测到陈旧遮罩（staleModal=true），已排除在成功判据之外');
  console.log('');
}

console.log('─'.repeat(64));
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('关键回归点：用例 B —— 修复前旧逻辑会把它判成"成功"（正是当时 7 条里 5 条假阳性的成因），现在必须判为未确认。');
console.log('');
process.exit(fail ? 1 : 0);
