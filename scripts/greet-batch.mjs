#!/usr/bin/env node
/**
 * 批量打招呼执行器（招聘端 · 推荐牛人）
 *
 * 这是 greet20.py（原先放在个人工作目录、无法随 skill 交付）的 Node 版移植与加固。
 * 现在整条链路都在 skill 内，换一台机器只要有 Node 22 + Edge/Chrome 就能直接跑。
 *
 * 相对旧脚本的加固点：
 *   1. **不再给元素打 data-agent-target 标记**。旧版为让选择器命中而打标记，
 *      又被"清理辅助函数"清掉 → 重试路径选择器失配 → 代理报 400 → 整批崩溃。
 *      现在选择器由 data-geekid 派生（稳定键），点击交给 /clickSafe 用坐标完成。
 *   2. **点击前先做命中测试**。全屏遮罩吞点击时不再"返回成功但业务零动作"——
 *      /clickSafe 会自动点掉中性关闭按钮并复测，仍不通过就拒绝点击（409）。
 *   3. 成败一律以**业务状态**判定（按钮文案变化 / 全页计数下降 / 回执弹窗出现），
 *      不看代理返回值。
 *   4. 页面不可见 → 自动走 /restore-window 恢复（不再直接熔断整批）。
 *   5. 限频交给 pacing.mjs：档位可控、风险自动拉长、硬边界不可越过、连败熔断。
 *
 * 用法：
 *   node scripts/greet-batch.mjs --plan screen.result.json [选项]
 *
 *   --plan <file>       必填。screen-talent.mjs 的输出（取其 accepted 数组），或候选数组
 *   --action <file>     动作模板，默认 templates/actions/zhipin-boss-greet.json
 *   --limit <n>         本批最多处理几个
 *   --skip <id,id>      跳过这些 id（通常用于续跑已完成的）
 *   --dry               只定位与校验，不点击
 *   --profile <name>    限频档位 conservative|balanced|efficient|hr150，默认 hr150
 *   --target <id>       标签页 targetId；省略则读 --tid-file 或自动选第一个 page
 *   --tid-file <file>   存放 targetId 的文件，默认 ./_tid.txt
 *   --proxy <url>       代理地址，默认 http://127.0.0.1:3456
 *   --touch <file>      已触达记录文件（配合 --commit 回写）
 *   --commit            把成功项写入 --touch 文件（不写则冷却期与去重会静默失效）
 *   --out <file>        结果 JSON 路径，默认 ./greet-batch-result.json
 *   --log <file>        日志路径，默认 ./greet-batch.log
 *   --json              结束时额外打印 JSON 摘要
 *
 * 抗中断（2026-10-13 新增，长任务建议全用）：
 *   --progress <file>   进度心跳（默认 <out>.progress.json），每条处理后刷新
 *   --done <file>       完成哨兵（默认 <out>.done.json），收尾写一次；等待方只看它
 *   --resume            读 <out> 跳过已处理项，从未完成处继续（幂等，可反复执行）
 *   --chunk <n>         本批最多 n 个就优雅退出（exit 0，哨兵里给出 remaining）
 *   --max-runtime <sec> 超时优雅停机（中断点落在安全边界，可续跑）
 *   --respect-window    离开限频档时段即优雅停机
 *   --lock <file>       单实例锁（默认 <out>.lock）；--force 抢占，--no-lock 关闭
 *   --read-retries <n>  读卡片失败重试次数，默认 3（瞬时抖动不再误判为失败）
 *
 * 退出码：0 正常/安全停机 / 1 有未确认项 / 3 闸门不允许 / 4 命中熔断（需人工干预） / 5 已有实例在跑
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nextGap, resolveProfile, gate } from './pacing.mjs';
import { evalJs, clickSafe, pickTarget } from './human-click.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ACTION = path.join(ROOT, 'templates', 'actions', 'zhipin-boss-greet.json');

// ─────────────────────────────────────────────────────── CLI 解析
function parse(argv) {
  const o = {
    plan: null, action: DEFAULT_ACTION, limit: null, skip: '', dry: false,
    profile: 'hr150', target: null, tidFile: './_tid.txt', proxy: 'http://127.0.0.1:3456',
    touch: null, commit: false, out: './greet-batch-result.json', log: './greet-batch.log',
    json: false, job: '',
    // ── 抗中断（2026-10-13 新增）
    progress: null, done: null, resume: false, chunk: null, maxRuntime: null,
    lock: null, force: false, noLock: false, respectWindow: false, readRetries: 3,
  };
  // 只有「直接执行本脚本」时才响应 --help；被 import 时（argv 属于调用方）绝不打印、绝不退出
  if (invokedDirectly && (argv.includes('--help') || argv.includes('-h'))) {
    console.log(`用法: node scripts/greet-batch.mjs --plan <file> [选项]

  --plan <file>     必填，候选名单（screen-talent 输出或数组）
  --action <file>   动作模板，默认 ${path.relative(ROOT, DEFAULT_ACTION)}
  --limit <n>       本批最多处理几个        --skip <id,id>  跳过这些 id
  --dry             只定位校验，不点击       --profile <name> conservative|balanced|efficient|hr150（默认 hr150）
  --target <id>     标签页 id               --tid-file <file>  默认 ./_tid.txt
  --touch <file>    已触达记录             --commit           成功项回写 --touch
  --out <file>      结果 JSON               --log <file>       日志
  --json            结束时打印 JSON 摘要

抗中断选项（2026-10-13 新增，长任务建议全用）：
  --progress <f>    进度心跳文件，默认 <out>.progress.json（每条刷新一次）
  --done <f>        完成哨兵文件，默认 <out>.done.json（结束时写一次；等待方只需轮询这个文件）
  --resume          读 <out> 里的历史结果，跳过已处理项，从未完成处继续（可反复执行）
  --chunk <n>       本次最多处理 n 个就优雅退出（exit 0，并在哨兵里给出 remaining）
  --max-runtime <s> 本次运行超过 s 秒就优雅停机（安全可续跑）
  --respect-window  离开限频档允许时段即优雅停机（默认关：跨午休连续跑）
  --lock <f>        单实例锁文件，默认 <out>.lock  --force 抢占  --no-lock 关闭
  --read-retries <n> 读卡片失败的重试次数，默认 3（瞬时抖动不再误判为失败）

环境变量: CDP_PROXY_URL 覆盖代理地址`);
    process.exit(0);
  }
  const val = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  o.plan = val('plan');
  o.action = val('action', DEFAULT_ACTION);
  o.limit = val('limit') ? Number(val('limit')) : null;
  o.skip = val('skip', '');
  o.dry = argv.includes('--dry');
  o.profile = val('profile', 'hr150');
  o.target = val('target');
  o.tidFile = val('tid-file', './_tid.txt');
  o.proxy = val('proxy', process.env.CDP_PROXY_URL || 'http://127.0.0.1:3456');
  o.touch = val('touch');
  o.commit = argv.includes('--commit');
  o.out = val('out', './greet-batch-result.json');
  o.log = val('log', './greet-batch.log');
  o.json = argv.includes('--json');
  o.job = val('job', '');
  // ── 抗中断选项
  o.progress = val('progress', o.out + '.progress.json');
  o.done = val('done', o.out + '.done.json');
  o.lock = val('lock', o.out + '.lock');
  o.resume = argv.includes('--resume');
  // 注意：用 !== null 判定，这样显式传 0 也能被尊重（0 = 立即停机 / 不处理任何条目）
  o.chunk = val('chunk') !== null ? Number(val('chunk')) : null;
  o.maxRuntime = val('max-runtime') !== null ? Number(val('max-runtime')) : null;
  o.force = argv.includes('--force');
  o.noLock = argv.includes('--no-lock');
  o.respectWindow = argv.includes('--respect-window');
  o.readRetries = val('read-retries') !== null ? Number(val('read-retries')) : 3;
  return o;
}

// 是否被「直接执行」（而非被 import）。必须先于 parse 判定 ——
// 否则其它脚本 import 本模块时，它自己 argv 里的 --help 会被这里误当成本脚本的参数而直接退出
// （2026-10-13 发现：`watchdog --help` 打出了 greet-batch 的帮助文本）。
// 被 import 时不产生任何副作用（离线回归测试、watchdog 复用纯函数都依赖这一点）。
const invokedDirectly = !!(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
const opts = parse(process.argv.slice(2));
if (invokedDirectly && !opts.plan) { console.error('缺少 --plan <file>'); process.exit(1); }

// ─────────────────────────────────────────────────────── 基础工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

/** 本地时间戳 `YYYY-MM-DD HH:mm`（此前写的是 UTC，日志里看着差 8 小时，已改为本地时间） */
const localStamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 本地日期 `YYYY-MM-DD`（日额度按本地日计算） */
const localDate = () => localStamp().slice(0, 10);

