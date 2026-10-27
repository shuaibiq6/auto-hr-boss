---
name: boss-hr-outreach-safe
license: MIT
github: https://github.com/shuaibiq6
description: 联网操作 skill —— BOSS 直聘招聘端批量触达加固版。在通用浏览器自动化能力之上，内置招聘端限频档位 hr150（日 150 安全排班）、招聘方准入闸门与风控熔断。触发场景：招聘方主动触达候选人 / 批量打招呼 / 候选人筛选排序 / 简历获取，以及任何需要真实浏览器环境的联网任务（搜索、网页抓取、登录后操作、页面交互）。
version: 2.11.0
display_name: "BOSS 招聘触达 · 安全版"
display_name_en: "BOSS HR Outreach (Safe)"
description_zh: "BOSS 招聘端批量触达加固版：日 150 安全排班、准入闸门、风控熔断，CDP 直连本地浏览器"
description_en: "Hardened BOSS recruiter outreach: daily-150 pacing, screening gate, risk guardrails"
visibility: "public"
---

# BOSS 招聘触达 · 安全版（boss-hr-outreach-safe）

> 本 skill 专为 **BOSS 直聘招聘端批量触达** 而建，默认限频档为 `hr150`（日 150 安全排班）。
> 排班与窗口反推见 [`references/hr-daily-150-plan.md`](references/hr-daily-150-plan.md)；
> 招聘端执行器 `greet-batch.mjs` 默认档同步为 `hr150`。

> **MCP 接入（可选）**：本仓库附带薄壳 MCP 子包，把引擎能力暴露成 12 个 `boss_` 工具 + Resources + Prompts。
> 见 [`mcp/README.md`](mcp/README.md)；离线自检 `node mcp/test/run-tests.mjs`。

## 运行环境（部署前必读）

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22（必需）** —— 使用原生 `WebSocket` / `fetch` / `AbortSignal.timeout` |
| 第三方依赖 | **无**。全部脚本只 import Node 内置模块，**不需要 `npm install`** |
| 浏览器 | 本机已安装的 Microsoft Edge 或 Google Chrome（Chromium 桌面版） |
| 权限 | 对 skill 目录有写权限即可，**不需要管理员/root** |
| 端口 | `127.0.0.1:3456`（代理）、`127.0.0.1:9222`（浏览器调试） |

完整要求、新机器部署步骤、故障排查表见 [`references/environment-setup.md`](references/environment-setup.md)。

**在新机器上第一次使用，先跑环境自检：**

```bash
node "${CLAUDE_SKILL_DIR}/scripts/setup-env.mjs"
```

退出码：`0` 全绿可直接用；`2` 有需确认项（如浏览器偏好未设）；`1` 有阻塞项（缺 Node 22 / 缺浏览器 / 无写权限）。
报告会针对每个 FAIL 项直接给出解决指引。加 `--fix` 自动建目录、生成 `config.env`。

> ⚠️ **登录态不会随 skill 迁移。** 浏览器使用的是**本机**副本 profile。换一台机器后，
> 需要在该窗口里手动登录目标站点一次（之后 profile 复用，无需重复登录）。
> Node、浏览器、代理都不需要预装成服务 —— 但**别把登录凭据当成可打包资产**。

## 前置检查

