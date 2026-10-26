---
domain: zhipin.com
aliases: [BOSS直聘, BOSS招聘端, 招聘者端, boss端]
updated: 2026-09-29
scope: 招聘方（招聘者）视角
---

# BOSS 直聘 · 招聘端

> **重要前提**：BOSS 招聘端与求职端共用 `zhipin.com` 域名，但**页面结构、URL 路径、API 完全不同**。
> 本文件中带「待实测」标记的内容**尚未验证**——按 SKILL.md 的要求，未确认的猜测不写入为事实，
> 因此首次执行前**必须先做第 0 节的结构探测**，再把结果回填本文件。

## 0. 首次执行必做：结构探测

招聘端的 DOM 结构与求职端不通用，不要照搬 `zhipin.com.md` 里的选择器。按以下顺序探测一次：

```bash
# 1. 列出当前所有 tab，找到招聘端页面（用户在浏览器里已登录）
curl -s http://localhost:3456/targets

# 2. 读该 tab 的真实 URL 与标题（这是唯一可靠入口，不要凭记忆构造 URL）
curl -s "http://localhost:3456/info?target=<tid>"
```

```bash
# 3. 抓页面结构骨架：自动找出「可重复的列表容器」与「列表项 class」
curl -s -X POST "http://localhost:3456/eval?target=<tid>" -d '
(() => {
  const out = { url: location.href, title: document.title, lists: [], buttons: [] };
  for (const el of document.querySelectorAll("div,ul,section,main")) {
    const kids = [...el.children];
    if (kids.length < 4) continue;
    const cls = kids.map(k => (typeof k.className === "string" ? k.className : "")).filter(Boolean);
    if (!cls.length) continue;
    const first = cls[0].split(" ")[0];
    const same = cls.filter(c => c.includes(first)).length;
    if (same / kids.length >= 0.75) out.lists.push({ containerClass: el.className, itemCount: kids.length, itemClass: first });
  }
  out.lists = out.lists.slice(0, 8);
  for (const b of document.querySelectorAll("button,a[class*=btn],span[class*=btn]")) {
    const t = (b.innerText || "").replace(/\s+/g, "").trim();
    if (t && t.length <= 8) out.buttons.push({ text: t, cls: b.className, visible: b.offsetParent !== null });
  }
  out.buttons = [...new Map(out.buttons.map(b => [b.text + "|" + b.cls, b])).values()].slice(0, 25);
  return JSON.stringify(out);
})()'
```

探测完成后，把真实值回填到第 2 节，并删掉对应的「待实测」标记。

## 1. 平台事实（已在求职端验证，招聘端共用）

以下内容与角色无关，是同平台的事实，可直接采信：

- **用户协议禁止**「第三方工具接入本服务」与「规避平台功能限制」两条。用 CDP 代替人工点击，在**协议层面已构成违约**，与是否被风控识别无关。永远不要把自动化触达描述成"安全"或"合规"。
- **处置阶梯是分级的**，第一档不是封号：
  1. 答题 + 限权（禁言）
  2. 冻结账号
  3. 长期 / 永久冻结
- **「被要求答题」的优先级高于验证码**。验证码可能只是常规人机校验，答题是**已判定违规之后**的处置动作。见到即终止当天全部操作。
- **风控 SDK 检测面**：事件 `isTrusted`、鼠标轨迹自相关、事件链完整性、Canvas/WebGL 指纹。因此点击必须走 `/clickHuman`，不要用 `el.click()`。

## 2. 招聘端结构与机制（2026-09-29 实测）

> **关键结构：招聘端把内容全部放在「同源 iframe」里，顶层文档几乎是空壳。**
> 对顶层 `document` 做 `querySelector` 会一无所获（`body.innerText` 只有 ~85 字符的导航栏）。
> 必须先用 `iframe[src*=...]` 取到 `contentDocument` 再查询，或直接用本 skill 的跨 iframe 选择器
> `frame:<iframe src 片段> ||| <css>`（`/clickHuman`、`/mouseMove`、`/type` 均已支持）。

| 项目 | 实测值 | 说明 |
|---|---|---|
| 招聘端入口 URL | `https://www.zhipin.com/web/chat/recommend` | 推荐牛人。另有 `/web/chat/search`（搜索牛人）、`/web/chat/job/list`（职位管理）、`/web/chat/chat`（沟通） |
| 内容 iframe | `/web/frame/recommend/`、`/web/frame/search/`、`/web/frame/job_v2/list` | 选择器：`iframe[src*="/frame/recommend/"]` 等 |
| 职位绑定 | iframe URL 的 `jobid=` 参数；页面显示在 `.job-selecter-wrap`（推荐页）／`.search-current-job`（搜索页） | **推荐流按职位出人**。`jobid=null` 表示未绑定，必须先切职位 |
| 职位下拉选项 | `.ui-dropmenu-visible .ui-dropmenu-list li:nth-child(N)` | 点击 `.job-selecter-wrap` 展开后再点 `li`；**选项顺序不稳定，须按文本匹配而非固定序号** |
| 候选人列表容器 | `.card-list` | |
| 候选人卡片 | `.card-inner[data-geekid]` | **`.card-inner` 才是单张卡片**；`.card-item` 是**行容器，一行含左右 2 张卡**（踩过：用 `closest('.card-item')` 取字段会让一行两列拿到同一人的数据） |
| 卡片字段选择器 | 姓名 `.name`；**活跃度 `.active-text`**；年龄/经验/学历/状态 `.base-info span`（顺序固定 = [年龄, 经验, 学历, 求职状态]）；工作经历 `.work-exps .content`；期望 `.expect .content`（span[0]=城市, span[1]=期望职位）；标签 `.tag-item`；薪资 `.salary-wrap` | 薪资同样受自定义字体影响，取 `textContent` |
| **`.btn-greet` 不在 `.card-inner` 里**（2026-09-30 复测修正） | 完整链路：`.card-item > .row > .geek-card-small.candidate-card-wrap` → 内含 `.card-inner[data-geekid]`（简历区）**和** `.operate-side > .button-chat-wrap.button-chat > .btn-doc > .button-list > button.btn.btn-greet` | 定位按钮**必须** `inner.closest('.geek-card-small').querySelector('.btn-greet')`；直接对 `.card-inner` 内 `querySelectorAll('button')` 会得到空数组（踩过） |
| 稳定去重键 | `data-geekid`（卡片级，唯一） | 不要用 `data-lid`（搜索页，是位置序号）或 `data-jid`（是批次号，同批全部相同） |
| 「打招呼」按钮 | `button.btn.btn-greet`，初始文本「打招呼」 | 卡片内直接可见（无需 hover）。发送成功后文本变为**「继续沟通」** |
| 发送后的回执弹窗 | iframe 内 `button.btn`（文本「知道了」） | 弹窗正文「已向牛人发送招呼」+ 招呼语预览 + 「不再显示」复选框 |
| 招呼语是否可在 web 端改写 | **不可改写**（实测：点击后无话术选择框，直接发送账号级默认模板） | 实测模板：「你好，我们最近有在招\<职位名\>，你可以看一下职位信息，如果有兴趣，期待你的回复」 |
| 发送成功校验 | 按钮「打招呼」→「继续沟通」，且出现「已向牛人发送招呼」回执；左侧导航「沟通」计数 +1 | 三者任一即可确认 |
| 候选人活跃状态标识 | 卡片头像旁的 `.online-marker` = 当前在线；文本形式「刚刚活跃／3日内活跃」在 `.name` 相邻位置 | 解析逻辑见 `screen-talent.mjs` 的 `activeDays()` |

