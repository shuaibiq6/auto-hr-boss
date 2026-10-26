---
title: 环境要求与部署
updated: 2026-09-30
audience: 首次把本 skill 部署到一台新机器的使用者
---

# 环境要求与部署

本 skill 是**零第三方依赖**的（只用 Node 内置模块，不需要 `npm install`）。
把整个 `boss-hr-outreach-safe/` 目录拷到新机器后，按下面三步即可使用。

---

## 1. 硬性要求

| 项 | 要求 | 为什么 |
|---|---|---|
| 操作系统 | Windows 10+ / macOS 12+ / Linux（x64 或 arm64） | CDP 代理只适配这三类平台的浏览器路径与进程管理 |
| **Node.js** | **≥ 22**（必需，非建议） | 用到原生 `WebSocket`、`fetch`、`AbortSignal.timeout`。Node 20 及以下**无法运行**，且本 skill 刻意不引入 `ws` 等 npm 包（换取"拷贝即用"） |
| 浏览器 | Microsoft Edge 或 Google Chrome（Chromium 内核，桌面版） | 通过 CDP 直连，天然携带登录态 |
| 网络 | 能访问目标站点即可；localhost 回环必须可用 | 代理监听 `127.0.0.1:3456`，浏览器调试端口默认 `127.0.0.1:9222` |
| 磁盘 | ≥ 200 MB 空闲 | 浏览器副本用户数据目录 |
| 权限 | 对 skill 目录有**写权限**；不需要管理员/root | 要写 `config.env`、端点文件、日志 |

> **不需要**：Python、npm、Docker、管理员权限、任何系统级服务安装。

### Node 版本速查

```bash
node -v        # 需要 v22.x 或更高
```

若版本不足，推荐用 fnm / nvm 安装 Node 22 LTS，不要动系统自带的旧版本：

```bash
# Windows（winget）
winget install OpenJS.NodeJS.LTS
# macOS（Homebrew）
brew install node@22
# 通用：下载 LTS 安装包 https://nodejs.org/
```

---

## 2. 部署三步

### 第 1 步：自检

```bash
cd <解压后的目录>/boss-hr-outreach-safe
node scripts/setup-env.mjs
```

输出示例（全绿即可继续）：

```
✓ [OK  ] Node.js v22.22.2
✓ [OK  ] 第三方依赖：无
✓ [OK  ] 浏览器：检测到 Microsoft Edge
✓ [OK  ] 副本用户目录可写
✓ [OK  ] skill 目录可写
✓ [OK  ] 端口 3456：空闲
```

退出码含义：`0` 全绿 / `2` 有需确认项（如未设浏览器偏好）/ `1` 有阻塞项。

- 加 `--fix`：自动建目录、从模板生成 `config.env`、清理过期端点文件。
- 加 `--json`：输出机器可读报告（供上层 Agent 解析）。
- 单项 FAIL 时，报告里会直接给出解决指引。

### 第 2 步：拉起会话

```bash
node scripts/start-session.mjs \
  --url https://www.zhipin.com/web/chat/recommend \
  --page-match zhipin.com \
  --tid-out ./_tid.txt
```

这一步会依次完成「按调试端口清掉旧浏览器进程 → 启动带调试端口的浏览器 → 等待 CDP 就绪 → 启动代理 → 定位目标标签页」，
全部正常在 **5–10 秒**内跑完，并把目标标签页 id 写入 `_tid.txt`。

> **关键：登录态不随压缩包迁移。**
> 这一步启动的是**本机的**浏览器副本 profile，新机器上是全新环境。
> 第一次使用需要在该窗口里**手动登录目标站点**（登录后 profile 会被复用，下次不用重登）。
> 这是设计使然——我们不会、也无法替你把登录凭据复制到另一台机器。

### 第 3 步：验证

```bash
node scripts/human-click.mjs --selector "body" --json
```

能返回 `"ok": true` 就说明整条链路（浏览器 → 代理 → 输入域）通畅。

随后按 [`SKILL.md`](../SKILL.md) 里的业务流程操作。

---

## 3. 端口

| 端口 | 用途 | 冲突时 |
|---|---|---|
| 3456 | CDP 代理（HTTP API） | 改环境变量 `CDP_PROXY_PORT`，或先停掉占用进程 |
| 9222 | 浏览器调试端口 | 用 `start-session.mjs --port <其它>`；代理会自动发现 |