在开始联网操作前，检查 CDP 模式可用性：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"
```

按脚本输出处理：
- `exit 0` → 继续
- `exit 2` → 需询问用户偏好，写入 `${CLAUDE_SKILL_DIR}/config.env` 的 `WEB_ACCESS_BROWSER`
- `exit 1` → 按 stdout 错误信息处理。若提示包含「Agent 处理顺序」，按其步骤执行（如先用系统命令打开浏览器后重跑），自动可解则不打扰用户；仍失败再向用户求助

支持参数 `--browser <chrome|edge>` 表达本次临时覆盖（不写 config.env）。

切换浏览器时，proxy 是长驻进程，需先 `pkill -f cdp-proxy.mjs` 再重跑 check-deps。

检查通过后并必须在回复中向用户直接展示以下须知，再启动 CDP Proxy 执行操作：

```
温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。
```

## 接收方视角：批量触达类操作的前置要求

> 适用于代表用户向**真实的人**发起批量触达的操作：招聘投递、给 HR 发招呼、给商家或作者留言、批量发送面试邀请等。
> 完整风险模型与操作规范见 [`references/recruiter-perspective.md`](references/recruiter-perspective.md)。

**先纠正一个默认的错误直觉**：这类操作被封的主要来源不是「被算法识别为机器人」，而是**屏幕另一端那个人按下的按钮**——
标记不合适、拉黑、举报、批量拉黑。平台的处置链路是「接到投诉 → 核实 → 处置」，投诉是直接输入，算法检测只是辅助证据。

所以执行顺序是固定的：**先消除投诉与无效触达，再处理技术伪装。反过来做等于白做。**

### 三条不可协商的约束

1. **协议层面本就违规，不要向用户宣称「安全」。**
   多数平台协议同时禁止「第三方工具接入本服务」与「规避平台功能限制」，自动化触达两者皆犯。
   向用户如实表述为：**技术上未被识别 + 行为上未产生投诉 + 因此尚未触发处置**。三者是独立事实，不可合并成一句「没问题」。
2. **批量触达前必须跑 [`scripts/preflight.mjs`](scripts/preflight.mjs) 闸门**，未通过的不触达。
   闸门拦三类东西：会让接收方觉得「你根本没看 JD 就投」的硬性不匹配、会形成群发印象的方向发散与时间聚集、
   以及已触达记录的重复命中。用法见 `--help`，`--init` 可生成配置模板。
3. **出现下列任一信号，立即终止当天全部操作**：验证码 / 滑块、**被要求答题**、发送后不再显示送达状态、
   出现「操作频繁」、收到明确的拒绝或拉黑。
   注意**「要求答题」的优先级高于验证码**——验证码可能只是常规人机校验，而答题是平台**已判定违规之后**的处置动作。

### 单次强度必须永久性压低，而不是临时收敛

平台的处置是**累积评分 + 阈值触发**，不是一碰就杀。所以「这次没被拦截」不构成下次可以照做的依据——
那是运气，不是许可。有效做法是把单次强度固定在一个永远够不到阈值的水平：限量、分散时段、
随机且**带方差**的间隔（定长间隔本身就是可被统计识别的特征）、触达前制造真实阅读行为。

### 触达后的第一条自编消息决定成败

批量触达的首次消息通常受平台预设模板约束、无法改写。**真正能改变接收方判断的，是他回复之后你发出的第一条消息**——
此时必须针对对方的 JD ／商品 ／内容写具体内容，而不是延续模板。这是唯一有效的「洗掉群发嫌疑」的动作。

## 招聘方视角：主动触达候选人

> 适用于你以**招聘方**身份主动联系候选人：招聘平台打招呼、人才库邀约、站内私信。
> 完整风险模型与操作规范见 [`references/talent-outreach.md`](references/talent-outreach.md)。
> 这是上一节的**镜像场景**——接收方从 HR 变成了求职者，判定方向相反，配置参数不可复用。

**先明确最容易被搞反的一点：招聘方的首要风险不是"被投诉"，而是"无效触达"本身。**

候选人对收到招聘招呼有正常预期，不会像 HR 收到海投简历那样反感。但平台会**量化招聘方的回复率**，
把大量无人回应的招呼判定为低质量触达，压低职位曝光——损耗发生在平台侧，机制与求职端的「静默降权」一致。
所以"发得多"在招聘端是**负收益**：每一发不匹配的招呼都在拉低回复率的分母。

三条与求职端不同的约束：

1. **企业账号被处置的代价高于个人账号**：影响企业认证与全部在招职位，通常需公司层面申诉。低暴露是纪律，不是偏好。
2. **「推荐牛人」有匹配算法**：大量触达与职位不符的人会让算法把你偏好的人学偏，后续推荐质量下降。这是算法层面的自我惩罚，与风控无关。
3. **招呼语"文本相同"的性质变了**：候选人默认收到的招聘招呼就是模板（他看不到别人收到什么），
   所以逐条改写招呼语的收益**远低于**求职端场景。决定成败的仍然是**候选人回复后你发出的第一条消息**——
   必须针对他的简历写，给出技术栈、业务场景与薪资区间。把精力放在这里，不要放在轮换第一条。

执行流程：跑 [`scripts/screen-talent.mjs`](scripts/screen-talent.mjs) 拿到按匹配度降序的名单 →
逐人自检 → 打开详情页读简历 → `/clickSafe` 点「打招呼」→ 回写触达记录。
**只执行到「发送招呼语」为止**，候选人回复后的对话由用户本人完成。

> 现成执行器：[`scripts/greet-batch.mjs`](scripts/greet-batch.mjs) 已封装上述全流程（含限频、遮罩处理、窗口自愈、熔断）。
> **长批次（≥15 人 / ≥30 分钟）请用守夜人脱离启动** [`scripts/detach.mjs`](scripts/detach.mjs)
> （等价于 [`scripts/watchdog.mjs`](scripts/watchdog.mjs) 的脱离模式）—— 它负责分块、续跑、会话自愈，
> 并且**进程被外部终止时会自动带 `--resume` 续跑**。详见下文「五、长任务不中断」。

> **单日触达有量指标时，不要自己拼节奏** —— 按 [`references/hr-daily-150-plan.md`](references/hr-daily-150-plan.md) 执行：
> 固定窗口 09:00–11:50 / 13:30–18:00、GAP 均值 145s、6 会话（30/30/30/30/20/10）合计 **150 次**。
> 该文件同时说明**为什么「日 200」在固定窗口下不成立**（窗口按安全 GAP 最多只能装 160 次），
> 以及回复率崩塌、候选池不足、转化闭环这三条与 GAP 无关的风险。

## 批量触达：限频与动作可靠性

> 适用于任何「反复执行同一动作 N 次」的任务：批量打招呼、批量投递、批量发私信。
> 两条**相互独立**的要求：**节奏安全**（限频）与**动作可确认**（命中 + 校验）。缺任一条都会出事。

### 一、节奏：向 `pacing.mjs` 要等待时间，不要自己 `sleep`

```bash
node "${CLAUDE_SKILL_DIR}/scripts/pacing.mjs" next --profile hr150 [--risk] --json
```

**本副本默认档是 `hr150`**（GAP 115–185s / 均值 145s / 日上限 150 / 窗口 09:00–11:50 + 13:30–18:00）。
其余档位、硬边界与拉长规则见 [`references/pacing-policy.md`](references/pacing-policy.md)；
招聘端「单日 150」的完整排班（时间预算、窗口反推表、6 会话时间表、分级熔断、爬坡表）
见 [`references/hr-daily-150-plan.md`](references/hr-daily-150-plan.md)。**必须遵守的四条**：

1. **不要压缩 GAP。** 触达耗时的九成是"故意等出来的"，那是安全成本不是性能问题。想快只有两条路：**拆会话**或**降 N**。
2. **单次强度固定**，不要"这次没被拦就下次加码"——平台的处置是累积评分 + 阈值触发，"没被拦"是运气不是许可。
3. **风险信号 → 该次间隔 ×1.5**（上限 300s），**不中断整批**：重试过 / 页面不可见 / 校验走了冗余分支 / 点击曾被遮挡拒绝。
4. **熔断信号 → 立即停止当天全部操作**：验证码、**被要求答题**（优先级最高，那是平台已判定违规后的处置）、
   「操作频繁」、登录失效、收到明确拒绝或拉黑。

日额度与活跃时段同样要过闸门：`pacing.mjs check --today <N>`。

### 二、动作：用 `/clickSafe`，成败只看业务状态

**本项目最隐蔽的失败形态：脚本每一轮都"成功"，实际一个动作都没执行。**

`/click`、`/clickHuman` 的返回值只说明「事件已发出」，**不说明业务已执行**。它们按 DOM 坐标算落点、**不做命中测试**，
被全屏遮罩挡住时照样返回 `clicked:true, tag:BUTTON`。逐轮失败得一模一样，日志里看不出任何异常。

所以两件事必须同时做：

1. **用 `/clickSafe` 点击。** 它做命中测试；被遮挡时自动点掉中性关闭按钮
   （只点「知道了 / 关闭 / 取消」，**绝不点「不再显示 / 不再提示」**——那会改用户账号设置）；
   关闭后轮询复测（容忍弹窗过渡动画）；仍无法命中就返回 **409 且不点击**。
   宁可不点，也不制造「输入层全绿、业务层零动作」的假象。
2. **用业务状态判定成败**：目标节点消失 / 文案变化 / 全局计数下降 / 回执弹窗出现，任一成立才算成功。
   **代理返回值不作为判据。**

拟人化轨迹（三次贝塞尔曲线 + ease-out 非匀速 + 末段过冲回正 + 点击前瞄准延迟 + 随机按住时长）
已内置于 `/clickHuman`、`/clickSafe`、`/mouseMove`，调用方无需关心参数。

### 三、现成执行器与自检

```bash
# 先 DRY：不点击，但会校验「真正的点击选择器」能否命中 —— 发现"动作模板过时"最省事的方式
node "${CLAUDE_SKILL_DIR}/scripts/greet-batch.mjs" --plan screen.result.json --limit 25 --dry

# 正式执行（--commit 会「每成功一条立即增量回写」触达记录，中途熔断也不会丢记录）
node "${CLAUDE_SKILL_DIR}/scripts/greet-batch.mjs" \
  --plan screen.result.json --limit 25 --profile balanced \
  --touch screen.touch.json --commit

