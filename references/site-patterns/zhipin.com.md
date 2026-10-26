---
domain: zhipin.com
aliases: [BOSS直聘, BOSS, boss直聘]
updated: 2026-09-29
---

## 平台特征

- 求职者端为 Vue SPA，路由前缀 `/web/geek/`。搜索结果页实际 URL 是 `/web/geek/jobs`（不是 `job`）。
- 强反爬：页面会主动探测本机 Chrome 调试端口（向 `127.0.0.1:9222` 发起 WebSocket）。用 `--remote-debugging-port` 启动时必须加 `--remote-allow-origins=*`，否则该探测与 Proxy 的握手都会被拒。cdp-proxy 已内置对 `Fetch.requestPaused` 的拦截。
- 登录态完全依赖 Cookie，profile 复制可保留登录（实测 2026-09-29 有效）。
- 薪资数字用自定义字体渲染，`innerText` 取到的整数位会丢失（显示成 `-K`）；`.job-salary` 的 `textContent` 能取到完整值（如 `150-180元/天`）。

## 有效模式

**列表页 URL（已验证）**

```
https://www.zhipin.com/web/geek/jobs?city=101180100&jobType=1902
```

- `city=101180100` → 郑州
- `query=<关键词>` → 搜索词，可直接中文
- `jobType` → 求职类型：`1901`=全职，`1902`=实习，`1903`=兼职
- `experience` → 工作经验：`108`=在校生，`102`=应届生，`101`=经验不限，`103`=1年以内
- 组合示例：`?city=101180100&jobType=1902` 取郑州全部实习岗；`?city=101180100&experience=102` 取郑州应届（秋招）岗

筛选下拉项的 `ka` 属性即参数值，如 `[ka="sel-job-rec-jobType-1902"]`、`[ka="sel-job-rec-exp-108"]`，可直接 click。

**列表页选择器**

- 卡片：`li.job-card-box`（首屏 15 条，`/scroll?direction=bottom` 可触发加载更多）
- 职位名/详情链接：`a.job-name`（href 形如 `/job_detail/<id>.html`）
- 薪资：`.job-salary`
- 标签：`ul.tag-list li`（工作经验/学历/技能）
- 卡片内名字：`.boss-name` —— **语义不稳定**，有时是公司名有时是 HR 名，不可当作公司字段使用
- 地区：`.company-location`
- 公司主页：`a.boss-info[href*='gongsi']`

**详情页选择器**

- 职位名：`.job-banner .name h1`
- 薪资：`.job-banner .salary`
- 公司信息：`.sider-company`（含公司名、融资/上市状态、规模、行业）
- HR + 公司 + 头衔：`.job-boss-info` / `.boss-info`，格式为 `名字 活跃状态 公司 · 头衔`
- 备注：`.company-info` 在详情页拿到的仍是职位标题，不是公司名，别用

**投递（打招呼）**

- 按钮：`.btn.btn-startchat`
- 点击前 `innerText` = `立即沟通`；点击成功后变 `继续沟通` —— 可直接用这个变化判断是否投递成功
- 默认招呼语由平台自动发送，内容为：
  `您好，我非常希望能够得到这个岗位的面试机会，如果岗位还有空缺，希望能得到机会，感谢。`
- 成功后在 `/web/geek/chat` 的会话列表（`.user-list li`）可见 `[送达]` 状态

## 已知陷阱

- （2026-09-29）`/new` 打开 `/web/geek/job?` 会被 302 到 `/web/geek/jobs?`，直接写 `jobs` 更稳。
- （2026-09-29）点击筛选下拉：用 `el.click()` 可以打开，但下拉在关闭状态下 `innerText` 为空，读选项要用 `textContent`。
- （2026-09-29）列表页是懒加载 + 虚拟滚动，不滚动就最多只有 15 条。
- （2026-09-29）投递有频控。曾实测「每岗间隔 ~13s、连续投 10 家」未触发任何拦截——但这只是**未被拦截**，
  不构成「可以这样投」的许可：该节奏在算法侧（自相关分析）与 HR 侧（时间聚集）都留下了明显机器特征。
  频率约束以 [`recruiter-perspective.md`](../recruiter-perspective.md) 的原则和 `scripts/preflight.mjs` 的闸门为准，不以「上次没被抓」为参考。