代理是**长驻进程**，检测到已运行会直接复用（启动成本 0）。切换浏览器时需要重启代理：

```bash
# macOS / Linux
pkill -f cdp-proxy.mjs
# Windows（Git Bash / PowerShell 均可）
MSYS_NO_PATHCONV=1 taskkill /F /PID $(netstat -ano | grep LISTENING | grep ":3456" | awk '{print $5}' | head -1)
```

---

## 4. 每个机器独立的东西（不要试图共享）

| 路径 | 说明 |
|---|---|
| `%LOCALAPPDATA%\<Edge\|Chrome>CDP\` | 浏览器副本 profile，含登录态。**每台机器独立** |
| `%LOCALAPPDATA%\<Edge\|Chrome>CDP\.cdp-endpoint.json` | 运行时端点文件（含实例 UUID，每次启动都变）。**不要拷** |
| `config.env` | 本机偏好（用哪个浏览器）。可以从模板重新生成 |
| `*.log` / `screen.*.json` / `_tid.txt` | 运行时产物，**不要拷** |

打包交接时只拷 skill 目录本身即可；`config.env` 即使带上也会在自检时按本机情况重新评估。

---

## 5. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `node: command not found` | 没装 Node 或不在 PATH | 装 Node 22+，重开终端 |
| `SyntaxError` / `WebSocket is not defined` | Node < 22 | 升到 22+ |
| `browser: 未连接 — 没有任何浏览器打开远程调试开关` | 没启动带调试端口的浏览器 | 跑 `start-session.mjs`，不要手敲启动命令 |
| 启动后 `/clickHuman`、`/mouseMove` 永久挂起，`/eval` 却正常 | 窗口被最小化或被其它窗口完全遮挡（Chromium 节流渲染器） | 执行 `/restore-window?target=<id>&all=1`；启动参数已默认带防遮挡开关 |
| 点击返回 `clicked:true` 但页面无反应 | 被全屏遮罩吞掉 | 改用 `/clickSafe`（内置命中测试与自动关遮罩）；见 SKILL.md「点击≠业务生效」 |
| `连接超时（轮询 36s）` | 浏览器有远程调试授权弹窗未点「允许」 | 在浏览器窗口点「允许」；或检查 9222 是否被别的程序占用 |
| 端口 3456 被占 | 上次代理没退干净 | 按上面第 3 节重启代理 |
| 浏览器能开但 profile 目录报权限错 | skill 放在了 `Program Files` 等受保护目录 | 把 skill 移到用户目录下（如 `~/.workbuddy/skills/`） |

排查时先把 `setup-env.mjs` 的输出附上，它能覆盖九成环境问题。

---

## 6. 最小交付清单

打包给他人时，以下文件必须齐全（缺一不可）：

```
boss-hr-outreach-safe/
├── SKILL.md                              # 能力与流程说明（Agent 入口）
├── README.md                             # 快速上手
├── config.env 或 templates/config.env.template
├── scripts/
│   ├── setup-env.mjs                     # 环境自检
│   ├── start-session.mjs                 # 一键拉起
│   ├── cdp-proxy.mjs                     # 代理（核心）
│   ├── browser-discovery.mjs             # 端口发现
│   ├── launch-browser.mjs                # 启动浏览器
│   ├── pacing.mjs                        # 限频节拍器（含 hr150 档）
│   ├── human-click.mjs                   # 可靠点击
│   ├── greet-batch.mjs                   # 批量打招呼执行器
│   ├── check-deps.mjs / screen-talent.mjs / risk-check.mjs / preflight.mjs
│   ├── slim-profile.mjs / find-url.mjs / match-site.mjs
├── references/                            # 站点经验与风险模型
│   ├── environment-setup.md               # 本文件
│   ├── pacing-policy.md
│   ├── hr-daily-150-plan.md               # 日 150 排班与窗口反推
│   ├── site-patterns/
│   └── talent-outreach.md / recruiter-perspective.md / cdp-api.md
└── templates/
    ├── config.env.template
    └── actions/zhipin-boss-greet.json     # 动作模板
```

不需要打包：`node_modules`（没有）、`*.log`、`_tid.txt`、任何 `screen.*.json`。