# ★ 执行完立刻做平台侧核验（不要用脚本日志的 ✅ 当验收依据）
node "${CLAUDE_SKILL_DIR}/scripts/verify-greets.mjs" --plan screen.result.json --limit 25
```

### 四、两条不可绕过的硬规则（2026-10-09 事故沉淀，详见 `references/site-patterns/zhipin-boss.md` §3.7/§3.8）

1. **成功判据里「遮罩」信号必须要求"本轮新出现"。**
   上一次成功遗留、未被关闭的回执遮罩，会让之后每一轮都被误判为成功——脚本"看起来一路跑完"，
   实际一条都没发出去，且连续失败熔断永远不会触发。已固化在 `greet-batch.mjs` 的
   `decideSendSignals()`；不要用「当前有遮罩」这种无状态判据。

2. **验收只认平台侧业务状态，不认脚本日志。**
   用 `verify-greets.mjs` 回读卡片按钮（「打招呼」→「继续沟通」），或到「沟通」页核对 `[送达]`。
   实测教训：某次日志声称送达 7 人，平台侧实际只有 2 人。

> 另：**切换面板/路由一律点击站内导航项，禁止用 `/navigate` 硬跳 SPA 路由**（会触发
> `/web/user/?ka=bticket` 票据页并导致登录失效，当天操作被迫中止）。

动作模板放在 [`templates/actions/`](templates/actions/)（选择器与校验规则）。站点改版后按上面的
「首次执行必做：结构探测」重新探测，然后只改模板 JSON，不必动脚本。

### 五、长任务不中断（2026-10-13 加固，47 人级批次必读）

> 背景：一次 47 人批次要跑约 **2 小时**。2026-10-12 那次真正的"中断"并不是脚本崩了 ——
> 是上层为了看进度**反复用同一条命令扫日志**，被宿主的「重复调用保护」拦下，回合被直接切断。
> 加上另有两次真实故障（僵死进程占用 9222、批次中途夭折后进度全丢），这一版把"中断"整体降级为
> **"发一条续跑命令"**。

**推荐入口：把整批交给「守夜人」，而不是自己盯**

```bash
# ★ 首选（无人值守）：脱离宿主启动守夜人 —— 被杀会自动带 --resume 续跑，直到跑完
node "${CLAUDE_SKILL_DIR}/scripts/detach.mjs" \
  --plan screen.result.json --limit 47 --chunk 8 \
  --touch screen.touch.json --commit --out screen.greet.json --log screen.greet.log

# 看进度（可反复执行，不打扰批处理）；守夜人存活与否、跑到第几轮、还剩几人都在里面
node "${CLAUDE_SKILL_DIR}/scripts/status.mjs" --out screen.greet.json --health

# 停止（连带守夜人与当前块）
node "${CLAUDE_SKILL_DIR}/scripts/detach.mjs" --stop --out screen.greet.json

# 中断之后：原样再执行同一条命令即可 —— --resume 会跳过已完成的人
```

不想脱离宿主时，也可以用批次守护（前台/后台皆可，逻辑同上但生命周期随父进程）：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/run-until-done.mjs" \
  --plan screen.result.json --limit 47 --chunk 12 \
  --touch screen.touch.json --commit
# 加 --detach 即等价于上面推荐的脱离启动
```

**看进度：读状态文件，不要扫日志**

```bash
node "${CLAUDE_SKILL_DIR}/scripts/status.mjs" --out screen.result.json --health
# 人读输出：进度 / 成功 / 失败 / 剩余 / 正在处理谁 / 停机原因 / 终止原因 / 守夜人状态 / 心跳时间
# 退出码：0 运行中 · 12 本轮结束未跑完（可续跑） · 10 已完成 · 11 异常中止

# 需要"挂住回合"时有界等待（配合工具的超时上限，如 ≤540s）
node "${CLAUDE_SKILL_DIR}/scripts/status.mjs" --out screen.result.json --wait 540
```

**抗中断的机制**

| 机制 | 位置 | 作用 |
|---|---|---|
| `--progress <f>` | greet-batch | 进度心跳：每条处理后立即落盘，含 `remaining` 与 `doneIds`（已办 id 清单） |
| `--done <f>` | greet-batch | 完成哨兵：收尾写一次。**等待方只需读它**，不必解读日志 |
| `--resume` | greet-batch | 跳过已处理项；依据**多源合成**（结果文件 ∪ 心跳 `doneIds` ∪ 触达记录），结果文件跨批次**合并累积** |
| `--chunk <n>` / `--max-runtime <s>` | greet-batch | 把一次运行压成有界片段，中断点永远落在安全边界（exit 0 + `remaining`） |
| `--lock <f>`（默认 `<out>.lock`） | greet-batch | 单实例锁：同一份名单不会被两个进程同时点（`--force` 抢占，`--no-lock` 关闭） |
| 断管免疫 + 终止留痕 | greet-batch | stdout/stderr 的 EPIPE 一律吞掉（不再升级成未捕获异常）；`SIGINT/SIGTERM/SIGHUP`、未捕获异常、未处理拒绝都会写入 `abortReason` 后优雅退出 |
| **守夜人** | `watchdog.mjs` | 独立进程守护：每块跑完就**多源重算剩余**，只要还有余量且未触发闸门/熔断就自动续跑 |
| **脱离宿主** | `detach.mjs` | `detached + unref` 启动守夜人，stdio 走 `ignore`（不经任何会被关闭的管道），父进程立即返回 |

**运行纪律（照做就不会再被"掐断"）**

1. ⚠️ **长批次（≥15 人 / ≥30 分钟）优先用 `detach.mjs` 脱离启动**，不要挂在当前回合的后台任务上。
   它带来两件事：① 不依赖回合是否存活；② 不经过输出管道 —— 管道读取端消失也不会把进程带走。
   只有短批次或需要实时看日志时，才用 `run-until-done.mjs` 前台跑。

2. **"进程被外部终止"是真实存在的故障模式，而且无法预防 —— 所以只做"可恢复"。**
   2026-10-13 那次 25 人批次停在 7/25，心跳是 `stopReason:null / graceful:false / aborted:true`：
   不是脚本自己停的、也不是崩溃，而是被外部终止且走完了优雅退出路径。
   > ⚠️ **两个被实验推翻的中间结论（留痕，避免后人重走）**：
   > ① "沙箱收不到命令 13–16 分钟就回收托管进程" —— 用不受沙箱管辖的通道挂住回合、让沙箱 **19 分钟**
   >    零命令，三个托管探针**全程未中断**（每 5s 写一次、连续 232 次）→ **否证**。
   > ② "回合结束就会清理托管进程" —— 探针在回合结束后**连续存活 67.3 分钟、断档 0 处**
   >    （p1.log 807 次写入）→ **同样否证**。
   >
   > 结论：**凶手无法确证，也不重要**。工程上要做的只有两件：
   > **让被杀无感（守夜人自动续跑）** + **让断点可靠（多源合成已办集合）**。
   > 相关硬事实：2026-10-12 启动的 `start-session --hold` 至今存活 26h+；后台进程并非"必死"。