### 2.1 推荐流的行为特性

- **滚动加载是「追加式」，不是刷新**（2026-09-30 实测）：连续滚动依次得到 31 → 47 → 63 → **111** 张卡，
  与上一批**完全包含**（重合 63/63）。→ 所以**可以在同一会话内把池子滚厚再筛**，把通过人数做够，不必靠"刷新换人"。
  刷新（重载页面 / 重开标签）才会**整批换人**，且换完是有去无回的。
- **⚠️ 滚动要滚"iframe 内部"的滚动条，`/wheel` 打顶层文档是无效的**（2026-09-30 实测踩过）：
  推荐流的可滚动元素是 **recommend iframe 自己的 documentElement**（实测 `scrollHeight=1647 > clientHeight=769`），
  而 `.card-list` 本身 `scrollHeight == clientHeight`（不是滚动容器）。此时 `/wheel?to=bottom` 连续调用
  **卡片数一直是 15 不动**，看上去像"没有更多数据了"，其实一张都没多加载。
  正确做法（实测每步稳定 +16 张）：

  ```js
  const f=[...document.querySelectorAll('iframe')].find(x=>(x.src||'').includes('/frame/recommend/'));
  const w=f.contentWindow, d=f.contentDocument;
  w.scrollTo(0, d.documentElement.scrollHeight);   // 然后等 3–4s 再读卡片数
  ```

  → 用 `/eval` 执行这段、循环若干次，直到卡片数不再增长（本次滚到 255 张，仍未到底）。
  **先确认"滚动确实在生效"（前后卡片数）再下结论说没数据**，否则会把厚池子误判成枯竭。
- **推荐列表每次刷新都会换人**。刷新页面 / 重开标签后，同一职位下的推荐名单与顺序会变化，
  之前看中的候选人可能已不在列表里 → **筛选与触达应在同一会话内连续完成**，不要跨刷新做。
  实测对比：同一职位跨一次重载，255 人里只有 **24 人**与上一批重合。
- **多标签是坑，不要为了"顺便看一眼别的页"多开标签**（2026-09-30 实测）：
  `POST /new` 打开 `https://www.zhipin.com/web/chat/chat` 后出现两个后果——
  ① 新标签代理连不上（`/targets` 里能看到，但 `/info` 返回 `{}`、`/eval` 空响应）；
  ② **原推荐页被顶回首页** `https://www.zhipin.com/`，111 人的列表全丢。
  → 招聘端似乎不支持两个 chat 类页面并存。要查别的页（如「账号权益」）请**串行**做，并接受列表会重载。
- **「账号权益」入口**：导航里的 `.nav-item` DIV，**无 href**，点击走前端路由替换整页。
  它可能显示每日剩余开聊次数，但点击会丢掉当前推荐列表——**先自查配额，再开推荐页**。
- **推荐页面内没有「招呼语」入口**（2026-09-30 全页扫描确认 `hits: []`）：卡片操作区只有 `打招呼` + 一个 `overdue-tip-icon`。
  （唯一能看到招呼语文案的地方是发送成功后的回执遮罩，那里有个「编辑」——见 §4.1.2。）
- **推荐名单整体质量波动很大**。实测同一职位连续两批 16 人：一批通过闸门 3 人（19%），
  另一批只通过 1 人（6%）。不要假定"平台推的人就是匹配的"。
  （2026-09-30 又测：111 人通过 20 人 = 18%；换一批后 255 人通过 20 人 = 8%，量级一致。）
- **常见的错配类型**：薪资期望显著高于预算（最常见）、职能完全不同（销售/司机/保洁/工程造价）、
  资历溢出（岗位 1-3 年，推荐来的是 10 年以上）。闸门的 G1b/C 组正是针对这三类。

### 招聘端特有的平台机制

- **回复率是可被平台量化的考核项**。大量招呼无人回应会被判定为低质量触达，压低职位曝光——与求职端的"静默降权"是同一套逻辑。
- **企业账号被处置的代价高于个人账号**：影响企业认证与全部在招职位，通常需公司层面申诉。
- **「推荐牛人」有匹配算法**。大量触达与职位不符的人会让算法学偏，后续推荐质量下降。这是算法层面的自我惩罚，与风控无关。

## 3. 已知陷阱（通用，两个角色都会踩）

### 3.1 选择器误报（实测踩过）

不要用 `[class*=slider]`、`[class*=verify]` 这类宽泛选择器查验证码——
`[class*=slider]` 会命中首页轮播 `.omnibus-slider-main`，导致正常页面被误判为风控拦截。

必须**带尺寸判断**（`offsetWidth > 40 && offsetHeight > 30` + 可见性）。
直接复用 `scripts/risk-check.mjs`，它的选择器组已经内置了这个判断。

### 3.2 页面不可见时 Input 域命令会永久挂起

标签页在后台或被最小化时，`visibilityState=hidden`，Chromium 会节流渲染器，
`Input.dispatchMouseEvent` 等不到 ack → `/clickHuman`、`/mouseMove`、`/wheel` 永久挂起，而 `/eval` 一切正常。

> **修正（2026-09-30 实测）**：早期写法称这种情况下 `outerWidth=0`，**不准确**。
> 本次窗口处于 `windowState: minimized` 时实测 `outerWidth=1717`、`outerHeight=1019`，
> 尺寸完全正常，**只有 `windowState` 能揭示真相**。所以判定不要只看尺寸，要看窗口状态。

`risk-check.mjs` 已把这一项纳入自检，并会尝试自动唤醒。详见 SKILL.md 对应章节。

#### 3.2.0 三种 hidden 的判别（2026-09-30 归纳）

| 症状 | 判别依据 | 处置 |
|---|---|---|
| 标签在后台（同窗口其他标签在前台） | `windowState: normal` 且目标标签非 active | `/focus?target=<tid>` 或 `Target.activateTarget` |
| **窗口被最小化** | `Browser.getWindowForTarget` → `windowState: minimized`（**尺寸仍正常**） | `Browser.setWindowBounds {windowState:'normal'}`，见下方 `window-restore.mjs` |
| 窗口被完全遮挡 | `windowState: normal`、尺寸正常、标签是 active，**但 `visibilityState` 仍为 hidden** | 只能靠启动参数根治（见 3.2.1） |

可直接复用的小工具（直连 9222 浏览器级 WS，不走代理）：

```bash
# 把目标标签所在窗口从 minimized 恢复为 normal 并激活标签
NO_PROXY=127.0.0.1,localhost node window-restore.mjs
# 输出示例：状态=minimized → 已请求恢复为 normal → 恢复后状态=maximized
```


#### 3.2.1 遮挡检测：窗口没最小化、也没在后台，页面照样是 hidden（2026-09-29 实测新增）

