# boss-hr-outreach MCP

把 `boss-hr-outreach-safe` 引擎（`scripts/`，~7,500 行，**一行不改**）以「薄壳包装」（重构方案 A）暴露为标准 MCP 服务：12 个 `boss_` 工具 + 15+ Resources + 4 Prompts。零第三方依赖，Node ≥ 22 即可运行。

> **合规与风险声明（三条独立事实，INV-28）**
> 本工具的「安全」是**工程意义上的稳定可靠**，不是合规意义上的「平台不会封号」。当前可陈述的事实只有三条：**技术上未被识别 + 行为上未产生投诉 + 因此尚未触发处置**——这三条是彼此独立的，任何一条都不能推出另一条。
>
> **风险披露（INV-29）**
> 温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。

## 目录

```
mcp/
  server.mjs            MCP stdio 服务端（协议层：JSON-RPC 分发 / 取消 / 能力端点）
  transport.mjs         stdio 传输层（换行分隔 JSON 帧，兼容历史 Content-Length）
  lib.mjs               共享基础设施（日志纪律/状态根/spawn/跨进程文件锁/错误码）
  state.mjs             Job 模型 + 状态投影 + 熔断/触达/plan 存取 + dry 凭证
  engine-adapter.mjs    引擎导出契约集中适配（启动期断言，工具从这里取引擎导出）
  proxy.mjs             CDP 代理 HTTP 客户端
  resources.js          boss:// Resources
  prompts.js            4 个剧本
  tools/
    env-session.mjs     boss_env_check / boss_session_start / boss_session_health
    browser.mjs         boss_browser
    pacing-risk.mjs     boss_pacing / boss_risk_check
    screen.mjs          boss_screen_talent
    greet-start.mjs     boss_greet_start（强制点 #1–#7/#9）
    greet-lifecycle.mjs boss_greet_status / boss_greet_stop / boss_greet_verify
    history.mjs         boss_history
    index.mjs           组装
  test/run-tests.mjs    离线契约/单元测试
  package.json
  mcp.example.json      客户端配置片段
```

## 部署

1. 前置：Node ≥ 22，Microsoft Edge 或 Chrome（引擎会自检，见 `boss_env_check`）。
2. 状态根目录：默认 `%USERPROFILE%\.boss-hr-outreach`（可用 `BOSS_MCP_HOME` 覆盖）。首次运行自动创建。
3. 客户端配置（Claude Desktop / 任意 MCP 客户端）——`args` 用本机**实际解压后的绝对路径**，不要照抄示例：

```json
{
  "mcpServers": {
    "boss-hr-outreach": {
      "command": "node",
      "args": ["<引擎解压后的绝对路径>/boss-hr-outreach-safe/mcp/server.mjs"],
      "env": { "BOSS_MCP_HOME": "C:/Users/<你>/.boss-hr-outreach" }
    }
  }
}
```

> 路径写错时，`server.mjs` 启动会直接报「引擎位置错误」并给出期望的 `ENGINE_ROOT`，不会静默失败。

4. 运行自检：`node test/run-tests.mjs`（离线，不启动浏览器、不触达）。

## 12 个工具

| 工具 | 作用 | 预算 |
|---|---|---|
| `boss_env_check` | 环境自检（Node/浏览器/目录） | MEDIUM |
| `boss_session_start` | 拉起/复用 浏览器+代理+目标页 | MEDIUM |
| `boss_session_health` | 会话健康 + 风控探针（deep） | FAST |
| `boss_browser` | 通用浏览器操作（17 种 op，已移除 navigate） | FAST |
| `boss_pacing` | 限频节拍器（纯计算） | FAST |
| `boss_risk_check` | 页面风控探针（BLOCK→写熔断） | MEDIUM |
| `boss_screen_talent` | 招聘端准入闸门 | MEDIUM |
| `boss_greet_start` | 启动批量打招呼 Job（立即返回） | FAST |
| `boss_greet_status` | 查询 Job 状态/进度 | FAST |
| `boss_greet_stop` | 停止 Job | FAST |
| `boss_greet_verify` | 平台侧独立核验（验收唯一依据） | MEDIUM |
| `boss_history` | 读取/回写全局触达记录 | FAST |

**推荐闭环**：`env_check → session_start → session_health(deep) → screen_talent → greet_start(dry) → status → greet_start(live) → 轮询 status → verify → history`

## 安全强制点（Server 端，不可绕过）

1. `mode` 必填（dry/live，无默认值）
2. 当日熔断开 → 拒绝一切 live（fail-closed，无 bypass 参数）
3. 账号级互斥：活动 live job 唯一（dry 不参与）
4. 额度+时段闸门（live 必过 `pacing.gate`）
5. 触达记录交叉去重（全局 touch + `--resume`）
6. 白名单校验（profile/chunk≤10/limit≤150）
7. `respect_window` 默认关（连续跑完、跨午休不中断；开=守窗口边界停机）
8. 风控信号 → 写 breaker + 状态置 blocked
9. 触达记录自动回写（`--commit` 恒开）
10. 结果以 `verify` 为准（状态中暴露 verify）
11. live 前置体检：本批必须先 dry 演练通过（当日凭证，否则 `E_DRY_REQUIRED`）

引擎自身护栏（GAP 60–300s、clickSafe、连败熔断、多源续跑）照常生效——Server 强制点是**叠加**不是替代。

## 状态布局（`BOSS_MCP_HOME`）

```
config.json                      Server 配置
runtime.json / runtime.tid.txt   会话 targetId
history/touch.json               全局触达记录（唯一事实源）
history/breaker.json             当日熔断
history/attest.json              当日 dry/体检凭证（live 前置体检）
jobs/<jobId>/job.json            job 注册表（状态机投影）
jobs/<jobId>/plan.json           冻结名单
jobs/<jobId>/greet.result.json   引擎结果 + .progress/.done/.watchdog.json/.detach.json/.lock
plans/<planId>.json              screen_talent 落盘的 plan
logs/server.log                  Server 日志（stderr 亦同写）
```

## 范围边界（明确不做）

- 不实现任何验证码/答题绕过（RSK-05，永久排除）
- 不点击「不再显示 / 不再提示」类按钮（INV-30）
- 不迁移/打包登录凭证（INV-17）
- 自动化止于「发送招呼」，不做对话自动化（INV-18）
- 风险信号即停，fail-closed（INV-09）