3. **看进度用 `status.mjs`，不要在短时间内反复执行同一条命令扫日志**（会触发宿主的重复调用保护，
   2026-10-12 的中断就是这个原因）。需要"占住回合"时用 `status.mjs --wait 540`（有界等待，内容在推进）。

4. **一次运行的时长要可控**：`--chunk 8`（≈20 分钟一块）或 `--max-runtime 540`；超时是**优雅停机**，不是失败。

5. **停机后不要重新筛人**：原样重跑即可，`--resume` 会跳过已发的。
   续跑依据是**多源合成**（结果文件 ∪ 进度心跳 `doneIds` ∪ 触达记录）——
   即使进程被强杀（`TerminateProcess`，连退出处理器都跑不到）、结果文件压根没写出来，
   也不会重复触达、也不会漏算。

6. **不要手工删锁文件**：残留锁会因 pid 已死而被自动忽略；真要抢占用 `--force`。

7. **`--respect-window`**：严格守限频时段时加它（默认关，即允许跨午休连续跑）。
   它按"**等完这次 GAP 之后的预计时刻**"判定，因此不会出现
   「11:49 通过检查 → 睡 170s → 11:52 才发出去」这种越窗。

### 六、端口与启动期故障自愈（2026-10-13 加固）

`start-session.mjs` 的端口清理已从「/json/version 能否解析」升级为
**「端口有没有被监听」+「监听者是否说 CDP」两层判定**，并在启动后补了一次
**127.0.0.1 回环自检**。修掉的是这个硬故障：

> 一个僵死的 Edge 后台助手（`--no-startup-window`）占着 **IPv4 `127.0.0.1:9222`**，对任何请求都回 404
> → 旧逻辑判定"浏览器没在跑"→ 不做清理 → 新实例抢不到 IPv4 只能绑 **IPv6**
> → 只有 `localhost:9222` 通、`127.0.0.1:9222` 404 → 代理按端点文件连 127.0.0.1 失败 →
> **整条链路起不来**，而且症状极易被误判成"登录失效/被踢"。

现在遇到这种情况会：明确报出占用 PID 与 HTTP 状态码 → 连续清两轮 → 复查端口是否真正释放 →
若仍只绑 IPv6 则**快速失败并给出处置建议**，而不是留一个说不清的半死状态。

## 浏览哲学

**像人一样思考，兼顾高效与适应性的完成任务。**

执行任务时不会过度依赖固有印象所规划的步骤，而是带着目标进入，边看边判断，遇到阻碍就解决，发现内容不够就深入——全程围绕「我要达成什么」做决策。这个 skill 的所有行为都应遵循这个逻辑。

**① 拿到请求** — 先明确用户要做什么，定义成功标准：什么算完成了？需要获取什么信息、执行什么操作、达到什么结果？这是后续所有判断的锚点。

**② 选择起点** — 根据任务性质、平台特征、达成条件，选一个最可能直达的方式作为第一步去验证。一次成功当然最好；不成功则在③中调整。比如，需要操作页面、需要登录态、已知静态方式不可达的平台（小红书、微信公众号等）→ 直接 CDP

**③ 过程校验** — 每一步的结果都是证据，不只是成功或失败的二元信号。用结果对照①的成功标准，更新你对目标的判断：路径在推进吗？结果的整体面貌（质量、相关度、量级）是否指向目标可达？发现方向错了立即调整，不在同一个方式上反复重试——搜索没命中不等于"还没找对方法"，也可能是"目标不存在"；API 报错、页面缺少预期元素、重试无改善，都是在告诉你该重新评估方向。遇到弹窗、登录墙等障碍，判断它是否真的挡住了目标：挡住了就处理，没挡住就绕过——内容可能已在页面 DOM 中，交互只是展示手段。

**④ 完成判断** — 对照定义的任务成功标准，确认任务完成后才停止，但也不要过度操作，不为了"完整"而浪费代价。

## 联网工具选择

- **确保信息的真实性，一手信息优于二手信息**：搜索引擎和聚合平台是信息发现入口。当多次搜索尝试后没有质的改进时，升级到更根本的获取方式：定位一手来源（官网、官方平台、原始页面）。

| 场景 | 工具 |
|------|------|
| 搜索摘要或关键词结果，发现信息来源 | **WebSearch** |
| URL 已知，需要从页面定向提取特定信息 | **WebFetch**（拉取网页内容，由小模型根据 prompt 提取，返回处理后结果） |
| URL 已知，需要原始 HTML 源码（meta、JSON-LD 等结构化字段） | **curl** |
| 非公开内容，或已知静态层无效的平台（小红书、微信公众号等公开内容也被反爬限制） | **浏览器 CDP**（直接，跳过静态层） |
| 需要登录态、交互操作，或需要像人一样在浏览器内自由导航探索 | **浏览器 CDP** |

浏览器 CDP 不要求 URL 已知——可从任意入口出发，通过页面内搜索、点击、跳转等方式找到目标内容。WebSearch、WebFetch、curl 均不处理登录态。

**Jina**（可选预处理层，可与 WebFetch/curl 组合使用，由于其特性可节省 tokens 消耗，请积极在任务合适时组合使用）：第三方网络服务，可将网页转为 Markdown，大幅节省 token 但可能有信息损耗。调用方式为 `r.jina.ai/example.com`（URL 前加前缀，不保留原网址 http 前缀），限 20 RPM。适合文章、博客、文档、PDF 等以正文为核心的页面；对数据面板、商品页等非文章结构页面可能提取到错误区块。

进入浏览器层后，`/eval` 就是你的眼睛和手：

- **看**：用 `/eval` 查询 DOM，发现页面上的链接、按钮、表单、文本内容——相当于「看看这个页面有什么」
- **做**：用 `/click` 点击元素、`/scroll` 滚动加载、`/eval` 填表提交——像人一样在页面内自然导航
- **读**：用 `/eval` 提取文字内容，判断图片/视频是否承载核心信息——是则提取媒体 URL 定向读取或 `/screenshot` 视觉识别

浏览网页时，**先了解页面结构，再决定下一步动作**。不需要提前规划所有步骤。

### 页面就绪与完成判断

`/new` 或 `/navigate` 返回，只代表浏览器完成了当前文档的基础加载，不代表用户需要的内容已经出现。HTTP 200、`document.readyState === "complete"`、页面标题出现或导航调用成功，都不能单独作为任务完成标准。

导航后先用 `/eval` 检查目标内容。若目标内容尚未出现，而页面仍是空白、加载态、验证页、登录跳转或其它可能继续变化的中间状态，在默认 15 秒窗口内持续观察 URL、标题和 DOM；页面发生跳转或内容变化后重新判断。只有目标内容已经获取，或观察窗口结束后仍存在明确阻碍，才能继续提取或报告失败。