**症状很难判断**：`Browser.getWindowForTarget` 返回 `windowState: normal`、
窗口尺寸正常（1440x900）、窗口内只有目标这一个标签、`Page.bringToFront` 与
`Page.setWebLifecycleState('active')` 全部调用成功——**但 `visibilityState` 始终是 `hidden`**，
所有 Input 域命令超时挂起。

根因是 Chromium 的 **native window occlusion detection**：窗口被其他窗口**完全遮挡**时，
其标签会被判定为不可见，于是渲染器被节流，Input 域命令拿不到 ack。
`ensureActive()` 里的那几招（bringToFront / setWebLifecycleState / setWindowBounds）**对它无效**——
因为它们解决的是"标签不在前台"，而这里是"窗口被挡住"。

**根治办法：启动浏览器时关掉遮挡检测。** 三个参数一起加：

```bash
msedge.exe --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir="%LOCALAPPDATA%\EdgeCDP" \
  --disable-features=CalculateNativeWinOcclusion \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  https://www.zhipin.com/web/chat/recommend
```

加完后 `visibilityState` 立即变为 `visible`，`/mouseMove`、`/clickHuman` 恢复正常（实测同一台机器、
同一窗口位置，前后只有这三个参数之差）。

**判定顺序**（遇到 Input 域挂起时按此排查）：

1. `/eval` 读 `visibilityState` → 若是 `visible`，问题在别处（多半是 target 已失效，见 3.5）
2. 若为 `hidden`：先确认标签是否在后台（`/focus` 返回 `vis:visible` 即解决）
3. 仍是 `hidden`、但窗口状态是 `normal` → **就是遮挡检测**，按上面加参数重启
4. 注意：`--disable-backgrounding-occluded-windows` 这类参数属于自动化工具常见开关，
   本身可能被指纹检测命中。它是**任务必需**（不加则完全无法点击），但应当在风险自评中计入。

### 3.3 数字被自定义字体渲染

BOSS 的薪资字段用自定义字体渲染，`innerText` 会丢整数位（显示成 `-K`）。
取薪资必须用 `.textContent`，或对整个卡片用正则从 `textContent` 提取。

### 3.4 打标记与点击的衔接（实测修正）

早期版本写的是"标记与点击必须同一轮交互内衔接，跨调用会丢"。**实测在招聘端不成立**：
`/eval` 打标记 → `/mouseMove` hover → `/clickHuman` 点击，跨三次调用仍然命中（推荐页连续 3 位候选人验证通过）。

原因：卡片本身没有重渲染——重渲染只在数据变化时发生。所以规则应改为：

- **页面数据未变时，标记可跨调用存活**，不必强行塞进一次调用
- **但一旦发生了触发数据刷新的操作**（切换职位、切 tab、搜索、翻页），标记会随重渲染消失，必须重新打
- 稳妥做法：把「打标记」放在「点击」前紧邻的位置，中间只夹 hover 这类不改数据的动作

### 3.5 重启代理会关掉它自己开的标签页（踩过两次）

`cdp-proxy.mjs` 退出时会清理它通过 `/new` 创建的标签页（`managedTabs`）。
所以**每次重启代理后，之前记下的 target id 全部失效**，表现为 `/eval` 返回空或 `Uncaught`、
`/info` 查不到页面——很容易误判成"被平台踢了"或"登录失效"。

重启代理后的固定动作：

```bash
# 1. 重新取 target（不要复用旧值）
curl -s --noproxy '*' http://127.0.0.1:3456/targets | grep -o '"targetId": "[^"]*"' | head -1
# 2. 重建页面
curl -s --noproxy '*' -X POST --data-raw 'https://www.zhipin.com/web/chat/recommend' \
  "http://127.0.0.1:3456/new"
```

**用户自己浏览器里已打开的标签不受影响**——只有代理建的会没。
若希望页面在代理重启后仍在，让用户自己在浏览器里打开该页面，再从 `/targets` 里认领它。

### 3.6 沙箱代理会劫持对本地接口的请求

本机环境若设置了 `http_proxy`，`curl http://127.0.0.1:3456/...` 会被送去沙箱代理并失败/超时。
**访问本地 CDP 接口一律加 `--noproxy '*'`**（Python 侧用 `urllib.request.ProxyHandler({})`，
Node 侧设 `NO_PROXY=127.0.0.1,localhost`）。

### 3.7 ⚠️ 禁止用 `/navigate` 硬跳 SPA 路由——会直接导致「登录失效」（2026-10-09 实测）

**招聘端是同源 SPA，路由不是普通网页 URL。** 用 `/navigate` 直接构造
`https://www.zhipin.com/web/chat/<route>` 硬跳，会绕过前端正常的会话票据流程。

实测后果（2026-10-09 16:33）：`/navigate` 跳 `/web/chat/recommend` → 页面被弹到
`/web/user/?ka=bticket`（票据刷新页）→ **等 20 秒以上也没有自动跳回**（远超 §4.3 所说的 5–8 秒瞬时刷新）
→ 再访问站点首页时导航栏显示「登录/注册」→ **确认账号已被登出，当天操作被迫中止。**

**正确做法：切换面板/路由一律点击站内导航项。**

```js
// 在顶层文档里定位导航 <a>（无 href，无法用属性选择器），打一次性标记后用 /clickSafe 点击
const a = [...document.querySelectorAll('a')].find(x => (x.innerText || '').replace(/\s+/g,' ').trim() === '推荐牛人');
a.setAttribute('data-wb-nav', 'recommend');
// 然后 POST /clickSafe?target=<tid>  body: a[data-wb-nav="recommend"]
```

点完后 URL 会正常变为 `/web/chat/recommend`，且推荐面板从 `visibility:hidden` 变为 `visible`。

> 补充事实：`/web/chat/index` 这个路由会**同时挂载多个面板的 iframe**（推荐 + 搜索 + 沟通），
> 非当前面板的 iframe 是 `visibility:hidden` 的 —— 此时 **DOM 仍可读（可提取数据），但点击无效**
> （Input 域需要元素可见）。判断"当前在哪个面板"要看 iframe 的 `getComputedStyle(f).visibility`，
> 不能只看 iframe 是否存在。

### 3.8 ⚠️ 陈旧回执遮罩会让「成功判据」本身失效（2026-10-09 实测，性质最严重）

§4.1.2 讲的是"遮罩吞掉点击 → 事件发出但业务零动作"。**更隐蔽的一层是**：
遮罩没被关掉之后，**"有遮罩"这个成功判据会一直为真**，于是脚本把没做成的事**记成了做成了**，
而且"连续失败熔断"永远不会触发（连续失败数恒为 0）。

实测数据（2026-10-09 阶段一）：日志声称送达 **7** 人，经「沟通」页核对**实际只有 2 人**；
5 条假阳性的判定依据**全部**是「检测到可见遮罩」，而其按钮仍是「打招呼」、全页计数也没有下降。

**两条硬结论**：

1. **成功判据里，"遮罩"信号必须要求"本轮新出现"**（点击前遮罩数为 0），否则不予采信。
   已固化在 `greet-batch.mjs` 的 `decideSendSignals()`（纯函数，配套离线回归用例）。
