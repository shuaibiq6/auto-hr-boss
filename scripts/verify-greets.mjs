#!/usr/bin/env node
/**
 * verify-greets.mjs — 触达结果的「平台侧」独立核验
 *
 * 为什么需要它：
 *   2026-10-09 实跑中，greet-batch 的日志声称"已送达 7 人"，经「沟通」页核对实际只发出 2 人。
 *   教训是：**验收不能以脚本日志为准，必须以页面的业务状态为准**。
 *   本脚本回读每个目标的卡片按钮状态（「打招呼」→「继续沟通」），给出可信结论。
 *
 * 前提：目标页面仍停留在触达时的那次列表加载上（推荐/搜索列表一旦重载，卡片与 id 都会变，
 *       此时无法回溯核验，脚本会明确告知）。
 *
 * 用法：
 *   node scripts/verify-greets.mjs --plan p2.result.json --limit 11
 *   node scripts/verify-greets.mjs --plan greet.json --target <tid> --json
 *   node scripts/verify-greets.mjs --plan greet.json --action templates/actions/zhipin-boss-greet.json
 *
 * 退出码：0 全部已送达 / 3 存在未送达或无法核验 / 1 参数或环境错误
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalJs, pickTarget } from './human-click.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ACTION = path.join(ROOT, 'templates', 'actions', 'zhipin-boss-greet.json');

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法: node scripts/verify-greets.mjs --plan <file> [选项]

  --plan <file>     必填：名单/结果（数组或 {accepted:[...]}）
  --action <file>   动作模板，默认 ${path.relative(ROOT, DEFAULT_ACTION)}
  --limit <n>       只核验前 n 个
  --target <id>     标签页 id        --tid-file <file>  默认 ./_tid.txt
  --proxy <url>     代理地址，默认 http://127.0.0.1:3456
  --out <file>      把核验结果写入 JSON
  --json            输出 JSON

退出码：0 全部已送达 / 3 存在未送达或无法核验 / 1 参数或环境错误`);
  process.exit(0);
}

const planFile = opt('plan');
if (!planFile) { console.error('缺少 --plan <file>'); process.exit(1); }
const actionFile = opt('action', DEFAULT_ACTION);
const limit = opt('limit') ? Number(opt('limit')) : null;
const proxy = opt('proxy', process.env.CDP_PROXY_URL || 'http://127.0.0.1:3456');

let action, raw;
try {
  action = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
  raw = JSON.parse(fs.readFileSync(planFile, 'utf8'));
} catch (e) { console.error(`读取文件失败：${e.message}`); process.exit(1); }

const all = Array.isArray(raw) ? raw : (raw.accepted || []);
if (!Array.isArray(all) || !all.length) { console.error('名单为空或格式不认识（期望数组或 {accepted:[...]}）'); process.exit(1); }
const list = limit ? all.slice(0, limit) : all;

const tid = opt('target')
  || (() => { try { return fs.readFileSync(opt('tid-file', './_tid.txt'), 'utf8').trim(); } catch { return null; } })()
  || await pickTarget(proxy);

// 只回读"业务状态"，不做任何点击
const stateJs = (id) => `(()=>{try{
  const f=[...document.querySelectorAll('iframe')].find(x=>(x.src||'').includes(${JSON.stringify(action.frameMatch)}));
  if(!f||!f.contentDocument) return JSON.stringify({error:'no-frame'});
  const d=f.contentDocument;
  const inner=d.querySelector(${JSON.stringify(String(action.card.inner).replace('{id}', id))});
  if(!inner) return JSON.stringify({found:false});
  const root=inner.closest('.geek-card-small')||inner;
  const cont=root.querySelector(${JSON.stringify(action.continueBtn)});
  const greet=root.querySelector(${JSON.stringify(action.greetBtn)});
  return JSON.stringify({found:true, cont: cont?1:0, greet: greet?1:0, btn:(greet?'打招呼':'')+((cont&&greet)?' + ':'')+(cont?String(cont.innerText||'').trim():'')});
}catch(e){return JSON.stringify({error:'throw:'+e.message})}})()`;

console.log(`[verify] targetId=${tid}  动作模板 ${path.basename(actionFile)}  核验 ${list.length} 个`);

const rows = [];
for (let i = 0; i < list.length; i++) {
  const t = list[i];
  const rawState = await evalJs(proxy, tid, stateJs(t.id)).catch(() => null);
  const s = typeof rawState === 'string' ? (() => { try { return JSON.parse(rawState); } catch { return null; } })() : rawState;

  let verdict;
  if (!s || s.error) verdict = /no-frame/.test(s?.error || '') ? 'FRAME_MISSING' : 'ERROR';
  else if (!s.found) verdict = 'CARD_GONE';
  else if (s.cont) verdict = 'SENT';
  else if (s.greet) verdict = 'NOT_SENT';
  else verdict = 'UNKNOWN';

  rows.push({ id: t.id, name: t.name || '', title: t.title || '', verdict, btn: s?.btn || '' });
  const tag = { SENT: '✅ 已送达', NOT_SENT: '❌ 未送达', CARD_GONE: '？卡片已不在', FRAME_MISSING: '？目标帧缺失', UNKNOWN: '？状态未知', ERROR: '！读取失败' }[verdict];
  console.log(`  ${String(i + 1).padStart(3)}. ${String(t.name || t.id).padEnd(6)} ${tag}`);
}

const c = (v) => rows.filter((r) => r.verdict === v).length;
const summary = { total: rows.length, sent: c('SENT'), notSent: c('NOT_SENT'), cardGone: c('CARD_GONE'), missingFrame: c('FRAME_MISSING'), unknown: c('UNKNOWN'), error: c('ERROR') };

console.log('─'.repeat(60));
console.log(`核验结果：已送达 ${summary.sent} / 未送达 ${summary.notSent} / 卡片已不在 ${summary.cardGone} / 其他 ${summary.unknown + summary.error + summary.missingFrame}`);
if (summary.cardGone === rows.length && rows.length) {
  console.log('提示：所有卡片都找不到 —— 列表很可能已重载（换人），无法回溯核验。');
  console.log('      建议在触达结束后「立刻」核验，或改到「沟通」页按时间核对 [送达] 记录。');
}
if (summary.notSent) {
  console.log('⚠ 存在未送达项 —— 这些目标需要重跑（不要因为它们出现在脚本日志的 ✅ 里就以为发过了）。');
}

if (opt('out')) { try { fs.writeFileSync(opt('out'), JSON.stringify({ ts: new Date().toISOString(), target: tid, planFile, summary, rows }, null, 2), 'utf8'); console.log(`结果已写入 ${opt('out')}`); } catch (e) { console.log(`写入失败：${e.message}`); } }
if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));

process.exit(summary.sent > 0 && !summary.notSent && !summary.cardGone && !summary.missingFrame && !summary.unknown && !summary.error ? 0 : 3);