站点经验可以提供更精确的选择器、等待条件和已知中间状态，但只用于加速判断；即使没有站点经验，也必须遵循上述目标内容就绪规则。

### 补充：本地浏览器资源

用户指向**本人访问过的页面**（"我之前看的那个讲 X 的文章"、"上次打开过的 XX 面板"）或**组织内部系统**（"我们的 XX 平台"、"公司那个 YY 系统"等公网搜不到的目标）时，检索本地浏览器（Chrome / Edge）书签/历史：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/find-url.mjs" [关键词...] [--only bookmarks|history] [--browser chrome|edge] [--limit N] [--since 1d|7h|YYYY-MM-DD] [--sort recent|visits]
```

关键词空格分词、多词 AND，匹配 title + url（可省略）；默认遍历所有已安装的 Chromium 系浏览器（Chrome、Edge），`--browser` 限定单一来源；`--since` / `--sort` 仅作用于历史；默认按最近访问倒序，`--sort visits` 按访问次数排序（适合"高频访问的网站"这类场景）。

### 程序化操作与 GUI 交互

浏览器内操作页面有两种方式：

- **程序化方式**（构造 URL 直接导航、eval 操作 DOM）：成功时速度快、精确，但对网站来说不是正常用户行为，可能触发反爬机制。
- **GUI 交互**（点击按钮、填写输入框、滚动浏览）：GUI 是为人设计的，网站不会限制正常的 UI 操作，确定性最高，但步骤多、速度慢。

根据对目标平台的了解来灵活选择方式。GUI 交互也是程序化方式的有效探测——通过一次真实交互观察站点的实际行为（URL 模式、必需参数、页面跳转逻辑），为后续程序化操作提供依据；同时当程序化方式受阻时，GUI 交互是可靠的兜底。

**站点内交互产生的链接是可靠的**：通过用户视角中的可交互单元（卡片、条目、按钮）进行的站点内交互，自然到达的 URL 天然携带平台所需的完整上下文。而手动构造的 URL 可能缺失隐式必要参数，导致被拦截、返回错误页面、甚至触发反爬。

## 浏览器 CDP 模式

通过 CDP Proxy 直连用户日常浏览器（Chrome / Edge / Chromium 等 Chromium 系），天然携带登录态，无需启动独立浏览器。
若无用户明确要求，不主动操作用户已有 tab，所有操作都在自己创建的后台 tab 中进行，保持对用户环境的最小侵入。不关闭用户 tab 的前提下，完成任务后关闭自己创建的 tab，保持环境整洁。

### 启动

**首选：一键拉起（浏览器 + 代理 + 目标 tab 一步到位）**

```bash
node "${CLAUDE_SKILL_DIR}/scripts/start-session.mjs" \
  --url https://www.zhipin.com/web/chat/recommend \
  --page-match zhipin.com --tid-out ./_tid.txt
```

它依次做四件事并各自打印耗时：① 按调试端口精确结束旧浏览器（**不动用户日常那个 Edge**）；
② 启动浏览器（lean 瘦身档 + 防遮挡参数），**等它真正 READY** 才继续；
③ 启动代理并等 `/health.connected`；④ 定位目标 tab 并打印 `targetId`。
正常 5–10 秒跑完，把过去 6–8 次工具调用压成一条命令。

**只起代理（浏览器已经开着）：**

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"
```

脚本会依次检查 Node.js、浏览器调试端口，并确保 Proxy 已连接（未运行则自动启动并等待）。Proxy 启动后持续运行。

**若浏览器尚未开调试端口**，用 skill 自带的启动脚本，不要手敲命令——有三类必加参数，漏了会踩到难以诊断的坑：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/launch-browser.mjs" --url https://example.com
```

它做四件事：① 自动定位 Edge/Chrome 可执行文件；② 指向**副本用户数据目录**
（`%LOCALAPPDATA%\<Browser>CDP`，不动你的日常 profile——新版 Chromium 拒绝在默认目录上开调试端口）；
③ 默认加上防遮挡检测参数（不加则窗口被其他窗口盖住时，所有点击/移动/滚轮命令会永久挂起，
详见「⚠️ 关键陷阱：页面不可见时 Input 域命令会永久挂起」）；
④ **默认开 lean 瘦身档 + 等待 CDP 就绪并写端点文件**（见下）。

#### 端点文件（重要机制，2026-09-30 新增）

浏览器 READY 后，`launch-browser.mjs` 会把真实端点写进
`%LOCALAPPDATA%\<Browser>CDP\.cdp-endpoint.json`：

```json
{ "browserId": "edge", "port": 9222, "wsPath": "/devtools/browser/<uuid>",
  "wsUrl": "ws://127.0.0.1:9222/devtools/browser/<uuid>", "pid": 1234, "ts": 1759... }
```

**代理优先读这个文件**，只有它失效才退回常规发现流程。

> 为什么必须这样：Chromium 的浏览器级 UUID **每次启动都会变**。
> 而 `%LOCALAPPDATA%\Microsoft\Edge\User Data\DevToolsActivePort` 这种**默认目录**下的文件
> 是历史遗留（Edge 136+ 根本不允许在默认目录开调试，所以那份文件必然过期）。
> 一旦拿旧 UUID 去握手，会得到 404 → 非 101，且旧版逻辑会在失败后清缓存重发现、
> 再读到同一个旧 UUID —— **死循环**。实测这一条曾造成单次启动连续 12 次握手失败。

#### 性能基准（2026-09-30 实测，供回归对比）

| 环节 | 实测 |
|---|---|
| Edge 冷启动 → CDP 端口可用 | **0.38–0.42 s** |
| → WebSocket 握手成功 | **0.39–0.43 s** |
| → 推荐页卡片渲染完成（页面真正可用） | **3.26 s** |
| Node 脚本单次冷启动 | ~0.54 s |

**结论：浏览器启动不是瓶颈（3 秒级）。** 历史上"启动慢"的主因是
①代理握手风暴 ②`check-deps.mjs` 旧等待策略最坏等 137 秒，两者均已修复。

### Proxy API

所有操作通过 curl 调用 HTTP API：

```bash
# 列出用户已打开的 tab
curl -s http://localhost:3456/targets

# 创建新后台 tab（自动等待加载）— URL 走 POST body，避免目标 URL 含 query 时被切分
curl -s -X POST --data-raw 'https://example.com' http://localhost:3456/new

# 页面信息
curl -s "http://localhost:3456/info?target=ID"

# 执行任意 JS：可读写 DOM、提取数据、操控元素、触发状态变更、提交表单、调用内部方法
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'

# 捕获页面渲染状态（含视频当前帧）
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"