2. **验收一律以平台侧业务状态为准**：`node scripts/verify-greets.mjs --plan <名单>`
   回读每张卡片的按钮状态（「打招呼」→「继续沟通」），或到「沟通」页核对 `[送达]` 记录。
   **永远不要用脚本日志的 ✅ 当验收依据。**

根因位置另有其一：遮罩的关闭按钮查找范围过窄 —— 见 `cdp-proxy.mjs` 的 `HIT_TEST_JS`
（最顶层命中元素是纯遮罩层 `.dialog-layer`，内部没有按钮；必须在 `.dialog-wrap` 范围内找「知道了」）。

### 3.9 ⚠️ 冷启动可能落在 `/web/user/?ka=bticket` 瞬态页——**不要据此判定「登录失效」**（2026-10-12 实测）

`start-session` 拉起会话后，目标页**首次**可能停在 `https://www.zhipin.com/web/user/?ka=bticket`，
标题「【BOSS直聘注册登录】」，正文能读到「验证码登录/注册」「BOSS直聘APP扫码登录」——
**看起来完全就是登录页，但账号其实是有效登录态。**

票据刷新会自行完成并跳回目标路由（本次实测 1–2 分钟内跳回 `/web/chat/recommend`，
标题变回「BOSS直聘」，面板 `visible`、职位绑定正常）。

**处置顺序（照做，别抢跑）**：

1. 先等 **10–30 秒**再判读；若仍停在该页，调 `GET /restore-window?target=<tid>` + `GET /focus?target=<tid>`
   把窗口恢复/前置（本次实测调用后即跳回目标页）。
2. 只有**间隔 ≥30s 重复探测 2 次以上**仍在 `/web/user/`，才按熔断处理
   （`risk-check.mjs` 的 `loginWall` 已覆盖 `/web/user` 路径与「注册登录」标题）。
3. **期间绝对不要**用 `/navigate` 去"修"它 —— 那正是 §3.7 导致真正登出的操作。

> 与 §3.7 的区别：§3.7 是**人为硬跳路由**把票据流程搞坏（真登出）；本节 `ka=bticket` 是
> **冷启动自带的正常票据刷新**（假警报）。两者页面长得一样，判据是"是否由 `/navigate` 触发"
> + "等待/前置窗口后能否自行跳回"。

### 3.10 ⚠️ 僵死进程占着「IPv4 9222」会让整条链路起不来，并伪装成「登录失效」（2026-10-13 实测）

**症状**：`start-session` 报告浏览器已启动，但代理连不上；进一步探测发现
`127.0.0.1:9222/json/version` 返回 **404**、而 `localhost:9222` **正常**。

**根因**：一个边缘残留的 Edge 后台助手进程（命令行含 `--no-startup-window`）占着 **IPv4 127.0.0.1:9222**
并对任何请求回 404。新启动的浏览器抢不到 IPv4，只能绑到 **IPv6（::1）**，
于是 `127.0.0.1` 走不通。而代理是**按端点文件里的 ws 地址连 `127.0.0.1`** 的 → 连接断开。

**为什么危险**：链路断开的表征（页面读不到、`/eval` 报错）与"登录失效/被平台踢下线"很像，
非常容易误判为风控事件，从而白白停掉一整天的操作。

**处置（已在 `start-session.mjs` 内置，2.8.0 起自动完成）**：

1. 端口判定必须分两层：**端口有没有被监听** ≠ **监听者是不是 CDP**。只看 `/json/version` 能否解析会漏判。
2. 清占用者要**连清两轮**并复查端口是否真正释放（残留进程常会拉起新的 worker）。
3. 启动后做一次 **`127.0.0.1` 回环自检**；若只有 IPv6 可用就**快速失败**并打印占用 PID，
   而不是留一个"浏览器好像在跑、代理却连不上"的半死状态。

> 排查口诀：**`127.0.0.1` 不通但 `localhost` 通 ⇒ 先怀疑 IPv4 端口被非 CDP 进程占了**。
> 此时不要怀疑账号，也不要重启登录。

### 3.11 ⚠️ 长批次：不要猜「谁杀了它」，要让「被杀无感」（两次实测 + 两次自我推翻）

**踩过的两个坑：**

**坑 A（2026-10-12）：在前台反复扫日志 → 被「重复调用保护」切断回合。**
用同一条命令反复读日志看进度，会被宿主判定为异常循环并直接切断当前回合。

**坑 B（2026-10-13）：批次被外部终止，停在 7/25。** 现场证据：

| 观测 | 值 | 含义 |
|---|---|---|
| 心跳 `stopReason` / `graceful` | `null` / `false` | **不是脚本自己停的**（不是守窗、不是闸门、不是熔断） |
| 心跳 `aborted` | `true` | 走完了 `process.on('exit')` → **不是强杀**（强杀跑不到退出处理器） |
| 锁文件 | 已被正常释放 | 同上，退出处理器完整跑完 |
| 该块日志 | 停在某人处，且无 `异常终止：` | 不是未捕获异常（当时还没有留痕机制） |
| 同时段风控 / 会话 | 0 信号；CDP 会话至今健康 | **不是风控，不是掉线** |

死因链条（证据在 `~/.workbuddy/logs/sandbox/<日期>/`）：`10:52:48` 本回合最后一条命令 →
随后回合结束、**1 小时 48 分无人交互** → `11:06:05` 沙箱实例停止写入 →
`11:08:36` GC 报 `无 sandbox-cli 进程存活，自动退出` → `11:09:48` **进程被终止**。

> ⚠️ **两个被自己的对照实验推翻的中间结论（留痕，避免后人重走）**
>
> ① 「沙箱收不到命令 13–16 分钟就回收托管进程」→ **否证**。
>    用不受沙箱管辖的通道挂住回合、让沙箱整整 **19 分钟零命令**，三个托管探针
>    （非 detached 写文件 / 非 detached 写管道 / detached 写文件）**全程未中断**
>    （每 5s 一次，连续 232 次）。
> ② 「回合结束就会清理托管进程」→ **同样否证**。
>    `p1.log`（由**普通后台任务**启动）在回合结束后**连续存活 67.3 分钟、断档 0 处**（807 次写入）；
>    `p3.log`（detached）同样 67.2 分钟、断档 0 处。
>    长期反例还有一个：2026-10-12 启动的 `start-session --hold` 至今存活 **26 小时以上**。

**结论：凶手无法确证，而且不重要。** 探针已证明后台/detached 进程都能长期存活，
所以**依赖其中任何一个前提都是在赌**。工程上只做两件事：

1. **让被杀无感** —— 守夜人自动带 `--resume` 续跑（`watchdog.mjs` + `detach.mjs`）；
2. **让断点可靠** —— 已办集合**多源合成**（结果文件 ∪ 心跳 `doneIds` ∪ 触达记录）。
   结果文件是收尾才写的、被杀时可能压根不存在，**绝不能只依赖它**。

**正确做法：**

```bash
# 推荐：脱离宿主启动守夜人（不依赖回合存活，也不经过任何会被关闭的输出管道）
node scripts/detach.mjs --plan screen.result.json --limit 47 --chunk 8 \
  --touch screen.touch.json --commit --out screen.greet.json --log screen.greet.log

# 看进度（可反复执行，不打扰批处理）
node scripts/status.mjs --out screen.greet.json --health

# 若要"占住回合"：有界等待（内容在推进，不是反复扫日志）
node scripts/status.mjs --out screen.greet.json --wait 540
```