// ── 输出韧性（2026-10-13 修复）────────────────────────────────────────────
// 事故：批次的 stdout 是**宿主捕获的管道**。当读取端消失（回合结束 / 后台任务被摘除 / 管道关闭）时，
// 下一次 console.log 会触发 EPIPE；Node 默认把**未处理的流错误升级成未捕获异常并终止进程** ——
// 正在正常发送的批次会「凭空消失」：日志突然停在某一条、心跳里只有 aborted:true 而没有原因。
// 2026-10-13 那次 25 人批次停在 7/25（心跳 stopReason:null、graceful:false、aborted:true）
// 与这个特征完全吻合：走到了优雅退出路径，却不是脚本自己停的。
//
// 因此两条一起上：
//   ① 先落盘、再打印（日志文件永远是真相来源，与控制台是否可写无关）
//   ② stdout/stderr 的 error 一律吞掉并标记降级，绝不让它把进程带走
let outputBroken = false;
const safeWrite = (fn) => {
  if (outputBroken) return;
  try { fn(); } catch { outputBroken = true; }
};
try {
  process.stdout.on('error', (e) => {
    const c = e && e.code;
    if (c === 'EPIPE' || c === 'ERR_STREAM_DESTROYED' || c === 'ERR_STREAM_WRITE_AFTER_END') {
      if (!outputBroken) { outputBroken = true; try { fs.appendFileSync(opts.log, `[${stamp()}] ⚠ stdout 管道已断开（${c}）—— 后续只写日志文件，进程继续运行\n`); } catch { /* ignore */ } }
    }
  });
  process.stderr.on('error', () => { /* 同上：stderr 也不能把进程带走 */ });
} catch { /* ignore */ }

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { fs.appendFileSync(opts.log, line + '\n'); } catch { /* ignore */ }
  safeWrite(() => console.log(line));
}

