# BOSS 招聘触达 · 安全版（boss-hr-outreach-safe）

通过 CDP（Chrome DevTools Protocol）直连你**本机已登录的** Edge / Chrome，用真实浏览器完成需要登录态、
需要交互的联网任务：搜索、抓取、填表、批量操作。

**本包专用于 BOSS 直聘招聘端批量触达（打招呼）**，
默认启用 `hr150` 限频档（日 150 安全排班）。

- **零第三方依赖**：只用 Node 内置模块，拷过来就能用，不需要 `npm install`。
- **不碰你的日常浏览器**：使用独立副本 profile（`%LOCALAPPDATA%\EdgeCDP`），不影响你正在用的窗口和书签。
- **动作是"真人式"的**：鼠标走贝塞尔曲线、非匀速、末段过冲回正；点击前做命中测试，被遮罩挡住不硬点。

---

## 一、三步上手

### 0. 检查环境

需要 **Node.js ≥ 22** 和一个 **Edge / Chrome**。没有 Node 的先去 <https://nodejs.org/> 装 LTS 版。

```bash
node scripts/setup-env.mjs
```

看到「结论：全绿，可直接使用」就可以继续。有 FAIL 项时，报告里会写怎么解决。

### 1. 拉起浏览器会话

```bash
node scripts/start-session.mjs \
  --url https://www.zhipin.com/web/chat/recommend \
  --page-match zhipin.com \
  --tid-out ./_tid.txt
```

正常 5–10 秒跑完。**第一次需要在这个新窗口里手动登录目标网站**（登录态存在本机 profile 里，下次不用重登）。

### 2. 开始干活

交给 Agent，或自己调 HTTP API：

```bash
# 页面信息
curl -s "http://127.0.0.1:3456/info?target=$(cat _tid.txt)"

# 执行 JS
curl -s -X POST "http://127.0.0.1:3456/eval?target=$(cat _tid.txt)" -d 'document.title'

# 高可靠点击（推荐）
curl -s -X POST "http://127.0.0.1:3456/clickSafe?target=$(cat _tid.txt)" -d 'button.submit'
```

---

## 二、常用命令速查

| 想做什么 | 命令 |
|---|---|
| 环境自检 | `node scripts/setup-env.mjs`（`--fix` 自动修复，`--json` 机器可读） |
| 一键拉起会话 | `node scripts/start-session.mjs --url <URL> --page-match <域名> --tid-out ./_tid.txt` |
| 只起代理（浏览器已开） | `node scripts/check-deps.mjs` |
| 看有哪些标签页 | `curl -s http://127.0.0.1:3456/targets` |
| 可靠点击 + 校验 | `node scripts/human-click.mjs --selector "<css>" --verify "<js>"` |
| 生成批量任务的时间表 | `node scripts/pacing.mjs plan --count 30 --profile hr150` |
| 查今日额度与时段 | `node scripts/pacing.mjs check --today 90` |
| 批量打招呼（先演练） | `node scripts/greet-batch.mjs --plan <名单.json> --dry` |
| 批量打招呼（正式） | `node scripts/greet-batch.mjs --plan <名单.json> --touch <记录.json> --commit` |

---

## 三、目录结构

```
boss-hr-outreach-safe/
├── SKILL.md                    # 完整说明（流程、陷阱、API 参考）——建议先读这个
├── README.md                   # 本文件
├── config.env                  # 本机偏好（用哪个浏览器），首次自动生成
├── scripts/
│   ├── setup-env.mjs           # 环境自检 / 部署助手
│   ├── start-session.mjs       # 一键拉起（浏览器 + 代理 + 定位标签页）
│   ├── cdp-proxy.mjs           # CDP 代理（核心，长驻）
│   ├── launch-browser.mjs      # 启动带调试端口的浏览器
│   ├── browser-discovery.mjs   # 调试端口发现（库）
│   ├── pacing.mjs              # 限频节拍器（hr150 为默认档）
│   ├── human-click.mjs         # 高可靠点击 + 业务状态轮询
│   ├── greet-batch.mjs         # 批量打招呼执行器（默认档 hr150）
│   ├── check-deps.mjs          # 前置检查
│   ├── screen-talent.mjs       # 招聘方准入闸门（选谁）
│   ├── preflight.mjs           # 求职方准入闸门
│   ├── risk-check.mjs          # 风控自检
│   ├── slim-profile.mjs        # 副本 profile 瘦身
│   ├── find-url.mjs            # 本地书签/历史检索
│   └── match-site.mjs          # 站点经验匹配
├── references/
│   ├── environment-setup.md    # ★ 环境与部署（新机器必读）
│   ├── pacing-policy.md        # ★ 限频策略（档位、硬边界、窗口反推）
│   ├── hr-daily-150-plan.md    # ★ 招聘端日 150 排班方案（有量指标时必读）
│   ├── cdp-api.md              # CDP API 参考
│   ├── talent-outreach.md      # 招聘方触达风险模型
│   ├── recruiter-perspective.md# 求职方触达风险模型
│   ├── migration-2.5.3.md      # 旧版 API 迁移
│   └── site-patterns/          # 各站点经验（选择器、陷阱）
└── templates/
    ├── config.env.template
    └── actions/                # 站点动作模板（打招呼等）
```

---

## 四、安全须知（必读）

本 skill 用于自动化操作真实网站。**部分站点在协议层面禁止第三方工具接入**，请自行评估使用场景。

需要明确的事实：

- 自动化触达**在多数平台的服务协议下是违规的**。防护措施降低的是被识别的概率，不是消除违规事实。
- 本 skill 内置了限频、准入闸门与风控自检，但**无法保证账号不受处置**。
- 出现**验证码 / 答题 / 「操作频繁」/ 登录失效 / 被拒绝或拉黑**时，请**立即停止当天全部操作**。
  其中「要求答题」优先级最高——那是平台**已判定违规之后**的处置动作。
- 批量触达的对象是**真实的人**。平台处置链路是「接到投诉 → 核实 → 处置」，
  所以首要风险不是算法识别，而是**收件人按下举报**。与其研究伪装，不如提高触达的相关性。

详见 `references/recruiter-perspective.md` 与 `references/talent-outreach.md`。

---

## 五、遇到问题

1. 先跑 `node scripts/setup-env.mjs`，多数环境问题它会直接指出。
2. 点击"没反应"→ 改用 `/clickSafe`（会告诉你是否被遮挡）。
3. 窗口最小化导致命令挂起 → `curl "http://127.0.0.1:3456/restore-window?target=<id>&all=1"`。
4. 其余见 `references/environment-setup.md` 的故障排查表。

---

## 六、MCP 用法（可选）

本仓库附带一个**薄壳 MCP 子包**（`mcp/`），把上面的引擎能力暴露成 12 个 `boss_` 工具 + Resources + Prompts，
供 Claude / 任意 MCP 客户端直接驱动「日 150 触达」闭环（无需 `npm install`，引擎 `scripts/` 一行不改）。

- **接入**：见 [`mcp/README.md`](mcp/README.md) 与 [`mcp/mcp.example.json`](mcp/mcp.example.json)。
- **自检**：`node mcp/test/run-tests.mjs`（离线，不启动浏览器、不触达）。
- **一句话闭环**：`env_check → session_start → session_health(deep) → screen_talent → greet_start(dry) → greet_start(live) → 轮询 status → verify`。