### 3.12 ⚠️ stdout 管道断裂会把进程带走；终止原因必须留痕（2026-10-13 修复）

两个独立但都会致命的缺陷：

1. **断管 = 未捕获异常 = 进程消失。** 批次的 stdout 是宿主捕获的管道。当读取端消失
   （回合结束 / 后台任务被摘除 / 管道关闭）时，下一次 `console.log` 触发 `EPIPE`；
   Node 默认把**未处理的流错误升级成未捕获异常并终止进程**。表现与 §3.11 的现场证据完全吻合：
   日志突然停在某一条、心跳只有 `aborted:true` 而没有原因。
   **修复**：`greet-batch.mjs` 先落盘再打印（日志文件永远是真相来源），并给
   `process.stdout/stderr` 挂 `error` 处理器吞掉 `EPIPE / ERR_STREAM_DESTROYED`，标记降级后继续运行。
   `detach.mjs` 更进一步：守夜人的 stdio 直接 `ignore`，**从根上不存在这条管道**。

2. **终止原因不可观测。** 复盘时无法区分「脚本自己停」「被外部杀」「未捕获异常」。
   **修复**：`SIGINT/SIGTERM/SIGHUP/SIGBREAK`、`uncaughtException`、`unhandledRejection`
   都会先写 `abortReason`（如 `signal:SIGTERM` / `uncaughtException:...`）再退出，
   退出码 0/1 → 守夜人据此判断"该不该继续跑"。

**同一轮顺带修掉的两个真 bug：**

- `greet-batch` 在模块顶层解析 `process.argv`，**被 import 时会响应调用方的 `--help` 并退出**
  （`watchdog --help` 曾打出 greet-batch 的帮助文本）。已用 `invokedDirectly` 守卫。
- `status.mjs` 把函数对象当布尔用（`runEnded` 漏了括号 `()`），于是
  **状态永远显示「本轮结束」、退出码永远 12**。已修正。

**另一个显示缺陷（已修）**：心跳的 `total/done` 曾是"本块"视角，续跑时会显示
`进度 8/2（400%）`。现在统一为**计划视角**（`scopeTotal / doneBefore / planView()`）：
`total` 恒为计划人数，`done` 含续跑前已完成的部分。

## 4. 招聘端触达流程（2026-09-29 实测）

### 4.1 推荐流（推荐牛人）——本次实跑路径

推荐流是招聘方日常最高频的用法，也是**最贴近真实行为**的触达路径（HR 本来就是刷推荐、看到合适的就打招呼）。

```
0. 确认招聘端已登录；确认职位绑定：读 /web/frame/recommend/ 内 .job-selecter-wrap 的文本，
   必须与 screen.job.json 的 positionTitle 一致。若是别的职位 → 先切换（见 2 节职位下拉），
   切换后 iframe 会重新加载，须重新等待渲染再继续
1. 提取候选人：/eval 遍历 .card-list .card-inner[data-geekid]（注意 `.card-item` 是行容器、一行两卡，见第 2 节）
   → 映射成 screen.talent.json（字段名对齐 screen-talent.mjs：id/name/title/skills/resume/
   experience/degree/school/expectSalary/expectCity/activeStatus）
2. 跑闸门排序：
   node scripts/screen-talent.mjs --job job.json --talent talent.json --touch touch.json --table --out result.json
3. 对 accepted（已按匹配度降序）逐个触达：
   a. node scripts/risk-check.mjs --target <tid> --proxy http://127.0.0.1:3456  → 非 0 退出即停手
   b. /eval 给该卡片的 .btn-greet 打标记（选择器按 data-geekid 精确定位，不要按序号）
   c. /mouseMove?selector=... 做可信 hover
   d. /clickHuman?selector=... 点击「打招呼」——**点击即发送，不会弹话术选择框**
   e. 校验：按钮文本变「继续沟通」，或出现「已向牛人发送招呼」回执
   f. 关闭回执弹窗：打标记后 /clickHuman 点击 iframe 内的「知道了」按钮
   g. 按 plan 的带方差间隔等待（实测用 60–180s 随机）
4. 全部完成后回写：node scripts/screen-talent.mjs --commit result.json --touch touch.json
```

> **不要勾选回执弹窗里的「不再显示」。** 那是一次账号设置变更，跨批次累积是行为特征；
> 每次多点一下「知道了」的成本远比它低。

#### 4.1.1 执行载体：必须用后台脚本，不要用一串 curl

单次「打招呼」要 2–4s，但**两次之间要等 60–180s**（带方差）。5 位合计 5–13 分钟。
这带来两个硬约束：

- **前台 shell 命令约 45s 就被 SIGTERM**，串行 curl 跑不完；
- 限频间隔必须真实等待，`sleep` 在前台同样会被打断。

因此实操是：写一个**独立的驱动脚本**（Python 或 Node），把「定位 → hover → 点击 → 校验 → 关回执 →
随机间隔」整条链路封进去，用 `run_in_background` 启动，日志追加写文件，完成后再读日志。

驱动脚本的三个注意点（实测踩过）：

1. **本地 CDP 接口必须绕开沙箱代理**：Python 用 `urllib.request.ProxyHandler({})`，
   Node 设 `NO_PROXY=127.0.0.1,localhost`。否则请求会被送去上游代理然后超时。
2. **Windows 控制台写中文要设 `PYTHONIOENCODING=utf-8`**，否则日志直接抛 `UnicodeEncodeError`。
3. **后台运行不要 `nohup ... &` + 立即返回**：这类非交互运行会在 turn 结束时终止子进程。
   用任务系统提供的后台运行机制，它会托管生命周期并在完成时通知。

#### 4.1.2 ⚠️ 最重要的坑：成功后弹出的全屏遮罩会吞掉后续所有点击（2026-09-30 实测）

**每一次「打招呼」成功后，BOSS 都会弹出一个全屏遮罩弹窗。它不关，后面所有人的点击都会打在遮罩上、
静默失效——脚本会「看起来在正常跑，实际一个都没发出去」。这是本项目最危险的一种失败形态。**

实测该遮罩的结构：

```
.dialog-wrap.dialog-chat-greeting.v-transfer-dom   z-index 1010   铺满整个 iframe（0,0,1244,769）
.dialog-layer                                       z-index 1002   遮罩层
    内含文案：已向牛人发送招呼 / [编辑] 你好！在吗？方便沟通一下吗 / [不再显示] [知道了]
```

诊断证据（可复现）：在遮罩打开的状态下对另一张卡的 `.btn-greet` 发 `/clickHuman`，
代理返回 `{"clicked":true,...,"tag":"BUTTON"}`（**它是按 DOM 坐标算的，不做命中测试，所以照样报成功**），
但页面毫无变化。注入 capture 监听器可看到事件确实抵达了按钮（`isTrusted=true`），
而在顶层 `document.elementFromPoint(1300,425)` 只会拿到遮罩。**别只看代理的返回值。**