async function rawJson(pathname, init = {}, timeoutMs = 30000) {
  const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.NO_PROXY = '*'; process.env.no_proxy = '*';
  try {
    const res = await fetch(opts.proxy + pathname, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  } catch (e) {
    return { status: 0, body: { error: String(e.message).slice(0, 160) } };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ─────────────────────────────────────────────────────── 页面侧 JS 生成
const frameExpr = (action) =>
  `[...document.querySelectorAll('iframe')].find(x=>(x.src||'').includes(${JSON.stringify(action.frameMatch)}))`;

function jsRisk(action) {
  const r = action.riskProbe || {};
  return `(()=>{try{
  const f=${frameExpr(action)};
  const doc=f&&f.contentDocument;
  const txt=doc?(doc.body.innerText||''):'';
  const hits=(arr)=>arr.some(t=>txt.includes(t));
  return JSON.stringify({
    vis:document.visibilityState,
    captcha:[...document.querySelectorAll(${JSON.stringify(r.captchaSelectors || '[class*=captcha]')})].filter(e=>e.offsetParent!==null).length,
    quiz:hits(${JSON.stringify(r.quizTexts || [])}),
    freq:hits(${JSON.stringify(r.freqTexts || [])}),
    loginWall:location.href.includes(${JSON.stringify(r.loginWallUrlPart || '/web/user/')})||hits(${JSON.stringify(r.loginWallTexts || [])}),
    url:location.href
  });
  }catch(e){return JSON.stringify({error:'throw:'+e.message})}})()`;
}

function jsCardState(action, gid) {
  const inner = action.card.inner.replace('{id}', gid);
  const root = (action.card.root || action.card.inner).replace('{id}', gid);
  return `(()=>{try{
  const f=${frameExpr(action)};
  if(!f||!f.contentDocument) return JSON.stringify({error:'no-frame'});
  const d=f.contentDocument;
  const dlg=[...d.querySelectorAll(${JSON.stringify(action.modal.container)})].filter(e=>getComputedStyle(e).display!=='none'&&e.offsetWidth>200);
  const innerEl=d.querySelector(${JSON.stringify(inner)});
  const rootEl=d.querySelector(${JSON.stringify(root)});
  const b=rootEl?rootEl.querySelector(${JSON.stringify(action.greetBtn)}):null;
  const c=rootEl?rootEl.querySelector(${JSON.stringify(action.continueBtn)}):null;
  return JSON.stringify({
    dlg:dlg.length,
    innerFound:!!innerEl,
    rootFound:!!rootEl,
    btnFound:!!b,
    cardGone:!innerEl,
    btn:b?(b.innerText||'').trim():'(none)',
    cont:c?(c.innerText||'').trim():null,
    greets:d.querySelectorAll(${JSON.stringify(action.counters.greet)}).length,
    cards:d.querySelectorAll(${JSON.stringify(action.counters.card)}).length
  });
  }catch(e){return JSON.stringify({error:'throw:'+e.message})}})()`;
}

// ─────────────────────────────────────────────────────── 成功判据（纯函数，可离线回归测试）
/**
 * 判定一次点击是否真的"发出去了"。
 *
 * 2026-10-10 修复（本项目最严重的一次事故）：
 *   原实现只判断「当前有可见遮罩 (s.dlg > 0)」就算成功。但 BOSS 的回执遮罩在本项目里
 *   曾经**一直没被关闭**，于是从第 2 轮开始，每轮点击虽然被 409 拒绝、业务零动作，
 *   却因为"能看到遮罩"而被判定成功 —— 2026-10-09 实跑中日志声称 7 条成功，实际只发出 2 条，
 *   且「连续失败熔断」完全没触发（连续失败数恒为 0）。
 *
 * 现在要求：**遮罩必须是本轮新出现的**（点击前 dlgBefore 为 0）才采信该信号；
 * 否则该轮只能靠「按钮文案变化」或「全页计数下降」这两个确定性业务信号判定。
 */
export function decideSendSignals({ s, greetsBefore, dlgBefore = 0, action }) {
  const ss = (action && action.successSignals) || {};
  const contTexts = ss.continueTexts || ['继续沟通'];

  const sentByCont = !!s.cont && contTexts.some((x) => String(s.cont).includes(x));
  const modalIsNew = !(Number(dlgBefore) > 0);
  const sentByModal = ss.modalAppearsMeansSent !== false && Number(s.dlg) > 0 && modalIsNew;
  const sentByCount = ss.counterDropMeansSent !== false
    && typeof s.greets === 'number' && typeof greetsBefore === 'number' && s.greets < greetsBefore;

  // 优先级：确定性最高的业务信号在前
  const via = sentByCont ? '文案' : sentByCount ? '计数下降' : sentByModal ? '回执弹窗' : null;
  return {
    ok: sentByCont || sentByCount || sentByModal,
    via, sentByCont, sentByCount, sentByModal,
    staleModal: Number(s.dlg) > 0 && !modalIsNew,
  };
}

/** 页面是否仍停留在目标页（目标 iframe 是否存在）——「页面偏离」看门狗用 */
const jsPageState = (action) => `(()=>{try{
  const f=${frameExpr(action)};
  return JSON.stringify({url:location.href, hasFrame: !!(f&&f.contentDocument)});
}catch(e){return JSON.stringify({error:'throw:'+e.message})}})()`;

// ─────────────────────────────────────────────────────── 抗中断基础设施（2026-10-13 新增）
// 背景：一次 47 人批次要跑约 2 小时。期间任何中断（外部进程被杀、会话掉线、宿主任务超时、
// 上层 Agent 的回合被切断）都会让「整批重来」。下面的设施把中断的代价降到「发一条续跑命令」：
//   1) 进度心跳：每个目标处理后立即落盘，任何时刻都能读到真实进度与剩余量
//   2) 完成哨兵：只在收尾写一次，等待方轮询它即可，不必解读日志、也不必反复扫日志
//   3) --resume：按结果文件跳过已处理项 —— 天然幂等，可无限次续跑
//   4) --chunk / --max-runtime：把一次运行压成有界片段，中断点永远落在安全边界上
//   5) 单实例锁：防止同一份名单被两个进程同时点，避免重复触达

/** 视为「已经处理过、续跑时无需再动」的终态（failed / unverified 会保留以便重试） */
const DONE_STATUSES = new Set(['succeeded', 'dry-ok', 'skipped-already', 'skipped-nobutton', 'skipped-prior']);

/** 从历史结果里取出「已处理」的 id 集合（供 --resume 跳过） */
export function resumeDoneSet(prevResults) {
  const s = new Set();
  if (!Array.isArray(prevResults)) return s;
  for (const r of prevResults) {
    if (!r || r.id === undefined || r.id === null) continue;
    if (DONE_STATUSES.has(String(r.status))) s.add(String(r.id));
  }
  return s;
}

/**
 * 把一组裸 id 变成集合。
 *
 * 2026-10-13 新增 —— 起因是一次真实事故：进程被宿主回收时**结果文件还没写出来**
 * （结果文件是收尾才落盘的），于是"只依赖结果文件"的 --resume 会以为一条都没做过。
 * 因此已办集合必须**多源合成**：结果文件 ∪ 进度心跳的 doneIds ∪ 触达记录 ∪ 显式 --skip。
 */
export function idsToSet(ids) {
  const s = new Set();
  if (!Array.isArray(ids)) return s;
  for (const i of ids) if (i !== undefined && i !== null) s.add(String(i));
  return s;
}

/** 从触达记录里还原「已经打过招呼」的人（跨天累积，绝不重复触达） */
export function touchDoneSet(records) {
  const s = new Set();
  if (!Array.isArray(records)) return s;
  for (const r of records) if (r && r.id !== undefined && r.id !== null) s.add(String(r.id));
  return s;
}

/** 按 id 合并两批结果：新结果覆盖同 id 的旧结果，其余保留（旧在前、新追加） */
export function mergeResults(prev, cur) {
  const map = new Map();
  const order = [];
  const add = (r) => {
    if (!r || r.id === undefined || r.id === null) return;
    const k = String(r.id);
    if (!map.has(k)) order.push(k);
    map.set(k, r);
  };
  if (Array.isArray(prev)) prev.forEach(add);
  if (Array.isArray(cur)) cur.forEach(add);
  return order.map((k) => map.get(k));
}

/**
 * 从完整名单算出「本次运行要处理的那一段」，并给出剩余量。
 * 顺序很关键：先按 --limit 截断（保持"计划总量"语义稳定，续跑多少次都不会超出），
 * 再用 --resume 过滤掉已完成项，最后按 --chunk 切出本段。
 */
export function planWindow(all, { limit = null, doneIds = null, chunk = null } = {}) {
  let pool = all.slice(0, limit == null ? all.length : Math.max(0, limit));
  if (doneIds && doneIds.size) pool = pool.filter((t) => !doneIds.has(String(t.id)));
  const poolSize = pool.length;
  const list = chunk == null ? pool.slice() : pool.slice(0, Math.max(0, chunk));
  return { list, poolSize, remaining: poolSize - list.length };
}

/** 进度快照（纯函数，便于离线回归） */
export function buildProgressSnapshot(s = {}) {
  return {
    v: 1,
    ...s,                       // 保留调用方附加的字段（如 allOk / succeeded），使快照可反复往返
    pid: s.pid ?? null,
    startedAt: s.startedAt ?? null,
    updatedAt: new Date().toISOString(),
    dry: !!s.dry,
    plan: s.plan ?? null,
    profile: s.profile ?? null,
    log: s.log ?? null,
    out: s.out ?? null,
    total: s.total ?? 0,
    done: s.done ?? 0,
    ok: s.ok ?? 0,
    failed: s.failed ?? 0,
    skipped: s.skipped ?? 0,
    remaining: s.remaining ?? 0,
    current: s.current ?? null,
    stopReason: s.stopReason ?? null,
    graceful: !!s.graceful,
    finished: !!s.finished,
    aborted: !!s.aborted,
  };
}

/** 进程是否存活（用于判定锁文件是不是「僵尸锁」） */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

const hhmmToSec = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 3600 + m * 60; };

/**
 * 某个时刻是否落在档位允许时段内（**秒精度**，含边界）。
 *
 * 为什么要单独有它：`--respect-window` 不能只判断"现在是否在时段内" ——
 * 还要判断"等完这次 GAP 之后是否仍在时段内"。否则会出现
 * 「11:49 通过检查 → 睡 170s → 11:52 才真正发出去」这种越窗（2026-10-13 发现）。
 */
export function inWindowAt(profile, d) {
  const windows = (profile && profile.activeWindows) || [];
  if (!windows.length) return true;
  const sec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  return windows.some(([a, b]) => sec >= hhmmToSec(a) && sec <= hhmmToSec(b));
}

// ─────────────────────────────────────────────────────── 主流程
async function main() {
  const action = JSON.parse(fs.readFileSync(opts.action, 'utf8'));
  const T_START = Date.now();
  const planRaw = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  const all = Array.isArray(planRaw) ? planRaw : (planRaw.accepted || []);
  if (!Array.isArray(all) || !all.length) { console.error('名单为空或格式不认识（期望数组或 {accepted:[...]}）'); process.exit(1); }

  // ── 抗中断：单实例锁。同一份 --out 被两个进程同时点 = 重复触达，必须挡住。
  let lockHeld = false;
  const releaseLock = () => {
    if (!lockHeld) return;
    lockHeld = false;
    try {
      const cur = JSON.parse(fs.readFileSync(opts.lock, 'utf8'));
      if (cur && Number(cur.pid) === process.pid) fs.unlinkSync(opts.lock);
    } catch { /* 沙箱可能拦截删除；残留锁会因 pid 已死而被后续运行忽略 */ }
  };
  if (!opts.noLock && opts.lock) {
    let blockedBy = null;
    try {
      const prev = JSON.parse(fs.readFileSync(opts.lock, 'utf8'));
      if (prev && prev.pid && Number(prev.pid) !== process.pid && pidAlive(prev.pid)) blockedBy = prev.pid;
    } catch { /* 无锁或内容损坏 → 直接获取 */ }
    if (blockedBy && !opts.force) {
      console.error(`⛔ 同一批次已有实例在运行（锁 ${opts.lock}，PID ${blockedBy}）。`);
      console.error('   确认对方已停止后加 --force 抢占；或换一个 --out 避免互相干扰。');
      process.exit(5);
    }
    if (blockedBy) console.error(`⚠ 单实例锁被 PID ${blockedBy} 持有，--force 抢占。`);
    try {
      fs.writeFileSync(opts.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), plan: opts.plan, out: opts.out }, null, 2), 'utf8');
      lockHeld = true;
    } catch { /* 锁写不进去也不阻塞主流程 */ }
  }

  // ── 抗中断：载入历史状态。已办集合必须**多源合成** ——
  // 结果文件是收尾才写的；进程被宿主回收时它可能压根不存在（2026-10-13 真实事故），
  // 而进度心跳里的 doneIds 与触达记录都是**逐条落盘**的，才是可靠的续跑依据。
  const readJsonArr = (f) => {
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
  };
  const prevResults = readJsonArr(opts.out);
  const prevProgress = (() => {
    try { const j = JSON.parse(fs.readFileSync(opts.progress, 'utf8')); return (j && typeof j === 'object') ? j : {}; } catch { return {}; }
  })();
  const prevTouch = opts.touch ? readJsonArr(opts.touch) : [];
  const doneSet = opts.resume
    ? new Set([
        ...resumeDoneSet(prevResults),
        ...idsToSet(prevProgress.doneIds),
        ...touchDoneSet(prevTouch),
      ])
    : new Set();

  const skipIds = new Set(String(opts.skip || '').split(',').map((s) => s.trim()).filter(Boolean));

  // 限频档位
  let profile;
  try { profile = resolveProfile(opts.profile); }
  catch (e) { console.error(e.message); process.exit(1); }

  // ── 抗中断：算出本批要处理的那一段，以及剩余量
  const { list, poolSize, remaining } = planWindow(all, { limit: opts.limit, doneIds: doneSet, chunk: opts.chunk });

  // ── 计划视角的进度（2026-10-13 修正）─────────────────────────────────
  // 心跳里的 total/done/remaining 必须相对**整个计划窗口**，而不是相对"本块"。
  // 否则续跑时 status.mjs 会显示「进度 8/8」——而事实是 48 人里的第 48 个（实测到的误导）。
  // 注意：scopeTotal - doneBefore 恒等于 planWindow 的 poolSize，所以不改变既有判定语义。
  const scope = all.slice(0, opts.limit == null ? all.length : Math.max(0, opts.limit));
  const scopeTotal = scope.length;
  const doneBefore = scope.filter((t) => t && doneSet.has(String(t.id))).length;
  const planView = (n) => ({ done: doneBefore + n, total: scopeTotal, remaining: Math.max(0, scopeTotal - doneBefore - n) });

  const tid = opts.target || (() => { try { return fs.readFileSync(opts.tidFile, 'utf8').trim(); } catch { return null; } })()
    || await pickTarget(opts.proxy);

  log('═'.repeat(70));
  log(`批量打招呼 · 本批 ${list.length} 人${opts.dry ? ' · [DRY 只定位不点击]' : ''} · 限频档 ${profile.label}(${profile.key})`);
  log(`标签页 ${tid}　动作模板 ${path.basename(opts.action)}`);
  if (doneSet.size) log(`--resume：跳过已完成 ${doneSet.size} 人（来源：结果文件 + 进度心跳 doneIds + 触达记录）`);
  if (remaining > 0) log(`--chunk：本批处理后仍余 ${remaining} 人（续跑再加 --resume）`);
  if (skipIds.size) log(`显式跳过 ${skipIds.size} 人`);
  log(`进度心跳 ${opts.progress}　完成哨兵 ${opts.done}`);

  // ── 进度心跳 / 完成哨兵：任何时刻都反映真实状态
  let progressState = null;
  let finishedNormally = false;
  let resultsRef = null;   // 指向 results，用于把「已办 id」逐条写进心跳（续跑的关键依据）
  const writeProgress = (patch = {}) => {
    progressState = buildProgressSnapshot({
      ...(progressState || {}),
      doneIds: resultsRef ? resultsRef.filter((r) => DONE_STATUSES.has(String(r.status))).map((r) => String(r.id)) : [],
      ...patch,
    });
    try { fs.writeFileSync(opts.progress, JSON.stringify(progressState, null, 2), 'utf8'); } catch { /* ignore */ }
  };
  const writeDone = (extra = {}) => {
    const payload = { ...buildProgressSnapshot({ ...(progressState || {}), finished: true, ...extra }), finishedAt: new Date().toISOString() };
    try { fs.writeFileSync(opts.done, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* ignore */ }
  };
  // 异常退出（被杀 / 未捕获异常）也要留下真实痕迹，不能留下"看起来还在跑"的假象
  let abortReason = null;
  process.on('exit', () => {
    if (!finishedNormally) { try { writeProgress({ aborted: true, abortReason: abortReason || 'unknown-exit' }); } catch { /* ignore */ } }
    releaseLock();
  });

  // ── 终止原因可观测（2026-10-13 修复）──────────────────────────────────────
  // 复盘那次中断时发现：心跳只有 `aborted:true`，**没有任何原因**，导致无法区分
  // 「脚本自己停」/「被外部杀掉」/「未捕获异常」。现在为每个可能的终止源都留明确痕迹，
  // 让 watchdog / status 能据此判断「该不该续跑」。
  const noteAbort = (reason) => {
    abortReason = reason;
    try { writeProgress({ aborted: true, abortReason: reason }); } catch { /* ignore */ }
    try { fs.appendFileSync(opts.log, `[${stamp()}] ⛔ 终止原因：${reason}\n`); } catch { /* ignore */ }
  };

  // 信号：捕获后**先记录断点再退出**（exit 0 = 未跑完但可续跑，守护进程会据此重启）。
  // 注意这会改变 Ctrl-C 的行为：不再瞬间消失，而是优雅停机并可续跑 —— 这是刻意的。
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, () => {
        log(`⚠ 收到外部终止信号 ${sig} —— 记录断点后退出（原样重跑本命令即可续跑）`);
        noteAbort(`signal:${sig}`);
        releaseLock();
        process.exit(0);
      });
    } catch { /* 个别平台不支持某些信号 */ }
  }
  // 未捕获异常 / 未处理拒绝：以前会直接消失；现在记原因后退出，交给守护进程续跑
  process.on('uncaughtException', (e) => {
    noteAbort(`uncaughtException:${String((e && e.message) || e).slice(0, 120)}`);
    releaseLock();
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    noteAbort(`unhandledRejection:${String((e && e.message) || e).slice(0, 120)}`);
    releaseLock();
    process.exit(1);
  });

  // 日额度闸门
  let todayTouchedBase = 0;
  if (opts.touch && fs.existsSync(opts.touch)) {
    try {
      const t = JSON.parse(fs.readFileSync(opts.touch, 'utf8'));
      const today = localDate();
      todayTouchedBase = t.filter((x) => String(x.ts || '').startsWith(today)).length;
    } catch { /* ignore */ }
  }
  const g = gate(profile, { todayTouched: todayTouchedBase });
  log(`额度闸门：今日 ${g.todayTouched}/${g.dailyMax}　剩余 ${g.quotaLeft}　时段 ${g.inWindow ? '合规' : '不合规'}`);
  if (!g.allowed) {
    log(`⛔ 闸门不允许执行：${g.reasons.join('；')}`);
    writeProgress({ ...planView(0), current: null, stopReason: `闸门不允许：${g.reasons.join('；')}`, finished: true });
    writeDone({ allOk: false, stopReason: `闸门不允许：${g.reasons.join('；')}` });
    finishedNormally = true;
    if (!opts.dry) process.exit(3);
  }

  // 抗中断：首帧进度落盘
  writeProgress({
    pid: process.pid, startedAt: new Date().toISOString(), dry: !!opts.dry, plan: opts.plan,
    profile: profile.key, log: opts.log, out: opts.out,
    ...planView(0), ok: 0, failed: 0, skipped: 0, current: null,
    stopReason: null, graceful: false, finished: false, aborted: false, abortReason: null,
  });

  // ── 触达记录：逐条增量回写（2026-10-10 优化）
  // 原实现只在整批结束后一次性写盘；一旦中途熔断/异常退出，已发出的记录会全部丢失，
  // 后续的「重复触达拦截」与「冷却期」就失去依据。现在改为每成功一条立即写盘。
  let touchArr = [];
  const touchHave = new Set();
  if (opts.commit && opts.touch) {
    try { touchArr = JSON.parse(fs.readFileSync(opts.touch, 'utf8')); } catch { touchArr = []; }
    if (!Array.isArray(touchArr)) touchArr = [];
    for (const x of touchArr) if (x && x.id) touchHave.add(String(x.id));
    log(`触达记录：已载入历史 ${touchArr.length} 条（增量回写已启用）`);
  }
  const commitOne = (rec) => {
    if (!opts.commit || !opts.touch || !rec || !rec.id) return false;
    if (touchHave.has(String(rec.id))) return false;
    touchHave.add(String(rec.id));
    touchArr.push({
      id: rec.id, name: rec.name || '', title: rec.title || '',
      ts: localStamp(),
      status: 'sent', via: 'recommend', job: opts.job || '',
    });
    try { fs.writeFileSync(opts.touch, JSON.stringify(touchArr, null, 2), 'utf8'); return true; }
    catch (e) { log(`  ⚠ 触达记录写入失败：${e.message}`); return false; }
  };

  // ── 读卡片状态（带退避重试）：代理/页面的瞬时抖动不再被误判成"业务失败"进而触发连败熔断
  const readCardState = async (id) => {
    const tries = Math.max(1, Number(opts.readRetries) || 1);
    let last = null;
    for (let k = 1; k <= tries; k++) {
      const raw = await evalJs(opts.proxy, tid, jsCardState(action, id)).catch(() => null);
      const s = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
      if (s && !s.error) return s;
      last = s;
      if (k < tries) { log(`  · 读卡片无响应（${(s && s.error) || 'null'}），重试 ${k}/${tries - 1}…`); await sleep(900 * k); }
    }
    return last;
  };

  const results = [];
  resultsRef = results;       // 心跳里的 doneIds 由此派生
  let doneCount = 0;          // 真正执行过的（用于限频序号）
  let processed = 0;          // 本批已过手的条目数（含跳过）
  let lastRisk = false;       // 上一轮是否命中风险信号
  let consecutiveFail = 0;    // 连续失败计数
  let cardGoneCount = 0;      // 「卡片已不在」的计数（用于判断模板是否失效）
  let stopReason = null;
  let graceful = false;       // true = 安全停机（可续跑）；false = 熔断（需人工干预）

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const idx = i + 1;

    // ── 抗中断：有界运行（--max-runtime / --respect-window）。
    // 必须放在限频等待之前 —— 否则会先睡 170s 才发现"本该停机"。
    if (opts.maxRuntime != null && (Date.now() - T_START) / 1000 > opts.maxRuntime) {
      graceful = true;
      stopReason = `STOP:达到 --max-runtime ${opts.maxRuntime}s 上限，安全停机（可 --resume 续跑）`;
      log(`⏸ ${stopReason}`); break;
    }
    if (!opts.dry && opts.respectWindow && doneCount > 0) {
      // 关键：不能只看"现在是否在时段内"，还要看"等完这次 GAP 之后是否仍在时段内"，
      // 否则会出现「11:49 通过检查 → 睡 170s → 11:52 才发出去」的越窗。
      const gapProbe = nextGap(profile, { index: doneCount, risk: lastRisk });
      const eta = new Date(Date.now() + gapProbe.seconds * 1000);
      if (!inWindowAt(profile, eta)) {
        graceful = true;
        stopReason = `STOP:下一次投递将落在允许时段之外（预计 ${pad(eta.getHours())}:${pad(eta.getMinutes())}），安全停机（可 --resume 续跑）`;
        log(`⏸ ${stopReason}`); break;
      }
    }

    if (skipIds.has(t.id)) {
      log(`[${idx}/${list.length}] ↷ ${t.name || t.id} 在跳过列表，忽略`);
      results.push({ ...t, status: 'skipped-prior' });
      processed = idx;
      writeProgress({ ...planView(idx), current: null, ok: results.filter((r) => r.status === 'succeeded').length });
      continue;
    }

    // ── 页面偏离看门狗（2026-10-10 新增）
    // 2026-10-09 实跑时，一次误点把页面导航到了 /web/chat/index，推荐 iframe 消失，
    // 而脚本仍继续"点"了几分钟才停。这里每轮先确认目标帧还在，不在就立刻熔断，
    // 避免在错误的页面上盲点、也避免把后续轮次误判成失败去拉长间隔。
    if (!opts.dry) {
      const pgRaw = await evalJs(opts.proxy, tid, jsPageState(action)).catch(() => null);
      const pg = typeof pgRaw === 'string' ? (() => { try { return JSON.parse(pgRaw); } catch { return null; } })() : pgRaw;
      if (pg && !pg.error && pg.hasFrame === false) {
        stopReason = `STOP:页面已偏离目标页（未找到 "${action.frameMatch}" 帧，当前 ${pg.url}）——请重新点站内导航回到目标页，不要用 /navigate 硬跳路由`;
        log(`⛔ ${stopReason}`);
        break;
      }
    }

    // 抗中断：标记"正在处理谁"（等待期间也能看出卡在哪一个人身上）
    writeProgress({ current: { id: t.id, name: t.name || '', idx: doneBefore + idx, idxInChunk: idx, at: new Date().toISOString() } });

    // ── 限频等待（首次不等待）
    if (!opts.dry && doneCount > 0) {
      const gap = nextGap(profile, { index: doneCount, risk: lastRisk });
      log(`[${idx}/${list.length}] 限频等待 ${gap.seconds}s（${gap.reason}）`);
      await sleep(gap.seconds * 1000);
    }
    lastRisk = false;   // 每轮重置，由本轮信号决定

    // ── 风险闸门
    if (!opts.dry) {
      const risk = await evalJs(opts.proxy, tid, jsRisk(action)).catch(() => null);
      const r = typeof risk === 'string' ? (() => { try { return JSON.parse(risk); } catch { return null; } })() : risk;
      if (r) {
        if (r.quiz) { stopReason = 'STOP:页面要求答题（平台已判定违规后的处置动作）'; break; }
        if (r.freq) { stopReason = 'STOP:出现「操作过于频繁／次数已用完」'; break; }
        if (r.captcha) { stopReason = 'STOP:出现验证码'; break; }
        if (r.loginWall) { stopReason = 'STOP:登录失效'; break; }
        if (r.vis !== 'visible') {
          log('  ⚠ 页面不可见（窗口可能被最小化），尝试自动恢复…');
          const rw = await rawJson(`/restore-window?target=${encodeURIComponent(tid)}&all=1`, {}, 20000);
          log(`  restore-window → ${JSON.stringify(rw.body).slice(0, 180)}`);
          await sleep(1500);
          const again = await evalJs(opts.proxy, tid, jsRisk(action)).catch(() => null);
          const r2 = typeof again === 'string' ? (() => { try { return JSON.parse(again); } catch { return null; } })() : again;
          if (r2?.vis === 'visible') log('  ✓ 窗口已恢复可见，继续');
          else { stopReason = `STOP:页面不可见（自动恢复失败：${r?.vis}）`; break; }
        }
      }
    }

    // ── 读取卡片状态（带退避重试，见 readCardState）
    const s0 = await readCardState(t.id);

    if (!s0 || s0.error) {
      log(`[${idx}/${list.length}] ✗ ${t.name || t.id} 读取卡片失败：${JSON.stringify(s0).slice(0, 160)}`);
      results.push({ ...t, status: 'failed', note: `读取卡片失败 ${s0?.error || ''}` });
      consecutiveFail += 1;
      processed = idx;
      writeProgress({ ...planView(idx), current: null, failed: results.filter((r) => ['failed', 'unverified'].includes(r.status)).length });
      if (consecutiveFail >= 2) { stopReason = 'STOP:连续 2 次失败，熔断以免扩大异常'; break; }
      doneCount += 1;
      continue;
    }

    const contTexts = action.successSignals?.continueTexts || ['继续沟通'];
    if (s0.cardGone || (s0.cont && contTexts.some((x) => s0.cont.includes(x)))) {
      cardGoneCount += 1;
      log(`[${idx}/${list.length}] ↷ ${t.name || t.id} 已是「${s0.cont || '继续沟通'}」或卡片已不在，跳过`);
      results.push({ ...t, status: 'skipped-already' });
      processed = idx;
      writeProgress({ ...planView(idx), current: null, skipped: results.filter((r) => String(r.status).startsWith('skipped')).length });
      continue;
    }

    // 模板自检：卡片在、但点击定位根找不到 → 选择器模板过时。
    // 这一条至关重要：不检查的话会静默跳过，重演「每轮都成功、实际零动作」。
    if (s0.innerFound && !s0.rootFound) {
      log(`[${idx}/${list.length}] ⛔ ${t.name || t.id} 卡片存在但点击定位失败 —— 动作模板的选择器可能已过时`);
      results.push({ ...t, status: 'failed', note: 'root 选择器未命中，模板可能过时' });
      consecutiveFail += 1;
      processed = idx;
      writeProgress({ ...planView(idx), current: null, failed: results.filter((r) => ['failed', 'unverified'].includes(r.status)).length });
      if (consecutiveFail >= 2) { stopReason = 'STOP:连续 2 次定位失败（疑似动作模板过时），熔断'; break; }
      doneCount += 1;
      continue;
    }

    if (!s0.btnFound || s0.btn === '(none)') {
      log(`[${idx}/${list.length}] ↷ ${t.name || t.id} 该卡片无打招呼按钮，跳过（可能已过期/不匹配）`);
      results.push({ ...t, status: 'skipped-nobutton' });
      processed = idx;
      writeProgress({ ...planView(idx), current: null, skipped: results.filter((r) => String(r.status).startsWith('skipped')).length });
      continue;
    }

    const rootSel = (action.card.root || action.card.inner).replace('{id}', t.id);
    const greetSel = `frame:${action.frameMatch} ||| ${rootSel} ${action.greetBtn}`;
    const boxSel = `frame:${action.frameMatch} ||| ${rootSel}`;

    // dry 模式额外做一次「点击选择器能否命中」的静态校验 —— 它才是真正决定点击落点的选择器
    if (opts.dry) {
      const hitRaw = await evalJs(opts.proxy, tid, `(()=>{const f=${frameExpr(action)};const d=f&&f.contentDocument;if(!d)return 'no-frame';return String(d.querySelectorAll(${JSON.stringify(greetSel.split('|||')[1].trim())}).length)})()`).catch(() => 'err');
      const hitN = String(typeof hitRaw === 'object' ? hitRaw?.value : hitRaw).trim();
      const okHit = hitN === '1';
      log(`[${idx}/${list.length}] ${okHit ? '✔' : '✗'} ${t.name || t.id} · ${t.title || ''}｜按钮「${s0.btn}」｜点击选择器命中 ${hitN} 个｜全页按钮数 ${s0.greets}`);
      results.push({ ...t, status: okHit ? 'dry-ok' : 'failed', btnText: s0.btn, clickSelHits: hitN });
      if (!okHit) consecutiveFail += 1;
      doneCount += 1;
      processed = idx;
      writeProgress({ ...planView(idx), current: null, ok: results.filter((r) => r.status === 'dry-ok').length });
      continue;
    }

    // ── 陈旧遮罩预警（2026-10-10 新增）：上一轮成功后若遮罩没被关掉，这里会看到 dlg > 0。
    // 不需要脚本自己点 —— /clickSafe 在真正点击前会自动关掉它（见 SKILL.md §4.1.2）；
    // 这里只做日志留痕，让"遮罩是否被正确清理"在日志里可见、可审计。
    if (!opts.dry && Number(s0.dlg) > 0) {
      log(`  ⚠ 卡片前存在未关闭的回执遮罩（dlg=${s0.dlg}）—— 将由 /clickSafe 在点击前自动关闭`);
    }

    // ── hover 到卡片（拟人 + 触发可能的 hover 显现）
    if (action.preClick?.hoverCard !== false) {
      await rawJson(`/mouseMove?target=${encodeURIComponent(tid)}&steps=8&selector=${encodeURIComponent(boxSel)}`, {}, 20000).catch(() => {});
      const pause = action.preClick?.hoverPauseMs || [700, 1800];
      await sleep(rand(pause[0], pause[1]));
    }

    // ── 点击 + 业务校验（最多两次；重试是完整重跑，不依赖任何标记）
    let ok = false; let lastState = null; let usedSafe = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const greetsBefore = s0.greets;
      // 关键：记录点击前的遮罩数，用于区分「本轮新出现的遮罩」与「上一轮遗留的遮罩」
      const dlgBefore = Number(s0.dlg) || 0;
      const click = await clickSafe({ proxy: opts.proxy, target: tid, selector: greetSel });
      if (!click.ok) {
        usedSafe = true;
        log(`  ✗ 第${attempt}次点击未执行（HTTP ${click.status}）：${click.body?.blocked ? '被遮挡且未能解除' : click.body?.invisible ? '元素不可见' : click.body?.error || ''}`);
        if (click.body?.notes?.length) click.body.notes.forEach((n) => log(`     · ${n}`));
      } else if (click.body?.notes?.length) {
        click.body.notes.forEach((n) => log(`     · ${n}`));
      }

      // 轮询业务状态
      const waitS = attempt === 1 ? (action.verify.pollSeconds || 15) : (action.verify.pollSecondsRetry || 10);
      const interval = action.verify.intervalMs || 800;
      const t0 = Date.now();
      while (Date.now() - t0 < waitS * 1000) {
        await sleep(interval);
        const sr = await evalJs(opts.proxy, tid, jsCardState(action, t.id)).catch(() => null);
        const s = typeof sr === 'string' ? (() => { try { return JSON.parse(sr); } catch { return null; } })() : sr;
        if (!s || s.error) continue;
        lastState = s;
        const sig = decideSendSignals({ s, greetsBefore, dlgBefore, action });
        if (sig.ok) {
          ok = true;
          log(`  ✓ 第${attempt}次点击生效（+${((Date.now() - t0) / 1000).toFixed(1)}s）` +
              `按钮=${s.cont || s.btn}　遮罩=${s.dlg}　全页按钮数=${s.greets}(起始 ${greetsBefore})` +
              ` [${sig.via}]${sig.staleModal ? '（注：另有陈旧遮罩，未计入判定）' : ''}`);
          break;
        }
      }
      if (ok) break;

      log(`  ✗ 第${attempt}次点击 ${waitS}s 内无业务变化　状态=${JSON.stringify(lastState).slice(0, 200)}`);
      // 只有确认「确实没发出去」才重试
      if (lastState && (lastState.cont || lastState.cardGone)) { log('  → 目标状态已变化，不再重试'); break; }
    }

    if (ok) {
      consecutiveFail = 0;
      results.push({ ...t, status: 'succeeded', btnAfter: lastState?.cont, greetsAfter: lastState?.greets });
      const wrote = commitOne(t);
      log(`[${idx}/${list.length}] ✅ ${t.name || t.id} · ${t.title || ''} 已送达${wrote ? '（记录已回写）' : ''}`);
    } else {
      consecutiveFail += 1;
      lastRisk = true;
      results.push({ ...t, status: 'unverified', btnAfter: lastState?.btn, note: '两次点击均无业务变化' });
      log(`[${idx}/${list.length}] ⚠ ${t.name || t.id} 未确认送达（下次间隔将拉长）`);
      if (consecutiveFail >= 2) { stopReason = 'STOP:连续 2 次未确认送达，熔断以免扩大异常'; break; }
    }
    doneCount += 1;
    processed = idx;
    if (usedSafe) lastRisk = true;   // 出现过遮挡/元素异常 → 下次拉长
    // 抗中断：每条处理后立刻刷新进度（含成功数、失败数与剩余量）
    writeProgress({
      ...planView(idx), current: null,
      ok: results.filter((r) => r.status === 'succeeded').length,
      failed: results.filter((r) => ['failed', 'unverified'].includes(r.status)).length,
      skipped: results.filter((r) => String(r.status).startsWith('skipped')).length,
    });
  }

  // ─────────────────────────────────────────────────── 收尾
  const succeeded = results.filter((r) => r.status === 'succeeded');
  const skipped = results.filter((r) => String(r.status).startsWith('skipped'));
  const failed = results.filter((r) => ['failed', 'unverified'].includes(r.status));
  const remainingFinal = Math.max(0, scopeTotal - doneBefore - processed);   // 与 planView 同源

  log('═'.repeat(70));
  log(`完成：成功 ${succeeded.length} / 跳过 ${skipped.length} / 未确认 ${failed.length} / 本批目标 ${list.length}`);
  if (remainingFinal > 0) log(`本批未处理完，仍余 ${remainingFinal} 人 —— 续跑：同一条命令加 --resume`);
  if (stopReason) log(`${graceful ? '⏸ 安全停机' : '熔断'}原因：${stopReason}`);
  // 模板失效的强提示：大部分卡片都"找不到"，通常不是人不在，而是选择器过时了
  if (cardGoneCount > list.length / 2 && list.length >= 4) {
    log(`⚠ 提示：${cardGoneCount}/${list.length} 个目标都定位不到卡片。若你确认这些卡片应当存在，`);
    log(`  说明动作模板的选择器已随站点改版失效 —— 请按 SKILL.md「首次执行必做：结构探测」重新探测并更新`);
    log(`  templates/actions/zhipin-boss-greet.json。`);
  }

  // 抗中断：--resume 时把历史结果合并进来，结果文件始终是「全局累积视图」
  const finalResults = opts.resume ? mergeResults(prevResults, results) : results;
  fs.writeFileSync(opts.out, JSON.stringify(finalResults, null, 2), 'utf8');

  // 触达记录已在每条成功时增量回写（见 commitOne），这里只做汇总
  if (opts.commit && opts.touch) {
    log(`触达记录：累计 ${touchArr.length} 条 → ${opts.touch}`);
  } else if (succeeded.length) {
    log('⚠ 未传 --commit，本次触达未写入记录文件 —— 冷却期与去重将失去依据，请记得补写。');
  }

  const summary = {
    ok: failed.length === 0 && !stopReason,
    finished: remainingFinal === 0 && !stopReason,
    targets: list.length, succeeded: succeeded.length, skipped: skipped.length, failed: failed.length,
    remaining: remainingFinal, graceful, profile: profile.key, stopReason,
    names: succeeded.map((r) => r.name || r.id),
  };

  // 抗中断：收尾写"终态进度"与"完成哨兵" —— 等待方只需看哨兵，不必解读日志
  writeProgress({
    ...planView(processed), current: null,
    ok: succeeded.length, failed: failed.length, skipped: skipped.length,
    stopReason, graceful, finished: true,
  });
  writeDone({
    // 注意：不要把 total 覆盖成 list.length（那是"本块"数量）——
    // 心跳/哨兵一律用计划视角，否则 status.mjs 会显示「进度 8/2（400%）」（2026-10-13 实测）。
    allOk: summary.ok, finished: summary.finished, batchTargets: list.length,
    succeeded: succeeded.length, failed: failed.length, skipped: skipped.length,
    remaining: remainingFinal, stopReason, graceful,
  });
  finishedNormally = true;

  log(`进度：${opts.progress}`);
  log(`哨兵：${opts.done}${summary.finished ? '（已完成）' : `（未完成，余 ${remainingFinal} 人）`}`);
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  process.exit(stopReason && !graceful ? 4 : (failed.length ? 1 : 0));
}

if (invokedDirectly) main().catch((e) => { console.error('异常终止：', e.message); process.exit(1); });
