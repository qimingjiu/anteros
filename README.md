# Anteros · 棕榈杖

安忒洛斯（Anteros）是希腊神话里"被回应的爱"之神——厄洛斯因为孤独而长不大，众神给了他一个兄弟作伴；兄弟俩角力，彩头是一株棕榈。

这个机器人信奉同一条规则：被点名，才开口；开口，必有回应。

一个长期住在 QQ 群里的 AI 机器人：OneBot v11 接入、群聊记忆、工具调用、Markdown 日报、主动问候。TypeScript / Node.js + SQLite（内置 `node:sqlite`，无原生编译依赖）。

## 特性

### 群聊接入与可靠性

- OneBot v11 正向 WebSocket 接入（SnowLuma / NapCat 等协议端）
- 事件先持久化再派发；账号+会话+消息标识唯一索引去重；撤回更新原消息状态
- 发送状态机 queued / in_flight / confirmed / failed / unknown 全部落库；结果不明不盲目重发
- 指数退避重连（1s→60s 加抖动）与心跳看门狗；断线后按锚点补取群历史
- 崩溃恢复：重启后未完成任务按持久化状态续跑，不重复投递

### 群聊记忆

- 按（账号, 群）隔离，私聊与群聊互不混入；保留发言人当时昵称
- 话题按消息间隔自动切分，结束时提取事实（陈述者、涉及人、来源消息）
- candidate / confirmed 分级；`/记忆`、`/记忆确认`、`/记忆作废` 群内修订
- 群友上传的 PDF / DOCX / XLSX 可按需阅读与检索，结论可标注页码与工作表
- 本群全文搜索 `/搜 关键词`，结果带原消息引用；链接查重提醒

### 对话行为

- @、回复机器人、自定义唤醒词三路召唤；专属唤醒词绑定平台真实发送者
- 环境自动接话由主模型自行决定，受冷却、配额与正文去重约束
- 戳一戳反戳；明确的恶意攻击者可被自动拉黑，主人可查阅与解除
- 主人的两分钟连续对话窗口，追问不用重复 @；群友的追问走环境通道，受冷却与配额约束

### 工具

搜索（SearXNG / Tavily / Exa / Google CSE）、网页正文阅读（Readability / trafilatura / 受控渲染，逐跳 robots 与 SSRF 防护）、天气（Open-Meteo，无需 key）、文档生成（Word / PDF / Markdown 直接发 QQ 文件）、Notion 记事与循环提醒、独立邮箱（SMTP / IMAP）、飞书 API 目录式调用、MiniMax 画图与英文语音、MCP 客户端（stdio / Streamable HTTP）挂接外部工具。高权限工具按 `tools.owner_ids` 钉死真实发送者。

### 日报

cron 定时生成 Markdown 群聊日报：今日话题、资源分享、约定待办、未解决问题、趣味片段。人数与消息量全部来自数据库统计，原子写入、`reportKey` 幂等，私聊投递有独立状态机与有限重试。

### 主动消息

早安天气、按时间池抽签决定间隔的随机问候、降雨与降温提醒；可选读取手机传感器事件（EventTap + Supabase）做晨间简报。默认关闭。

### 状态面板与诊断

内置 HTTP 面板：QQ 登录与 OneBot 连接、发送任务、日报投递、MCP 服务器、模型目录与切换、主动消息调度、运行诊断。主人可直接问机器人"刚才为什么失败"，内置只读诊断工具会回答。

## 快速开始

要求 Node.js ≥ 22.22。

```bash
npm install
cp config.example.yaml config.yaml
# 编辑 config.yaml：OneBot 端点、群白名单、模型服务；密钥一律放环境变量（*_env）
npx tsx src/index.ts --config config.yaml
```

状态面板：<http://127.0.0.1:8642>（见 `web` 配置段）。

### 不接真实 QQ 先本地联调

```bash
npm run sim                                # 模拟协议端(3001/3002) + 模拟模型(3003)
npx tsx src/index.ts --config config.sim.yaml

node scripts/inject.mjs "今天天气不错"      # 普通消息：只入库不回复
node scripts/inject.mjs "在吗" --at         # @机器人：触发回复
node scripts/inject.mjs --cmd 帮助          # 指令
```

## 配置

`config.example.yaml` 内每个字段都有注释。要点：

- `groups.allowlist` 为空 = 不响应任何群；`reports.recipient_ids` 为空 = 日报只生成不发送
- 令牌类配置用 `*_env` 指向环境变量；日志自动脱敏
- `tools.owner_ids` 决定 MCP、文档、邮箱等高权限工具的使用者；省略时兼容 `admins`，显式空列表禁止所有人
- `persona` 定义机器人的人设：短人设直接写 `prompt`，长人设放进单独文件（格式参考 `persona.example.md`，你自己的 `persona.md` 已被 .gitignore 排除）

## 架构

```
src/
  index.ts        入口：装配、优雅退出、保留期清理
  config.ts       YAML 配置加载与校验
  types.ts        统一消息模型 / Provider 契约 / 工具与记忆类型
  db/             SQLite（WAL）：消息、发送任务、记忆、话题、日报、投递、停机区间
  onebot/         OneBot v11 Provider：动作调用、心跳看门狗、登录与能力探测
  gateway/        持久化优先、去重、发送队列状态机、重连补取
  llm/            OpenAI 兼容客户端、模型目录发现与运行时切换
  memory/         话题切分、事实提取、检索、修订、遗忘
  agent/          触发判定、上下文装配、工具调用循环、接话限制
  tools/          搜索、网页阅读、天气、Notion、邮箱、MiniMax、飞书、MCP 客户端
  documents/      Word/PDF/Markdown 生成与 QQ 文件投递；接收文件解析
  report/         日报调度、聚合、生成、私聊投递
  proactive/      主动消息与时间池
  presence/       手机传感器事件（可选）
  diagnostics/    运行诊断（脱敏）
  tasks/          多步任务跟踪
  web/            状态面板（原生 http，无框架）
scripts/          本地模拟联调、消息注入、Supabase 建表、飞书 MCP 辅助
deploy/           服务器增量部署脚本（参数化，见文件头注释）
test/             单元 + 端到端冒烟（进程内假 Provider，900+ 用例）
docs/             详细行为与边界说明
```

贯穿全栈的几条原则：先持久化再处理；结果不明不自动重试；群与私聊严格隔离；网页与文件内容只是资料，永远不能提升为指令；密钥只在环境变量里。

## 开发

```bash
npm test            # 全量测试
npm run typecheck   # 类型检查
npm run build       # 编译到 dist/
```

## 部署

`deploy/` 提供 systemd 服务器的增量更新脚本（先本地全量测试与构建，再备份、替换、健康检查，失败自动回滚）。首次完整安装用 `deploy/deploy.sh`，日常更新用 `deploy/update-runtime.sh`。所有脚本的服务器地址与身份标识均通过参数或环境变量传入，见各文件头注释。

## 许可与声明

- 代码以 [MIT](LICENSE) 发布。`assets/document-fonts/` 内的 Noto 字体按 SIL OFL 授权，见其 LICENSE。
- 本仓库为原创实现，未复制 NapCat / SnowLuma 的代码或二进制组件；二者仅作为协议行为参考，其许可条款不影响本项目。引入外部 MCP server 或搜索服务时，遵守其各自条款。
- 本项目通过 OneBot 协议端与 QQ 交互，仅供学习交流；请自行评估账号风险并遵守平台规则。