**因此驱动脚本必须做到：每轮点击前先检查并关闭遮罩，点击后立即关闭。**

```js
// 关闭：找可见的 .dialog-wrap 里的「知道了」，标记 -> /mouseMove -> /clickHuman
const dlg=[...d.querySelectorAll('.dialog-wrap')]
  .filter(e=>getComputedStyle(e).display!=='none'&&e.offsetWidth>200);
const btn=[...dlg[0].querySelectorAll('button,a,span,div')]
  .filter(e=>(e.innerText||'').trim()==='知道了'&&e.offsetParent!==null&&e.offsetWidth>0).pop();
```

- 用「**知道了**」而不是「不再显示」——后者会改用户账号设置，且会让后续轮次失去这个成功信号。
- 遮罩里的「编辑」按钮说明招呼语文案是**可配置的**，但配置入口在这个引导弹窗里，
  不在推荐卡片的操作区（推荐页卡片上确实没有招呼语输入框）。

#### 4.1.3 发送成功的校验信号与正确的等待方式（2026-09-30 修正）

| 信号 | 取法 | 可靠性 |
|---|---|---|
| 回执遮罩 | iframe 内出现可见的 `.dialog-wrap.dialog-chat-greeting` | 中——**但必须要求"本轮新出现"**，否则会采信上一轮遗留的陈旧遮罩，把它后面的每一轮都误判成成功（见 §3.8） |
| 按钮文本 | 该卡 `.btn-greet` 消失、出现 `.btn-continue`（文本「继续沟通」） | **高**——注意是换成**另一个节点**，不是同一个按钮改文本 |
| 全页按钮计数 | `d.querySelectorAll('.btn-greet').length` 比点击前少 1 | 高——全局不变量，作交叉验证 |
| 左侧「沟通」计数 | 顶栏导航计数 +1 | 中——可作第三重验证 |

**实测延迟只有 0.8–1.3 秒**（+0.8s 时按钮已变「继续沟通」、遮罩已出现），但**必须用轮询而不是固定等待**：

- 固定窗口写 2–4s 会**误判**：首轮/冷启动、或系统卡顿时，反馈可能晚于窗口 →
  脚本记为「失败」→ 触发不必要的间隔拉长，**并且不会去关遮罩，于是后面全废**。
- 正确做法：点击后每 0.8s 轮询一次，**上限 15s**，出现上述任一信号即判成功并立即关遮罩。
- 判「失败」前必须先确认**确实没发出去**（目标卡仍是 `.btn-greet`、全页计数未减），
  才允许**重试一次**（最多一次，避免重复触达）。
- **不要把「校验没看到反馈」当作风险信号**去拉长间隔——风控信号只认验证码/答题/限频文案/登录失效/页面不可见。

配套的通用教训：**校验必须基于"业务状态是否真的改变"，而不是"代理是否返回 200"。**
点击通道全绿、业务零动作，是自动化里最隐蔽的 bug。

#### 4.1.4 点击"看起来成功但没反应"时的诊断顺序（2026-09-30 沉淀）

按这个顺序走，能在 2–3 步内定位到底卡在哪一层，**不要靠猜、也不要盲目重跑**：

1. **看遮罩**：`d.querySelectorAll('.dialog-wrap')` 里有没有可见的（`display!=='none' && offsetWidth>200`）。
   最常见就是它——见 §4.1.2。
2. **命中测试**：在**顶层文档**用 `document.elementFromPoint(x, y)`、在 **iframe 内**用
   `d.elementFromPoint(本地x, 本地y)` 看落点是不是目标按钮。iframe 本地坐标 = 顶层坐标 − iframe 的
   `getBoundingClientRect().left/top`。能一眼区分"被遮挡"和"坐标算错"。
3. **事件是否抵达**：在 iframe 文档上挂 capture 监听器记录 `pointerdown/mousedown/mouseup/click` +
   `e.isTrusted` + `e.target`。若四条都到、且 `trusted=true`，说明**输入层没问题，问题在业务层**，
   别再去调代理坐标。（这是诊断手段，属临时注入；用完的把 `data-agent-target` 清掉。）
4. **请求是否发出**：⚠️ **不要用 `performance.getEntriesByType('resource')` 判断"最近有没有请求"**——
   该缓冲区默认上限 250 条，**满了之后新条目不记录**（不是淘汰旧的）。本次实测缓冲区停在 11:22 就再也不动了，
   差点误判成"根本没发请求"。要抓请求就临时 hook `fetch`/`XMLHttpRequest`（诊断用，会污染页面运行态，
   **必须在确认页面可安全刷新后再做**），或改从服务端状态反推。
5. **业务状态反推**：最省事、也最可靠的一层——直接看 `.btn-greet` 是否消失/变成 `.btn-continue`、
   全页 `.btn-greet` 计数是否 −1、`.dialog-wrap.dialog-chat-greeting` 是否出现。

**反面教材（本次实际踩到）**：代理返回 `{"clicked":true,...,"tag":"BUTTON"}` → 直接信了 → 判定为
"点击成功但业务失败" → 归因为"平台限流" → 把 GAP 拉长到 300s。实际上只是遮罩没关。
**代理的返回值只说明"我们把事件发出去了"，不说明"业务被执行了"。**

#### 4.1.5 ⚠️ 选择器陷阱：打招呼按钮**不在** `.card-inner` 里面（2026-09-30 实测）

实测 DOM 层级（推荐流）：

```
UL.card-list
└ LI.card-item
  └ DIV.row
    └ DIV.geek-card-small.candidate-card-wrap      ← 卡片根
      ├ DIV.card-inner.common-wrap[data-geekid=...]
      └ DIV.button-list
        └ button.btn-greet                          ← 打招呼按钮
```

`button.btn-greet` 的父级是 `.button-list`，与 `.card-inner` 是**兄弟关系**。于是：

| 选择器写法 | 命中数 |
|---|---|
| `.card-inner[data-geekid="X"] .btn-greet`（后代选择器） | **0** ❌ |
| `.geek-card-small:has(.card-inner[data-geekid="X"]) .btn-greet` | **1** ✅ |

**必须用 `:has()` 从卡片根定位。** 旧脚本用 JS 的 `inner.closest('.geek-card-small').querySelector('.btn-greet')`
能跑通，但一旦把定位改写成选择器字符串，很容易顺手写成后代选择器 —— 然后**静默命中 0 个**。

**由此得出的通用教训**：`--dry`（只定位不点击）这类预检，如果走的是**另一套定位逻辑**，
就根本测不出点击选择器的问题。**预检必须校验真正用于点击的那个选择器**
（`greet-batch.mjs --dry` 已改为这么做，会打印"点击选择器命中 N 个"）。

**顺带**：`.card-inner[data-geekid]` 是卡片的推荐稳定键。`data-jid` 是批次号、`data-lid` 是位置序号，
**都不能当去重键**（见 §4.2）。

### 4.2 搜索流（搜索牛人）——需要主动扩大候选池时用

搜索流可以按关键词反复取人，适合推荐流质量差、需要自己找人的场景：