---

## 风控画像（2026-09-29 逆向 `zpAegis` 得到，证据级）

站点每页都加载自研风控 SDK，全局变量 `window.zpAegis`：

- `https://www.zhipin.com/zhipin-security/web/geek/index.js`
- `https://static.zhipin.com/zhipin-geek/security/121/geek/index.js`（版本号会递增）
- 另有全局 `getsec`、`VerifyCodeSDK`、`getTraceId`

该 SDK 字符串经 obfuscator.io 自定义字符表 base64 混淆。**解码方式**（可复用）：
自定义表 `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/`
→ 逐字符换成标准表 `ABC…XYZabc…xyz0123456789+/` → 补 `=` 到 4 的倍数 → `base64.b64decode`。
（脚本见本仓库外的 `zhipin/decode_sec.py`）

### 已确认采集的行为信号（解码后的真实字符串常量）

| 类别 | 字符串常量 | 含义 |
|---|---|---|
| 事件可信度 | `isTrusted` | 检测事件是否为真实用户产生 |
| 点击埋点 | `web-event-click` `onClick` `getClickObj` `clickTime` `clickedGeekItem(+Timer)` `clickedPhrase(+Timer)` `CLICK_GEEK` `CLICK_PHRASE` `CLICK_EXCHANGE` `CLICK_RESUME` `CLICK_FINGERPRINT` `CLICK_CHAT_EDITOR` `CLICK_EMOJI` `CLICK_REEDIT` | 分类型点击追踪 + 计时 |
| 鼠标轨迹 | `mousemove` `mousedown` `mouseup` `mouseenter` `mouseleave` `MOUSE_ENTER` `MOUSE_LEAVE` `web-event-move` | 轨迹采集 |
| 键盘节奏 | `keydown` `keyup` `keyCode` `shiftKey` `ctrlKey` `metaKey` `keyboardRhythm` `keyboardPairs` `pairKeys` `keydownRecords` `fnkeytime` `pastekeytime` `lastKeyboard` | 击键节奏/按键配对分析 |
| 异常判定 | `abnormal_keyboard` `abnormal_keyboard_2` `isAutomated` **`autocorrelation` `autocorrelationAnomaly` `autocorrelationLag1`** | **自相关分析**：对行为时间序列做统计检验，人类随机、脚本规律 |
| 输入/粘贴 | `InputTracker` `initTypingTracker` `report_input` `report_paste` `reportTyping` `KEYBOARD_PASTE` `AB_KEYBOARD_PASTE(+_2)` `RIGHT_CLICK_PASTE` | 输入与粘贴行为上报 |
| 本地探测 | **`reportSuspiciousProcess`** `reportUnknownProcess` `reportProcessInfo` `reportNormalOpt` `showModalDialog` `setLocalDescription` | 可疑/未知进程上报（端口探测、WebRTC 内网探测等） |
| 设备指纹 | `canvas` `experimental-webgl` `WEBGL_debug_renderer_info` `UNMASKED_VENDOR_WEBGL` `UNMASKED_RENDERER_WEBGL` `application/gameplugin` `application/360softmgrplugin` `application/mozilla-npqihooquicklogin` | Canvas/WebGL 渲染器 + 本机软件插件枚举 |
| 上报通道 | `device-action-report`、`https://apm-fe.zhipin.com/wapi/zpApm/actionLog/fe/ie/common.json`、`appKey: MeT5lsyaHisySUCH`、`_SECURE_LOG` | |

关键 DOM 埋点选择器：`.chat-op>.btn-send`、`.phrase-send`（发消息/发招呼语时会打点）。

### 对 CDP 自动化的直接威胁