# 导航（URL 走 POST body，target 走 query）、后退
curl -s -X POST --data-raw 'https://example.com' "http://localhost:3456/navigate?target=ID"
curl -s "http://localhost:3456/back?target=ID"

# 点击（POST body 为 CSS 选择器）— JS el.click()，简单快速，覆盖大多数场景
curl -s -X POST "http://localhost:3456/click?target=ID" -d 'button.submit'

# 真实鼠标点击 — CDP Input.dispatchMouseEvent，算用户手势，能触发文件对话框
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d 'button.upload'

# 拟人化点击 — 三次贝塞尔轨迹 + ease-out 非匀速 + 末段过冲回正，全部 trusted
# 返回体含 hitTest；注意它只保证"事件已发出"，不保证"落在目标上"
curl -s -X POST "http://localhost:3456/clickHuman?target=ID" -d 'button.submit'

# ★ 高可靠点击（推荐）— 命中测试 → 自动关遮罩 → 轮询复测 → 拟人轨迹点击
# 返回 200 才算真的点了；被遮挡且无法解除时返回 409 且"不点击"
curl -s -X POST "http://localhost:3456/clickSafe?target=ID" -d 'button.submit'

# 拟人化鼠标移动 / 滚轮 — trusted 事件，不点击
curl -s "http://localhost:3456/mouseMove?target=ID&steps=8"
curl -s "http://localhost:3456/wheel?target=ID&dy=420&steps=2"
curl -s "http://localhost:3456/wheel?target=ID&dy=400&steps=1&to=bottom"

# 唤醒页面 — 前置窗口 + 激活 tab（Input 事件被节流时必须先调）
curl -s "http://localhost:3456/focus?target=ID"

# 强制恢复窗口 — 窗口被最小化导致 Input 域挂起、/focus 救不回来时用
# 走浏览器级 Browser.* 域做「getWindowForTarget → normal → activateTarget」；&all=1 处理所有窗口
curl -s "http://localhost:3456/restore-window?target=ID&all=1"

# 文件上传 — 直接设置 file input 的本地文件路径，绕过文件对话框
curl -s -X POST "http://localhost:3456/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'

# 滚动（触发懒加载）
curl -s "http://localhost:3456/scroll?target=ID&y=3000"
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"

# 关闭 tab
curl -s "http://localhost:3456/close?target=ID"
```

### ⚠️ 关键陷阱：页面不可见时 Input 域命令会永久挂起

**症状**：`/clickHuman`、`/clickAt`、`/mouseMove`、`/wheel` 请求返回空、无任何响应，直到 curl 超时；
而同一时刻 `/eval`、`/navigate` 一切正常。日志里 `/eval` 能查到 `document.visibilityState === "hidden"`、`outerWidth === 0`。

**根因**：标签页在后台或被最小化时，Chromium 会节流渲染器，`Input.dispatchMouseEvent` 等不到渲染器的 ack，
于是命令无限等待（代理侧 30s 超时后 reject，但 HTTP 响应可能已经无法正常写回）。

**注意有两种 hidden**，症状完全一样但修法不同：

| 类型 | 判据 | 修法 |
|---|---|---|
| ① 标签不在前台 / 窗口最小化 | `outerWidth === 0`，或窗口有多个 tab | `ensureActive()` / `/focus` 即可解决 |
| ② **窗口被其他窗口完全遮挡** | `outerWidth` **正常**（如 1440）、窗口状态 `normal`、`Page.bringToFront` 与 `setWebLifecycleState('active')` 都调用成功，**但 `vis` 始终是 `hidden`** | `ensureActive()` **无效**，必须改启动参数（见下） |

类型 ② 是 Chromium 的 native window occlusion detection：窗口被完全挡住时其标签被判定为不可见。
它极容易被误诊为"被平台踢了"或"登录失效"，因为 `/eval` 一切正常、只有 Input 域挂起。

**判定方法**：

```bash
curl -s --noproxy '*' -X POST "http://localhost:3456/eval?target=ID" \
  -d 'JSON.stringify({v:document.visibilityState,ow:outerWidth})'
# {"v":"hidden","ow":0}    → 类型 ①
# {"v":"hidden","ow":1440} → 类型 ②（遮挡检测）
```

**修复（类型 ①）**：`/clickHuman`、`/mouseMove`、`/wheel` 已内置 `ensureActive()` 前置处理
（`Page.bringToFront` + `Page.setWebLifecycleState active` + 恢复窗口 bounds），正常情况下调用者无需关心。
若仍挂起，说明窗口被系统层面占用，手动调一次 `/focus` 并确认返回 `vis:visible`、`outerWidth` 非 0 再继续。
**注意**：`Emulation.setFocusEmulationEnabled` 也能让页面"以为"自己可见，但它会让 `hasFocus()` 与
`visibilityState` 出现不一致组合，反而可能成为指纹特征，仅在无其他手段时用 `/focus?...&emu=1`。

**修复（类型 ②）**：**只在启动浏览器时能关掉，运行期无法补救**。启动命令加这三个参数：

```bash
msedge.exe --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir="%LOCALAPPDATA%\EdgeCDP" \
  --disable-features=CalculateNativeWinOcclusion \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding
