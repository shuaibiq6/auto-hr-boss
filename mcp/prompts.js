#!/usr/bin/env node
/**
 * prompts.js — MCP Prompts（4 个剧本，作增强；剧本不是安全边界，代码才是）
 */

export const PROMPTS = [
  {
    name: 'daily-150-run',
    description: '日 150 全流程剧本：env→session→screen→dry→分批 start→轮询→verify→报告',
    arguments: [
      { name: 'date', description: '计划日期 YYYY-MM-DD', required: false },
      { name: 'profile', description: '限频档位，默认 hr150', required: false },
    ],
  },
  {
    name: 'safe-batch-greet',
    description: '单批标准剧本（含「先 dry 后 live」的强制两步）',
    arguments: [
      { name: 'mode', description: 'dry 或 live', required: true },
      { name: 'limit', description: '本批处理人数', required: false },
    ],
  },
  {
    name: 'triage-risk-stop',
    description: '熔断处置剧本：读状态、定位信号、给出当日终止与次日恢复指引',
    arguments: [],
  },
  {
    name: 'verify-and-report',
    description: '核验 + 生成报告（送达率、未送达清单、重跑建议）',
    arguments: [{ name: 'jobId', description: '要核验的 job_id', required: true }],
  },
];

export function getPrompt(name, args = {}) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) return null;
  // T4-7：剧本参数校验（mode 白名单 / profile 字符集 / limit 数字 / jobId 剥除非法字符），防参数注入提示词
  const mode = args.mode === 'live' ? 'live' : 'dry';
  const profile = /^[a-z0-9_]+$/.test(String(args.profile || '')) ? String(args.profile) : 'hr150';
  const limit = /^\d{1,4}$/.test(String(args.limit || '')) ? String(args.limit) : '（以 screen_talent 的 accepted 数量为准）';
  const jobId = String(args.jobId || '').replace(/[^A-Za-z0-9_-]/g, '') || '<job_id>';

  const scripts = {
    'daily-150-run': `你正在执行 BOSS 招聘端「单日 150 触达」流程。严格按顺序执行，任何一步被 Server 拒绝都停下并向用户说明原因（不要试图绕过）。

1. boss_env_check（fix=true）—— 确认 Node>=22 / 浏览器 / 目录可写
2. boss_session_start —— 拉起会话链路；若 login_hint 提示登录，请用户在本机窗口登录后继续
3. boss_session_health（deep=true）—— 确认 login_ok 且 verdict=OK
4. boss_screen_talent —— 传入岗位画像与候选人，取得 plan_id
5. boss_greet_start（mode=dry, plan=plan_id）—— 先演练，确认无风控
6. boss_greet_status —— 观察 dry 结果，确认 dry-ok
7. boss_greet_start（mode=live, plan=plan_id, profile=${profile}）—— 真实触达（Server 会强制过闸门）
8. 分批：把 150 拆成多个会话（30/30/30/30/20/10），每批用一个 job；用 boss_greet_status（wait_seconds=20）轮询
9. 每批跑完立刻 boss_greet_verify —— 平台侧独立核验
10. boss_history（op=stats）—— 汇总，生成当日报告

关键：live 前必先对本批跑通 dry（Server 会强制校验当日凭证）；respect_window 默认关（连续跑完、跨午休不中断，全局去重保证不重复触达）；不要压缩间隔、不要跨过闸门。`,
    'safe-batch-greet': `单批标准打招呼流程（mode=${mode}，limit=${limit}）。

1. 若尚无 plan：boss_screen_talent 生成 plan_id
2. boss_session_health（deep=true）确认会话与风控状态
3. boss_greet_start（mode=dry, plan=plan_id）—— 必须的演练步
4. boss_greet_status 确认 dry 无异常
5. ${mode === 'live' ? `boss_greet_start（mode=live, plan=plan_id, limit=${limit}）` : '（mode=dry 到此即可；如需真实触达请用 mode=live 重跑第 5 步）'}
6. boss_greet_status（wait_seconds=20）轮询直到 finished/stopped/blocked
7. boss_greet_verify（job_id=...）独立核验，以 verify 为准

任何 E_CIRCUIT_OPEN / E_RISK_BLOCK / E_GATE_DENIED 都立即停止，不要重试或绕过。`,
    'triage-risk-stop': `熔断处置剧本（当出现 E_CIRCUIT_OPEN / E_RISK_BLOCK / verdict=BLOCK 时执行）。

1. boss_greet_status（include=["watchdog","log_tail"]）—— 定位是哪个信号触发（watchdog.stopReason / lastExit / 日志尾部）
2. 确认 history/breaker.json 已写入当日熔断（Server 自动完成，无需手动）
3. 当日动作：不再启动任何 live job；已运行的用 boss_greet_stop 停掉
4. 向用户如实说明三条独立事实（INV-28）：
   · 技术上未被识别
   · 行为上未产生投诉
   · 因此尚未触发处置
   以及风险披露（INV-29）：部分站点对自动化检测严格，存在账号封禁风险，无法完全避免。
5. 次日恢复：breaker 按日自动过期；先 boss_session_health（deep=true）确认风控解除，再走 safe-batch-greet 的 dry→live 流程。
6. 绝不执行任何验证码绕过 / 答题绕过 / 点击「不再显示」类按钮。`,
    'verify-and-report': `核验与报告剧本（jobId=${jobId}）。

1. boss_greet_verify（job_id=${jobId}）—— 平台侧独立核验
2. 读取 summary：sent / not_sent / card_gone / missing_frame / unknown
3. 若 not_sent>0：按 advisory 把未送达 id 放入下一批重跑（不要以日志 ✅ 为准）
4. boss_history（op=stats）—— 汇总当日/近 7 日触达
5. 生成报告：送达率、未送达清单、风控事件、次日建议`,
  };

  return {
    description: p.description,
    messages: [{ role: 'user', content: { type: 'text', text: scripts[name] } }],
  };
}
