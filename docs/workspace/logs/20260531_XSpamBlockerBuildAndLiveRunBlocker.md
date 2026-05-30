# X 中文垃圾号识别/屏蔽 userscript — 构建与实战卡点

- 日期：2026-05-31
- 项目：x-spam-blocker（新建独立 repo，本地 git + Mac mini bare durable remote）
- Session 性质：从 X 帖子下的中文色情/同城上门/搭讪引流垃圾号出发，做一个"AI 时代更优"的自动识别 + 一键屏蔽工具，并计划发到 X 分享。

## 做了什么（changed files / 产出）

- 新建 repo `~/AI_Workspace/x-spam-blocker/`：`x-spam-blocker.user.js`(主脚本) + `README.md` + `LICENSE`(MIT) + `.gitignore` + `test/fixture.html`(X DOM mock 回归页) + 本日志。
- 根 `~/AI_Workspace/.gitignore` 注册 `/x-spam-blocker/` sub-repo（已 commit+push 到 AI_Workspace super-repo `64300c7`）。
- Mac mini bare 建仓 `~/repos/x-spam-blocker.git`，远端 `ssh://haitaoxu@macmini-aiws/...`，push 完成、双端 HEAD 一致。
- 脚本迭代 v0.1 → v0.5（见 git log）。

## 核心设计演化（可复用洞见）

1. **判据从"关键词黑名单"→"形态+行为+语义"多信号打分**（v0.4 重构，承接 v0.1-0.3）。
   起因：用户实测新一波垃圾号已**完全不用敏感词**，改成"普通孤独女生"文案（如"一个人养猫追剧emo谁救我""想找你"）绕过关键词。结论：**关键词黑名单是必输的军备竞赛**。
   新判据（甩不掉的特征）：① 自动生成 handle 形态 `英文名+一串数字`（X 给批量号分配的，最硬）② 随机 emoji 沙拉（绕平台去重的行为指纹）③ 孤独/搭讪语义类（关键词抓不全，LLM 才彻底）④ 露骨词降为辅助加分 ⑤ 引流链接/短域名。阈值 5，组合命中才屏蔽——单看 handle 形态不屏蔽，保护真人（如 @grok 提问者）。
2. **隐藏 bug：X 用 `<img alt>` 渲染 emoji，`innerText` 读不到** → emoji 信号一直是瞎的。新增 `richText()` 从 img alt + `<br>` 还原文本。这条很可能是早期实战漏报的元凶之一。
3. **扫描机制：MutationObserver + 300ms 去抖**（v0.3，替换 v0.2 的 1.5s 盲轮询）。澄清：DOM 扫描是纯本地读取、不发网络，与 X 反爬虫无关；反自动化风险只在 block 请求（自动模式随机间隔+上限，手动模式人工点击）。
4. **采集器（用户洞见）**：把用户自己的"已屏蔽账号"列表当作亲手标注的正样本数据集，从中反推真实特征分布。v0.5 在 `/settings/blocked*` 注入采集按钮，自动滚动收割 UserCell → 下载 `x-blocklist.json`。

## 验证了什么 / 没验证什么（INTENT_VALIDATION）

- ✅ 判定逻辑：在 X DOM mock 测试页用 **13 个真实样本**（6 新波无敏感词 + 4 旧波 + 3 真人）跑通，**13/13**：6 新波纯靠 handle 形态+emoji 沙拉命中，3 真人（含 @grok 提问者）正确放过。Node 语法 check 通过。
- ❌ **未验证：脚本在用户真实 X 上的运行**。用户实测多次反馈"垃圾号没标红、右下角无 🛡 浮窗" = **脚本根本没在其浏览器执行**。Developer Mode 已确认开启，故根因未定（疑似：Tampermonkey 里脚本未真正安装/启用，或 Chrome MV3 per-extension "Allow user scripts" 开关，或安装流程未完成）。
- ❌ 未做：blocklist 真实数据采集 → 特征校准；公开发布（GitHub public + GreasyFork）+ X 发帖；LLM 语义层。

## 卡点根因（环境限制，已沉淀到 memory）

无法替用户在其**登录态日常 Chrome** 上诊断/操作：
- `chrome-devtools` MCP 只连到**独立的调试 Chrome 实例**（端口 9222，内含 Cloudflare/IBKR/考试网站标签，**未登录 X**），看不到也碰不到用户日常 Chrome（含登录 X + Substack）。
- `computer-use` 对浏览器是 **read tier**（只能截图，不能点击/输入），且本 session 多次掉线。
- 用户未装 **Claude-in-Chrome 扩展**（`switch_browser`/`list_connected_browsers` 均空）。
- `chrome://extensions` 的 Developer Mode / 扩展管理是浏览器**原生 UI**，所有工具都点不到。

→ 结论：凡"需要在用户登录态浏览器里操作/安装扩展/改 Chrome 原生设置"的任务，agent 无法代劳，只能：① 引导用户手动 ② 用 DevTools 控制台粘贴（绕过 Tampermonkey/CSP，但有 allow pasting 摩擦）。本 session 因反复"猜测式让用户改设置"消耗了大量来回，应早判定此边界并直接给控制台方案或明确交还用户。

## 结束方式

用户因步骤繁琐叫停，要求落盘。代码已 commit+push 双端一致；停掉本地 http 服务(8765)；HANDOFF 已建，可后续恢复。

## Session Insights / Underlying Patterns

- **推翻假设**：关键词黑名单能覆盖垃圾号 → 被新波无敏感词样本推翻；改多信号形态/行为/语义判据。→ 已固化到本 repo 脚本注释 + README + 本日志。
- **默认假设推翻 / 环境边界**：agent 可远程操控"用户的浏览器" → 实为只能操控独立调试 Chrome；用户登录态日常 Chrome 不可达，浏览器 read-tier，无 Claude 扩展。→ 已固化到 memory `reference_cannot_operate_user_daily_chrome`。
- **工具故障类**：chrome-devtools/computer-use/Claude-in-Chrome 本 session 频繁掉线/不可用，多通道并存但各看到不同实例，易误判。→ 已固化到 memory。