- 搜索页：`/web/chat/search`，内容在 `/web/frame/search/`
- 职位选择器 `.search-current-job`，下拉 `.ui-dropmenu-visible .ui-dropmenu-list li`
- 关键词输入框 `input.search-input`，用 `/type` 端点（`Input.insertText`，事件为 trusted）写入后回车
- 候选卡片 `.geek-info-card`，触达按钮 `button.btn-getcontact`（文本「联系 Ta」）——
  **该按钮是 hover 才显现的**，必须先 `/mouseMove` 到卡片上再点，否则 rect 为 0
- 卡片稳定键：`data-expect`（`data-jid` 是批次号、`data-lid` 是位置序号，都不能当去重键）

### 4.3 不变的两条底线

**只执行到「发送招呼语」为止。** 候选人回复后的对话由用户本人完成——
这也是提高转化率最关键的一步（见 `references/talent-outreach.md` 第五节）。

**切换职位后 iframe 会整页重载**，期间可能短暂跳到 `/web/user/?ka=bticket`（会话票据刷新页）再回来。
这不是登录失效，等 5–8 秒即可；但**此时不要发任何点击**，API 会报"未找到元素"。

### 4.4 限频间隔（GAP）：不压缩，只按风险拉长（2026-09-30 定策）

**基线区间保持 60–180s 随机，不要为了"跑得快"压缩它。**

理由：把 2026-09-29 那次 5 人触达拆开看，总耗时 7 分 26 秒里 **413 秒（92.6%）就是 GAP**，
真正的页面动作只占 33 秒。也就是说——

> 触达耗时的 9 成是"故意等出来的"，这是安全成本，不是性能问题。
> 想缩短只有两条路：① 把 N 人拆成多次会话；② 降低 N。都不要去动 GAP。

**允许并且推荐的做法：按风险信号自动拉长。** 出现下列任一信号时，把该次 GAP 乘以 1.5（上限 300s）：

| 风险信号 | 取法 |
|---|---|
| 上一次触达需要重试 / 定位失败后补发 | 驱动脚本内的失败计数 |
| 风险闸门出现过"页面不可见"（`visibilityState !== visible`） | `risk-check.mjs` 退出码非 0 |
| 回执弹窗迟迟不出现，或校验走了冗余信号才判定成功 | 校验分支命中 `btnAfter === '(gone)'` |
| 页面加载明显变慢（导航或 /eval 延迟超过前一次的 2 倍） | 记录每次 `/eval` 耗时做基线 |

**上限硬约束：单次 GAP ≤ 300s。** 无上限地拉长会让会话时长变得不可预测，
反而不利于"一个人正常干活"的行为形态；120–300s 已经落在真人浏览的行为带内。

**反向禁止**：不要出现"上一次触达失败 → 立刻重试"的紧循环。重试也必须先走完一个完整 GAP。

### 4.5 触达后的独立验证：导航到沟通页核对会话列表（2026-09-30 实测）

**只信「业务状态真的变了」，不信「脚本说成功了」。** 触达跑完后必须做一次独立复核，
最硬的证据是沟通页的会话列表——它由服务端返回，与本地脚本无因果关系。

```bash
# 导航（会丢掉推荐列表，务必等触达全部结束后再做）
curl -s --noproxy '*' -X POST --data-raw 'https://www.zhipin.com/web/chat/index' \
  "http://127.0.0.1:3456/navigate?target=$TID"
# 等 10–15 秒渲染，然后提取会话列表
```

**沟通页（`/web/chat/index`）的选择器（实测）**：

| 目标 | 选择器 | 备注 |
|---|---|---|
| 会话列表容器 | `.user-list`（`b-scroll-stable`） | 有 4 个直接子节点（含表头与占位），**不要按 children 数判断** |
| 会话条目 | **`.user-list .geek-item-wrap`** | 一条会话一个；`.geek-item` 是其内部节点，会重复计数 |
| 条目标识 | `.geek-item-wrap [data-id]` | 形如 `d-c="61017"` / `id="_572961139-0"`，**不稳定**，别用作持久 ID |
| 条目文本 | `innerText` | 形如 `12:14 朱秀海 绿植养护员 [送达]你好！在吗？方便沟通一下吗` |

**条目文本携带的状态码（很有用）**：

- `[送达]` —— 已投递、对方未读
- `[已读]` —— 已读未回
- 文本直接是对方的话（且无 `[送达]/[已读]` 前缀）—— **对方已回复**
- 前缀数字如 `1 12:11` —— 未读条数

**这是最可靠的「是否真的发出去」的判据**，比任何 DOM 内信号都硬。实测 20 人逐一命中，时间戳与发送记录完全对齐。

> 注意：沟通页与推荐页**不能并存**（多标签会互相踢，见 §2.1）。所以顺序必须是
> `筛选 → 触达 → 验证`，中间不要跳去别的页面。

## 5. 闸门配置要点

跑 `screen-talent.mjs` 时，针对本站的建议参数：

- `excludeKeywords` 必配：`销售 / 客服 / 运营 / 产品经理 / 测试 / UI / 前端 / 实施 / 售前 / 讲师 / 培训 / 美工 / 主播 / 带货`。
  推荐流里大量非目标职能，不排除会浪费配额。
- `requireCity` 必填。异地候选人不会考虑，属于纯无效触达。
- `staleTalentDays` 建议 30。活跃度超过一个月的候选人回应率极低。
- `salaryBudgetMonthly` 必须填真实区间。期望薪资下限超过预算上限的候选人**必然谈不拢**，
  触达他们等于主动制造无效对话、拉低回复率。
- 参数建议：`dailyMax ≤ 12`、`perPositionMax ≤ 8`、`minGapSeconds ≥ 60`、`repeatTalentCooldownDays = 30`。

## 6. 尚未验证、但影响判定的事实（记录待查）

### 6.1 每日配额：**有，但没有固定值**（2026-09-30 查证，原「待查」项已部分闭合）

官方口径（BOSS 直聘对公司方的回应，经媒体转引）：

> 「企业基础权益天数由**系统根据地区、在招职位、竞争程度**等因素**动态调整**，最终数量以**系统显示为准**。」

**含义：不存在公开的固定配额，任何"就是 N 次"的说法都不准确。** 二手资料的量级分布（**非官方，仅供定位**）：

| 账号状态 | 每日主动开聊 | 每日主动查看 |
|---|---|---|
| 免费 / 基础企业账号 | **约 3–10 次** | 约 20 次 |
| 付费基础 VIP | **约 60 次** | 约 120 次 |
| 企业认证账号 | **约 30–100 人/天** | — |

> 三行互相矛盾（3–10 与 30–100 差一个数量级），矛盾本身说明：**配额强绑定账号权益，跨账号不可比。**

**取数方式（唯一权威，开跑前第 0 步）**：
```
BOSS直聘 App → 我 → 设置 → 账号与安全 → 招聘权益 → 今日剩余主动开聊次数
```
Web 端线索：搜索页底部曾出现孤立数字 `22`（**疑似剩余额度，仍未确认**，但可作为交叉验证）。

**两条不占配额的通道**（扩大范围的首选，web 端可用性**未验证**）：
- 「**已查看**」人才：候选人来过你的主页/职位 → 首次沟通不占配额（被动响应，平台鼓励）
- 「**职位邀请**」一键邀请：以职位卡片推送，**不计入打招呼次数**