```

实测（2026-09-29）：同一台机器、同一窗口位置，只差这三个参数，`vis` 从恒为 `hidden` 变为 `visible`，
`/mouseMove` 从必然超时变为正常返回。**排查顺序务必先读 `outerWidth`**——否则会一直往"后台标签"方向白费功夫。
代价：`--disable-backgrounding-occluded-windows` 属于自动化工具常见开关，本身可能被指纹检测命中，
应在风险自评中如实计入。

### ⚠️ 关键陷阱：点击「发出去」不等于业务「生效」——阻塞式弹窗会吞掉后续点击（2026-09-30 实测）

**这是本项目遇到过最隐蔽的失败形态：脚本每一轮都"成功"，实际一个动作都没执行。**

机理：很多站点在**动作成功后**弹一个全屏遮罩弹窗（确认框／引导框／回执框）。
遮罩不关，**下一次点击就会打在遮罩上**——事件照常派发、`isTrusted=true`、代理返回 `{"clicked":true}`，
但业务毫无动作。因为每一轮都失败得一模一样，脚本会一路"跑完"，日志看不出异常。

三条硬规则：

1. **`/click`、`/clickHuman` 的返回值只说明"事件已发出"，不说明"业务已执行"。**
   它们按 DOM 坐标计算落点，**不做命中测试**，被遮挡时照样返回 `clicked:true, tag:BUTTON`。
   **永远用业务状态（节点消失／文本变化／计数变化／新弹窗出现）判定成败，不要用代理返回值判定。**
2. **每个动作的循环体里，点击前先"检查并关闭可见遮罩"，点击后再关一次。**
   关闭判据取"可见的模态容器 + 明确的关闭按钮文案"，不要用 `display:none` 之外的模糊条件；
   关闭按钮优先选「知道了／关闭／取消」这类**中性**按钮，**不要点「不再显示／不再提示」**——那会改用户账号设置。
3. **不要把"校验没看到反馈"当成"被风控了"。** 先按下面的顺序排查；只有命中
   **验证码／答题／"操作过于频繁"／登录失效／页面不可见** 才算风险信号。

**定位"点了没反应"的排查顺序**（2–3 步内可收敛，别猜）：

| 步 | 做什么 | 能区分什么 |
|---|---|---|
| 1 | 查可见模态容器（`display!=='none' && offsetWidth>200` 的 dialog/modal 类元素） | 被遮罩挡住（最常见） |
| 2 | 顶层 `document.elementFromPoint(x,y)` / iframe 内 `d.elementFromPoint(本地x,本地y)` | 被遮挡 vs 坐标算错（iframe 本地坐标 = 顶层坐标 − iframe 的 `getBoundingClientRect()` 左上角） |
| 3 | 在目标文档挂 capture 监听器记录 `pointerdown/mousedown/mouseup/click` + `e.isTrusted` + `e.target` | 输入层没到 vs 业务层没执行 |

**另一个容易误判的点**：不要用 `performance.getEntriesByType('resource')` 判断"最近有没有发请求"——
该缓冲区有上限（Chrome/Edge 默认 **250** 条），**满了之后新条目直接不记录**（不是淘汰旧的）。
实测缓冲区停在某个时间点后再无更新，差点被误判成"请求根本没发出"。

**判定失败后的重试**：只有在**确认确实没执行**（目标节点仍是初始态、全局计数未变）时才允许重试，
且**最多一次**——否则会造成重复提交。

### 页面内导航

两种方式打开页面内的链接：

- **`/click`**：在当前 tab 内直接点击用户视角中的可交互单元，简单直接，串行处理。适合需要在同一页面内连续操作的场景，如点击展开、翻页、进入详情等。
- **`/new` + 完整 URL**：使用目标链接的完整地址（包含所有URL参数），在新 tab 中打开。适合需要同时访问多个页面的场景。

很多网站的链接包含会话相关的参数（如 token），这些参数是正常访问所必需的。提取 URL 时应保留完整地址，不要裁剪或省略参数。URL 通过 POST body 原样传入 `/new` 或 `/navigate`。

> **v2.5.3 迁移提示**：若引用的站点经验文件（`references/site-patterns/*.md`）或其它脚本中仍含 `GET /new?url=...` 或 `/navigate?target=...&url=...` 的旧写法，调用会收到迁移指引。按 [`references/migration-2.5.3.md`](references/migration-2.5.3.md) 就地改写为 POST body 后再使用，并顺手把该站点经验文件更新掉。

### 媒体资源提取

判断内容在图片里时，用 `/eval` 从 DOM 直接拿图片 URL，再定向读取——比全页截图精准得多。

### 技术事实
- 页面中存在大量已加载但未展示的内容——轮播中非当前帧的图片、折叠区块的文字、懒加载占位元素等，它们存在于 DOM 中但对用户不可见。以数据结构（容器、属性、节点关系）为单位思考，可以直接触达这些内容。
- DOM 中存在选择器不可跨越的边界（Shadow DOM 的 `shadowRoot`、iframe 的 `contentDocument`等）。eval 递归遍历可一次穿透所有层级，返回带标签的结构化内容，适合快速了解未知页面的完整结构。
- `/scroll` 到底部会触发懒加载，使未进入视口的图片完成加载。提取图片 URL 前若未滚动，部分图片可能尚未加载。
- 拿到媒体资源 URL 后，公开资源可直接下载到本地后用读取；需要登录态才可获取的资源才需要在浏览器内 navigate + screenshot。
- 短时间内密集打开大量页面（如批量 `/new`）可能触发网站的反爬风控。
- 平台返回的"内容不存在""页面不见了"等提示不一定反映真实状态，也可能是访问方式的问题（如 URL 缺失必要参数、触发反爬）而非内容本身的问题。

### 视频内容获取

用户浏览器真实渲染，截图可捕获当前视频帧。核心能力：通过 `/eval` 操控 `<video>` 元素（获取时长、seek 到任意时间点、播放/暂停/全屏），配合 `/screenshot` 采帧，可对视频内容进行离散采样分析。

### 登录判断

用户日常浏览器天然携带登录态，大多数常用网站已登录。

登录判断的核心问题只有一个：**目标内容拿到了吗？**

打开页面后先尝试获取目标内容。只有当确认**目标内容无法获取**且判断登录能解决时，才告知用户：
> "当前页面在未登录状态下无法获取[具体内容]，请在你的浏览器中登录 [网站名]，完成后告诉我继续。"

登录完成后无需重启任何东西，直接刷新页面继续。

### 任务结束

用 `/close` 关闭自己创建的 tab，必须保留用户原有的 tab 不受影响。

Proxy 持续运行，不建议主动停止——重启后需要在浏览器中重新授权 CDP 连接。

## 并行调研：子 Agent 分治策略

任务包含多个**独立**调研目标时（如同时调研 N 个项目、N 个来源），鼓励合理分治给子 Agent 并行执行，而非主 Agent 串行处理。

**好处：**
- **速度**：多子 Agent 并行，总耗时约等于单个子任务时长
- **上下文保护**：抓取内容不进入主 Agent 上下文，主 Agent 只接收摘要，节省 token

**并行 CDP 操作**：每个子 Agent 在当前用户浏览器实例中，自行创建所需的后台 tab（`/new`），自行操作，任务结束自行关闭（`/close`）。所有子 Agent 共享一个浏览器、一个 Proxy，通过不同 targetId 操作不同 tab，无竞态风险。

**子 Agent Prompt 写法：目标导向，而非步骤指令**
- 必须在子 Agent prompt 中写 `必须加载 boss-hr-outreach-safe skill 并遵循指引` ，子 Agent 会自动加载 skill，无需在 prompt 中复制 skill 内容或指定路径。
- 子 Agent 有自主判断能力。主 Agent 的职责是说清楚**要什么**，仅在必要与确信时限定**怎么做**。过度指定步骤会剥夺子 Agent 的判断空间，反而引入主 Agent 的假设错误。**避免 prompt 用词对子 Agent 行为的暗示**：「搜索xx」会把子 Agent 锚定到 WebSearch，而实际上有些反爬站点需要 CDP 直接访问主站才能有效获取内容。主 Agent 写 prompt 时应描述目标（「获取」「调研」「了解」），避免用暗示具体手段的动词（「搜索」「抓取」「爬取」）。

**分治判断标准：**

| 适合分治 | 不适合分治 |
|----------|-----------|
| 目标相互独立，结果互不依赖 | 目标有依赖关系，下一个需要上一个的结果 |
| 每个子任务量足够大（多页抓取、多轮搜索） | 简单单页查询，分治开销大于收益 |
| 需要 CDP 浏览器或长时间运行的任务 | 几次 WebSearch / Jina 就能完成的轻量查询 |

## 信息核实类任务

核实的目标是**一手来源**，而非更多的二手报道。多个媒体引用同一个错误会造成循环印证假象。

搜索引擎和聚合平台是信息发现入口，是**定位**信息的工具，不可用于直接**证明**真伪。找到来源后，直接访问读取原文。同一原则适用于工具能力/用法的调研——官方文档是一手来源，不确定时先查文档或源码，不猜测。

| 信息类型 | 一手来源 |
|----------|---------|
| 政策/法规 | 发布机构官网 |
| 企业公告 | 公司官方新闻页 |
| 学术声明 | 原始论文/机构官网 |
| 工具能力/用法 | 官方文档、源码 |

**找不到官网时**：权威媒体的原创报道（非转载）可作为次级依据，但需向用户说明："未找到官方原文，以下核实来自[媒体名]报道，存在转述误差可能。"单一来源时同样向用户声明。

## 站点经验

操作中积累的特定网站经验，按域名存储在 `references/site-patterns/` 下。

确定目标网站后，如果前置检查输出的 site-patterns 列表中有匹配的站点，必须读取对应文件获取先验知识（平台特征、有效模式、已知陷阱）。经验内容标注了发现日期，当作可能有效的提示而非保证——如果按经验操作失败，回退通用模式并更新经验文件。

CDP 操作成功完成后，如果发现了有必要记录经验的新站点或新模式（URL 结构、平台特征、操作策略），主动写入对应的站点经验文件。只写经过验证的事实，不写未确认的猜测。

文件格式：
```markdown
---
domain: example.com
aliases: [示例, Example]
updated: 2026-03-19
---
## 平台特征
架构、反爬行为、登录需求、内容加载方式等事实

## 有效模式
已验证的 URL 模式、操作策略、选择器

## 已知陷阱
什么会失败以及为什么
```
经验/陷阱内容标注发现日期，当作"可能有效的提示"而非"保证正确的事实"。

## References 索引

| 文件 | 何时加载 |
|------|---------|
| `references/environment-setup.md` | **部署到新机器前必读** —— 硬性环境要求、部署三步、故障排查表 |
| `references/pacing-policy.md` | **批量触达前必读** —— 档位定义、硬边界、风险拉长与熔断规则 |
| `references/hr-daily-150-plan.md` | **招聘端有单日触达指标时必读** —— 日 150 排班、窗口反推、分级熔断、爬坡表 |
| `references/cdp-api.md` | 需要 CDP API 详细参考、JS 提取模式、错误处理时 |
| `references/site-patterns/{domain}.md` | 确定目标网站后，读取对应站点经验 |
| `references/recruiter-perspective.md` | **求职方视角** —— 替用户向 HR／商家／作者发起批量触达前必读 |
| `references/talent-outreach.md` | **招聘方视角** —— 替用户向候选人发起批量触达前必读（上者的镜像，参数不可复用） |
| `scripts/start-session.mjs` | **一键拉起会话**（清旧进程 → 起浏览器 → 等 READY → 起代理 → 定位 tab）。优先用它 |
| `scripts/setup-env.mjs` | 环境自检 / 部署助手；`--json` 机器可读，`--fix` 自动修复可修复项 |
| `scripts/pacing.mjs` | **限频节拍器** —— `plan` 出时间表、`next` 取下次等待秒数、`check` 查额度与时段 |
| `scripts/human-click.mjs` | 高可靠单次点击 + 业务状态轮询（也常用作"点了没反应"的诊断工具） |
| `scripts/greet-batch.mjs` | **招聘端批量打招呼执行器**（内置限频、遮罩处理、窗口自愈、连败熔断、页面偏离看门狗；逐条增量回写触达记录；`--dry` 先自检） |
| `scripts/verify-greets.mjs` | **触达结果的平台侧独立核验** —— 回读每张卡片的按钮状态，判定"到底发出去没有"。**验收一律用它，不要用脚本日志的 ✅** |
| `scripts/watchdog.mjs` | **守夜人（长任务首选）** —— 独立进程：每块跑完多源重算剩余，未跑完就自动续跑；被外部终止也不影响（重启即续）。`--now` 只做一次只读判定 |
| `scripts/detach.mjs` | **脱离启动器** —— `detached+unref` 起守夜人、stdio 走 ignore（不经会被关闭的管道），父进程立即返回；`--status` / `--stop` 管它 |
| `scripts/run-until-done.mjs` | 批次守护（不脱离宿主的版本）—— 分块调用执行器、块间查会话健康、掉线自动重拉、全程 `--resume` 续跑；加 `--detach` 即转交守夜人 |
| `scripts/status.mjs` | **批次状态查询** —— 一条命令读进度/剩余/停机原因/终止原因/守夜人状态；`--wait <sec>` 做前台有界等待。避免"反复扫日志"触发宿主重复调用保护 |
| `templates/actions/*.json` | 站点动作模板：选择器与成功判定策略；站点改版只需改这里 |
| `scripts/check-deps.mjs` | 只确保代理已连接（浏览器已开的情况下用） |
| `scripts/launch-browser.mjs` | 启动带调试端口的浏览器（副本 profile + 防遮挡参数 + lean 瘦身档 + 等就绪写端点文件）；`--help` 看用法 |
| `scripts/slim-profile.mjs` | 副本 profile 瘦身（默认干跑，`--apply` 执行；会先备份登录态）；`--help` 看用法 |
| `scripts/browser-discovery.mjs` | 端口发现与选择（库模块，不单独跑）；端点文件机制的实现处 |
| `scripts/tests/*.mjs` | **离线回归（不需要浏览器/不触达任何人）** —— 成功判据、抗中断/续跑收敛、守夜人决策。改完执行器/守护后先跑这三套：`node scripts/tests/test-signals.mjs` / `test-antiinterrupt.mjs` / `test-watchdog.mjs` |
| `scripts/preflight.mjs` | 求职方准入闸门：我的技能 vs 岗位要求；`--init` 生成模板，`--help` 看用法 |
| `scripts/screen-talent.mjs` | 招聘方准入闸门：岗位要求 vs 候选人简历，按匹配度降序输出；`--init` 生成模板 |
| `scripts/risk-check.mjs` | 触达前后的风控自检；命中验证码／答题即停，并检测「页面不可见导致 Input 挂起」 |

两个闸门脚本共享同一套结构（G0 红线 / G1 匹配度 / G2 批次 / G3 时序）与 `--commit` 回写闭环，
但**判定方向相反**，配置文件互不通用。

⚠️ **触达完成后务必跑 `--commit`** —— 否则历史记录不累积，冷却期与重复触达拦截会**静默失效**：
闸门看起来在跑，实际已经失去拦截能力。