1. **`el.click()` 的 `isTrusted === false`** —— 最硬的破绽。SDK 明确检测这个字段。
2. **点击无配套事件链**：只有 `click`，缺 `mousemove → mouseenter → mousedown → mouseup`，`clickTime` / `keyboardRhythm` 为空。
3. **`autocorrelationAnomaly`**：连续动作的间隔若呈现规律性（等间隔、低方差），统计上会被判为机器。
4. **`reportSuspiciousProcess`**：`--remote-debugging-port=9222` 监听在 127.0.0.1，是典型的可疑本地端口；要尽量不长期开放。
5. **`outerWidth/outerHeight === 0`**：实测在后台/最小化启动的实例上会出现，属异常窗口特征。

### 低暴露操作模式（推荐默认）

- 单日投递 **≤ 15–20 次**，分散到不同时段，**禁止几分钟内连发 10 条**（2026-09-29 实测曾 15:01–15:05 连发 10 条，密度过高）。
- 每次投递之间 **随机 30–180s**；投递前先滚详情页、停留 20–60s，制造阅读行为。
- 用 CDP 原生输入派发交互，**不要用 `el.click()` / `window.scrollBy`**：
  - `POST /clickHuman?target=<tid>` body=CSS 选择器 → 6 段渐近 mouseMoved + mousePressed + mouseReleased，全部 trusted
  - `GET /mouseMove?target=<tid>&steps=8` → 派发 trusted 随机鼠标移动
  - `GET /wheel?target=<tid>&dy=420&steps=2[&to=bottom]` → 派发 trusted 滚轮事件
  - `GET /focus?target=<tid>` → 前置窗口并激活 tab（**Input 事件挂起时必须先调**）
  （这些端点是 2026-09-29 为配合本站风控新增进 `cdp-proxy.mjs` 的）
- ⚠️ **必须先确认页面可见**：Node 自动化窗口若被最小化或 tab 被切走，
  `visibilityState=hidden` / `outerWidth=0` 会让 `Input` 域命令（点击/滚轮）永久挂起，而 `/eval` 却一切正常。
  `/clickHuman`、`/mouseMove`、`/wheel` 已内置自动唤醒；排查与原理见 SKILL.md「页面不可见时 Input 域命令会永久挂起」。
- 点击前先用 `/eval` 给目标按钮打唯一标记再点（标记与点击**必须在同一个命令内完成**，
  Vue 重渲染会清掉自定义属性，跨调用会丢）：
  ```js
  const btns=[...document.querySelectorAll(".btn-startchat")].filter(b=>b.offsetParent!==null);
  const t=btns.find(b=>b.innerText.includes("立即沟通"))||btns[0];
  t.setAttribute("data-agent-target","1"); // 然后 clickHuman 传 [data-agent-target="1"]
  ```
- 出现验证码/滑块/短信验证 → **立即停手**，当天不要再投。
  ⚠️ 自检必须**带尺寸判断**，否则必然误报：`[class*=slider]` 会命中首页轮播组件 `.omnibus-slider-main`，
  `[class*=verify]` 会命中无关文案（2026-09-29 实际踩过，导致首次投递被误判为风控拦截）。
  推荐选择器（命中条件：`offsetWidth > 40 && offsetHeight > 30`）：
  `[class*=captcha-wrap]` `[class*=captcha-box]` `.uc-figure` `.geetest_panel` `.geetest_widget`
  `[class*=verify-bar]` `[class*=verify-slide]` `.nc_wrapper` `.bcap-wrapper`
  再叠加正文关键词：`安全验证 / 请完成验证 / 操作过于频繁 / 账号异常 / 访问受限 / 行为异常 / 请稍后再试 / 拖动滑块 / 系统检测到`。
  可直接复用 `zhipin/risk.js`（本仓库外的任务目录），或按上述规则重写。
- 观察账号信号的入口：`/web/geek/chat` 会话列表若消息**不再显示 `[送达]`**（被静默拦截），说明已进风控观察名单。
- 账号体检页：`/web/geek/account?type=home`（"您有 N 个安全建议"是绑定手机/实名类提示，**不是处罚**）；规则页 `/web/geek/rule-center`。

### ⚠️ 打招呼语无法在 web 端轮换（2026-09-29 确认）