**实际应用：自动化上限 ≈ 账号配额 × 0.6。** 2026-09-30 实测样本：配额 49 → 安全上限 29 → 实发 20（余 29）。
留 40% 的三条理由：① 配额要留给用户手动捞人；② **精确用满本身是异常特征**（真人 HR 极少用满）；
③ 误触达后还留有回旋余地。

> **关键判断：安全次数不随配额等比放大。** 配额 12 → 60 时，自动化上限**不是**提到 36，
> 而是仍停在 12–20 上下。**VIP 买的是额度，不是安全感。**

### 6.2 其余待查项

- 候选人被同一公司多个招聘者触达时，平台是否合并展示？（影响"重复触达"的判定粒度）
- 推荐流的排序依据是什么？（实测同一职位连续两批名单完全不同，且质量波动巨大——
  猜测掺入了活跃度与随机探索，但未证实。这直接影响"该刷几批"的策略。）
- 推荐流每批 16 人（8 行 × 2 列）是否为固定值？**已部分回答**：JS 滚动 iframe 可无限追加，
  实测 15 → 31 → 47 → … → **255 张**（2026-09-30），是懒加载而非固定批次。

## 7. 实测数据留档

### 7.1 推荐流通过率（2026-09-29 / 09-30）

同一职位「绿植养护员」的闸门结果，可作为阈值标定的基准：

| 日期 | 批次 | 候选 | 通过 | 待核 | 否决 | 通过率 | 主要否决原因 |
|---|---|---|---|---|---|---|---|
| 09-29 | 第 1 批 | 16 | 3 | 2 | 11 | 19% | 薪资超预算（6 例）、技能不命中（4 例）、职能排除词（2 例） |
| 09-29 | 第 2 批 | 16 | 1 | 2 | 13 | 6% | 薪资超预算（6 例）、技能不命中（8 例）、职能排除词（3 例） |
| 09-30 | 滚厚后 | **255** | **20** | 17 | 231 | **8%** | 同上，薪资与职能为主 |

**结论：推荐流不能当作"已筛选的候选池"。** 平台推荐 ≠ 匹配，平均通过率约 10%。
闸门的价值正在于此——它拦掉的绝大多数是"发出去也不会有回复"的无效触达。
**要把 20 人做够，需要滚到 200+ 张卡。**

### 7.2 一次完整 20 人触达的耗时结构（2026-09-30）

| 阶段 | 耗时 |
|---|---|
| 启动链路 | **0**（复用常驻会话） |
| 滚厚候选池（15 → 255 张） | ≈ 4 分钟（约 15 次 JS 滚动 + 等待） |
| 闸门筛选 | < 1 秒 |
| 点击发送 × 18 | ≈ 25 秒（每次 **+0.8s** 确认生效） |
| **限频 GAP × 18** | **≈ 39 分钟**（75–188s，均值 ≈133s） |
| 合计 | **≈ 43 分钟** |

> 又一次印证 §4.4：**耗时的 9 成是故意等出来的**。缩短只有"降 N"或"拆会话"两条路，不要动 GAP。

## 8. 批量触达的两个通用陷阱（2026-09-30 第二轮 25 人实测）

### 8.1 「清理辅助函数」会破坏「依赖标记的选择器」→ 重试路径 400

**现象**：某位候选人首次点击 15s 内无可见效果，进入重试分支时直接抛
`HTTP Error 400: Bad Request`，**整批任务崩溃**（结果文件都没落盘）。

**根因**：点击前的 `ensure_no_modal()`（关遮罩）内部有一句"清场"：
```js
d.querySelectorAll('[data-agent-target]').forEach(e => e.removeAttribute('data-agent-target'))
```
它把**所有**元素上的标记属性清掉了 —— 而按钮选择器正是靠这个属性定位的：
`SEL_BTN = frame:... ||| [data-agent-target="greet"]`。
于是重试时 hover 匹配不到元素 → 代理返回 400。

**教训（通用）**：
> 用"打标记 + 属性选择器"做定位时，**任何会清除标记的辅助函数（关弹窗、复位、清场）
> 都必须被视为"使当前选择器失效"**。调用它之后，若还要操作同一个元素，
> **必须重新打标记**，不能直接复用原选择器。

**修复模板**：
```python
for attempt in (1, 2):
    if attempt == 2:
        m2 = ev(mark_js(tid))          # ← 重新定位并重新打标记
        if not (isinstance(m2, dict) and m2.get('ok')):
            break
    hover(SEL_BTN); click(SEL_BTN)
```

**同时必须做的加固**：`hover()`/`click()` 要捕获 `urllib.error.HTTPError` 并返回错误字符串，
**绝不能让单次定位失败抛异常终止整批**——一次 400 不该让已经发出去的 5 个人白等。

### 8.2 窗口最小化 ≠ 风控信号，应「自动恢复」而不是「熔断」

**现象**：第 8 位前 `risk_gate()` 返回 `STOP:页面不可见(hidden)`，任务中断。
用 `Browser.getWindowForTarget` 查明窗口状态是 **minimized**。

**关键区分**：
| 信号 | 性质 | 正确处置 |
|---|---|---|
| 验证码 / 答题 / 操作过于频繁 / 登录失效 | **真风控** | 立即停止，等人处理 |
| `visibilityState = hidden`（窗口被最小化） | **环境噪声** | 先自动恢复，恢复不了才停 |

页面不可见确实必须处理（`Input` 域命令会永久挂起），但处置方式应是**恢复**：

```python
if r.get('vis') != 'visible':
    log('⚠ 页面不可见，尝试恢复窗口 ...')
    restore_window()          # 子进程调 window-restore.mjs（浏览器级 CDP）
    time.sleep(2)
    if ev(JS_RISK).get('vis') == 'visible':
        return None           # 恢复成功 → 继续
    return 'STOP:页面不可见（自动恢复失败）'
```

`window-restore.mjs` 走的是**浏览器级** WebSocket（只有浏览器级端点才有 `Browser.*` 域），
用 `Browser.setWindowBounds({windowState:'normal'})` + `Target.activateTarget`。

**实战效果**：一轮 25 人的任务里触发 3 次（14:59 / 15:02 / 15:04），**全部自动救回，零中断**。
在此之前，任何一次失焦都会让整批任务停下来等人。

### 8.3 25 人批次数据留档（2026-09-30 第二轮）

| 指标 | 值 |
|---|---|
| 候选池（滚到底） | 463 人（`rec_now2.json`） |
| 闸门结果 | accepted 25 / rejected 361 / review 57 / deferred 20（通过率 **5.4%**） |
| 送达 | **25 / 25**，首次点击即生效 25/25 |
| 限频 | 76–204 s（均值 ≈142 s，未压缩） |
| 净耗时 | 约 63 分钟（含两次故障中断与重跑） |
| 独立证据 | 推荐页 `.btn-greet` 463 → 438（−25）；`.btn-continue` = 25 |

> 注意：推荐流**同一职位连续两批名单差异极大**（09-30 上午抓到 255 人、下午抓到 463 人，
> 且前 20 名与上午完全不同）。**每次执行前都必须重新抓取，不能复用上一次的候选池。**