- 点击「立即沟通」时，平台**自动发送账号级预设的打招呼语**，web 端发消息前无法改写。
- 找遍 web 端**没有**「打招呼语」设置入口：`/web/geek/account?type=home` 只有账号管理/权限管理/身份验证/个人信息/登录设备；
  `/web/geek/chat` 的「更多」下拉只是筛选器（有交换/有面试/不感兴趣）。
- 结论：**该设置只在 BOSS 直聘 APP 端**。想做到"每条招呼语不同"，只能改账号设置（或换 APP），
  而在一轮投递中反复改设置本身也是异常信号 → 实践中保持默认文本、靠**降频 + 拉开间隔 + 降低单日总量**来控制风险更划算。
- `/web/geek/chat` 里已有会话之间也无法改写已发出的招呼语。

### 实测结论（2026-09-29 第一轮，密集模式）

连发 10 条默认招呼语后：账号**无警告、无验证码、10 条全部 `[送达]`**，会话列表 unread=0，页面无任何 `异常/风险/限制` 关键词，`navigator.webdriver === false`（未加 `--enable-automation`）。
→ 该量级**未越过处置阈值**，但技术上的自动化特征已被充分记录。

### 实测结论（2026-09-29 第二轮，低暴露模式）

15:18 用户手动追加 1 家（中森云科）后，agent 用低暴露模式再投 5 家，**全部 `[送达]`**：
天迈科技(AI智能体应用工程师)、超聚变技术(AI工程师实习)、郑州迦云科技(AI智能体开发)、
河南紫承昭科技(agent开发工程师)、凡诺(大模型应用开发工程师)。

流程：navigate → `mouseMove` ×2 + `wheel` ×3 + 兜底滚动 → 停留 22–40s → 风控自检 →
`[data-agent-target]` 标记 → `clickHuman` 可信点击 → 校验按钮变 `继续沟通` → 间隔 50–80s。
手机端节奏 ≈ 每户 1.5–2 分钟，5 户约 9 分钟。

结果：5/5 送达；河南紫承昭的 HR **当场已读**；期间还收到 2 条 HR 主动邀约（八零爱梯、扫地僧）；
账号无警告、无验证码、账号安全中心无处罚项。日志见 `zhipin/apply_low.log`。

---

## 招聘方视角与投递合规闸门（2026-09-29 增补）

> 跨平台通用原则见 [`../recruiter-perspective.md`](../recruiter-perspective.md)。
> 本节只记录 BOSS 直聘特有的、会实际影响账号权益的事实。

### 站在 HR 那一侧：五个会掉权益的动作

| HR 的动作 | 触发门槛 | 对账号的后果 |
|---|---|---|
| **标记「不合适」** | 极低——觉得不对口就点一下 | **系统降低该账号的推荐权重**，静默生效、无通知 |
| 删除会话 / 不感兴趣 | 极低 | 影响在该公司的可见度 |
| **拉黑** | 中——觉得被骚扰或反复无效沟通 | 无法再发消息；系统通常不再向同类 HR 推荐该简历 |
| **批量拉黑** | HR 集中筛选简历时的效率工具 | 一次拉一批。群发感明显的候选人最容易进这一批 |
| 举报 | 高——明确越界 | 进入平台审核链路 |

- HR 端拉黑有三条路径：**聊天界面右上角「更多」／求职者个人主页／消息中心批量多选**。
  （来源：HR SaaS 厂商博客，二手，2026-09-29 读取；多篇描述一致）
- 「标记不合适 → 降低推荐权重」来源为第三方 HR 工具与问答平台的一致描述（二手，2026-09-29 读取），
  未见平台官方原文，但与产品逻辑自洽，采信度中等。
- **企业侧还有简历过滤**（按年龄、经验等条件设阈值）。被过滤掉的投递不产生投诉，但也不产生任何结果——
  纯粹的无效消耗，同样是「匹配度闸门」要拦的东西。

### 官方协议里的两条硬约束

`about.zhipin.com` 用户协议（一手，2026-09-29 读取）明确禁止：

1. **第三方工具接入**：不得「未经 BOSS 直聘公司许可，使用插件、外挂或通过其他第三方工具、运营平台或任何服务接入本服务或系统获取相关数据或信息」。
2. **规避功能限制**：不得「违反本平台的功能限制或运营策略，或采取任何措施规避前述流程、规则、限制或策略」。

这两条直接覆盖 CDP 自动化投递。关键含义：**这不是「只要不被检测到就合规」，而是协议层面已构成违约**，
平台在需要时（纠纷、抽查、配合监管）即有处置依据。

→ 因此：**永远不要向用户把自动化投递描述成「安全」或「合规」。**
准确表述是「技术上未被识别 + 行为上未产生投诉 + 因此尚未触发处置」——这是三个独立的东西，不能合并成一句「没问题」。

### 处置阶梯：第一档不是封号

平台对账号的处置是分级的（来源：BOSS 直聘平台治理公报，中国电子商会转载，二手，2022Q1 数据）：

1. **下发答题 + 限制使用功能（禁言）**——针对轻微违规或不文明行为。公报称约 80% 的适用违规行为，
   通过一次答题 + 禁言限制即可终止。
2. **冻结账号**——情节严重或多轮累积。
3. **长期 / 永久冻结**——严重违规、身份信息不实、公司账号连带等。

**实操关键：把「被要求答题」当作比验证码更高优先级的停手信号。**
验证码可能只是常规人机校验；答题是**已经判定违规之后的处置动作**。见到即停止当天全部操作，并降低后续强度。

### 已知的账号冻结诱因（对求职者侧）

- **短时大量发消息 / 投简历**——被明确列为冻结原因之一（第三方问答平台，二手）。
- 频繁更换设备登录、自动化工具操作、滥用举报功能、恶意刷屏。

### 本站在闸门里的配置要点

用 `scripts/preflight.mjs` 跑本站时：

- `excludeKeywords` 必配：`销售 / 客服 / 外包 / 派遣 / 培训 / 招生 / 带货 / 主播 / 地推 / 运营 / 电销 / 刷单 / 投放`。
  该站大量技术岗标题被销售与运营岗占位——实测检索「AI应用」的结果里过半是电商投放或运营岗。
- ⚠️ **`salary` 字段的坑会让闸门失效**：薪资用自定义字体渲染，`innerText` 会丢整数位（显示成 `-K`）；
  必须取 `.job-salary` 的 `textContent`（如 `200-250元/天`），否则薪资闸门拿到的是空值。
- **两轮跑法**：列表页数据只有 title/tags，信息量不足，跑出来会有大量 `REVIEW`。正确顺序是
  ① 用列表页数据跑一遍 → ② 对 `REVIEW` 项逐个打开详情页读 JD 正文 → ③ 用补全后的数据再跑一遍 → ④ 执行 `accepted`。
  **不要凭列表页标题直接投**——标题党会让匹配判断偏掉一个档位（实测「AI 智能体搭建师」实为电商投放岗）。
- 闸门参数建议：`dailyMax` ≤ 12、`perDirectionMax` ≤ 5、`minGapSeconds` ≥ 45、`repeatCompanyCooldownDays` = 30。

### 招呼语轮换受平台限制，风险改用总量与接续补偿

本站 web 端无法在发送前改写打招呼语（见上节）。这意味着「文本完全相同」这条群发信号
**无法在发送环节消除**，只能靠两件事补偿：

1. **压低单日总量 + 拉大间隔**（减少同一 HR 在短时间内看到重复文本的概率）。
2. **收到回复后，第一条由自己发出的消息必须针对该 JD 写**——引用对方 JD 里的具体技术点，
   给出简历中的对应项目。这是把「群发嫌疑」洗掉的唯一有效动作，也是转化率最高的一步。

### 跨日记录

`preflight.history.json` 必须**跨日累积**，它承担三个作用：同公司冷却（默认 30 天）、重复岗位拦截、单日额度计数。
每次投递完成后把当日实际投递追加进去。

