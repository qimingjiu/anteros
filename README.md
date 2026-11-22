# 安忒洛斯 Anteros

安忒洛斯是一个同时接入 QQ、Discord 和 Telegram 的聊天机器人，也可以做三个入口共用的多人家庭。群里用原来的接话、搜索、记忆和日报。主人可以在任何已绑定的私聊翻牌子、接着聊，或让一个成员在后台做事，把结果发到另一个平台。

| 入口 | 接入方式 | 会话标识 |
| --- | --- | --- |
| QQ | OneBot v11 正向 WebSocket，沿用已有的 SnowLuma、NapCat 等协议端 | 私聊用 QQ 号，群聊用群号 |
| Discord | Discord Bot Gateway | 私聊用用户 ID，群聊用文字频道或线程 ID |
| Telegram | Telegram Bot API 长轮询 | 私聊用用户 ID，群用负数 chat ID，论坛话题可写成 `群ID:话题ID` |

一个 Node.js 进程和一份 SQLite 数据库就能运行三个入口。可以从单端开始，也可以沿用现有安忒洛斯配置增加入口。QQ 仍需 OneBot 协议端。

## 开始使用

需要 **Node.js 22.22.2 或更高版本**。安装依赖后，将 [config.example.yaml](config.example.yaml) 复制为 `config.yaml`，填好主账号、模型和工具所有者。平台及模型令牌放在 `.env` 或部署环境里，对应 YAML 的 `*_env` 字段。

```bash
npm ci
cp config.example.yaml config.yaml
npm start
```

Windows 可用 PowerShell 的 `Copy-Item config.example.yaml config.yaml`。自定义配置路径用 `npm start -- --config config.yaml`。状态面板默认在 `http://127.0.0.1:8642`，`/api/status` 能看到每个已启用账号的连接和登录状态。

- **QQ** 在协议端启用正向 WebSocket，填进 `gateway.onebot.endpoint`。跨端发文件时，如果 OneBot 跑在容器里，`documents.output_dir` 和 `documents.provider_output_dir` 要指向同一挂载的宿主目录和容器目录。
- **Discord** 在开发者后台创建 Bot，打开 Message Content Intent 和 Server Members Intent，邀请进服务器并授予目标频道内读写消息、附件权限。使用既有点歌和通话时另授予语音连接及发言权限。
- **Telegram** 用 BotFather 创建机器人，先在 Telegram 私聊里点 Start。Bot 所在的群或话题要加到账号的 `groups`。Telegram 入口只处理登记所有者发来的消息。群里的普通消息还受 Telegram 隐私模式及群权限影响。长轮询启动前移除该 Bot 的旧 Webhook。

## 三端配置

以下是要并入 `config.yaml` 的段落。保留原有 `model`、`groups`、`documents`、`tools` 等配置，将示例 ID 换成实际平台 ID，并保留引号。已有实例应保留主入口的 `account_id` 和数据库路径。

```yaml
gateway:
  provider: onebot
  account_id: default
  onebot:
    endpoint: ws://127.0.0.1:3001
    token_env: ONEBOT_TOKEN
  additional_accounts:
    - provider: discord
      account_id: discord
      token_env: DISCORD_BOT_TOKEN
      owner_id: "123456789012345678"
      groups: ["234567890123456789"]
    - provider: telegram
      account_id: telegram
      token_env: TELEGRAM_BOT_TOKEN
      owner_id: "123456789"
      groups: ["-1001234567890:42"]

tools:
  enabled: true
  owner_ids: ["10001"]

family:
  owner_id: "10001"

cross_platform:
  destinations:
    - id: qq
      account_id: default
      conversation_type: private
      target_id: "10001"
    - id: dc
      aliases: [Discord书房]
      account_id: discord
      conversation_type: group
      target_id: "234567890123456789"
    - id: tg
      account_id: telegram
      conversation_type: private
      target_id: "123456789"

web:
  enabled: true
  host: 127.0.0.1
  port: 8642
  token_env: ANTEROS_WEB_TOKEN
```

`groups.allowlist` 管主账号的群。附加账号用自己的 `groups`，默认只对明确 @ 的群消息接话。将该账号的 `mention_only` 设为 `[]` 可让这些群使用常规接话规则。群发言人按各自平台的实际 ID 识别。`owner_id` 或 `tools.owner_ids` 只能登记你实际控制的用户。配置了 `family.owner_id` 时，主账号的这个用户和每个附加账号的 `owner_id` 被绑定到同一个家庭私聊。

`cross_platform.destinations` 允许为同一平台登记多个目的地，每个 `id` 和别名唯一。可以使用 `capabilities: [text, file, image, voice]` 细化权限。默认单次文件上限为 8 MiB，可以为目标单独设定 `max_file_bytes`。实际上传还受各平台和协议端限制。

## 怎么用

### 三端互发

- 在 QQ 说「把这份会议纪要整理成 Word 发到 dc」，安忒洛斯会生成文档并投递到配置指定的 Discord 会话。
- 在 Discord 说「把这段话发到 tg」，或把附件随消息上传并写「把附件发到 tg」。
- 在 Telegram 上传图片并说「把这张图发到 qq」。要发语音，可以同时指定生成内容和别名，例如「把这句英文用语音发到 dc」。

程序会核对当条原话指定的目的地、发送者和媒体类型。发送任务与平台回执持久化，状态区分排队、发送中、成功、失败和回执不明。回执不明的跨端任务重启后不会自动重复发送。日常回复仍回到来信的会话。群的消息和记忆各自保留在原群。

### 多人家庭

将成员卡放进 `personas/`（格式见 [personas.example](personas.example)），默认成员使用配置里的 `persona`。在任意已绑定私聊说「翻牌子」或「让雾岛纪来」。切换、交接便签以及其他已绑定私聊中的近期原话，会在下一个入口继续生效。群聊使用群里的对话上下文。

在主人私聊用 `/房间` 查看列表和房间 ID，`/房间 创建 书房 | κόραξ、雾岛纪` 创建并进入书房，`/房间 进入 客厅` 回到客厅。用 `/房间 成员 κόραξ、雾岛纪` 修改当前自建房间的成员。QQ、Discord 和 Telegram 共用当前房间，各房间独立保存接话成员、交接便签、历史、笔记和文件授权。已有家庭历史归入客厅。工作台和 IDE 可以单独浏览房间。

- 原有的递牌子、信件、拆信、串门和成员日记继续使用同一份成员名册。
- 每个成员有自己的笔记、文件版本和工作台。可以归档当前附件、保留有来源的笔记、明确分享文件，或者收纳网址后按名称、类别和关键词找回。
- 可以问「找一下我们之前聊的开源项目」。历史召回先匹配原短语，再按词语相关性排序，返回当前房间对应的原话、署名、平台和时间。
- 「让雾岛纪在后台整理这份提纲」可以创建成员任务。暂停、继续、取消、写检查点和交接都从主人私聊发起。文字产物进入成员工作台，指定了跨端目的地时进入发送队列。
- 可以设一次性或重复闹钟、待办提醒、每日署名日记、网页变化监测，以及任务完成或失败通知。日记保留可见原话，网页通过安忒洛斯已有的网页阅读器读取。
- 在绑定私聊说「换模型」，菜单对当前成员生效，选择跨端和重启保留。群聊及其记忆摘要继续使用安忒洛斯的全局模型。
- 配置 `web.token_env` 后打开 `/family`，可以查看成员工作区、任务和收件箱，下载产物。需要在 IDE 中使用时，可用工作台同一地址下的 `/ide-toolbox.js` 载入收纳组件。不同来源的 IDE 页面需在 `ANTEROS_IDE_ORIGINS` 列出精确的允许来源。

```js
const { installToolboxDock } = await import(new URL("/ide-toolbox.js", panelURL));
const dock = installToolboxDock({ gatewayURL: panelURL, getToken });
```

#### 成员模型接替和后台工具

下面使用成员卡的稳定 ID `kirishima`。模型档位名指 `model.profiles` 的 `name` 或模型目录中的完整档位名。配置后，选中的模型受限流、超时或服务故障影响时，可在同一轮用名单里的备用档位接替。接替成功的档位和失败档位的冷却都会记录在数据库里。可给档位填 `capabilities: { tools: false, vision: false }`，以便在需要工具或图片的本轮跳过该档位。

```yaml
family:
  owner_id: "10001"
  model_failover:
    kirishima:
      primary_profile: main
      fallback_profiles: [backup]
      max_attempts: 3
      attempt_timeout_ms: 30000
      total_timeout_ms: 60000
      cooldown_ms: 60000
  background_mcp_tools:
    - mcp__project__search
  signal_token_env: ANTEROS_SIGNAL_TOKEN
```

后台任务可在上面的成员和房间范围内使用已启用的搜索、网页阅读、天气、文件阅读以及列出的 MCP 工具。任务的检查点和工具回执持久化。暂停、切换成员或重启后，已经返回的相同调用可复用回执；未确认的外部调用保留状态。

#### 外部事件通知

在要收通知的房间说「每次收到 build.done，状态是 ready，就发到 tg 提醒我」。外部服务可以向 `POST /api/family/signals` 发 JSON。令牌从 `family.signal_token_env` 读取，省略该设置时使用面板令牌。请求用 `Authorization: Bearer …`，默认投给客厅，可填从 `/房间` 取得的房间 ID。重试时发送相同的事件 ID 和内容。

```json
{"id":"build-27","name":"build.done","room":"family","data":{"status":"ready"}}
```

也可以在房间里说「MCP project 安装有结果时通知我」。匹配到的通知先写进该成员的收件箱，再送往原私聊或主人指定的三端目的地。

### 安忒洛斯已有功能

QQ 的 @、引用和别名唤醒、戳一戳、群内自然接话、断线补取、搜群消息、群记忆修订和 Markdown 日报仍使用原来的实现。Discord 保留相同聊天工具及原有点歌、语音消息、通话能力。网页搜索、网页阅读、天气、文档、Notion、邮箱、飞书和 MiniMax 仍按各自配置启用。MCP 工具继续由安忒洛斯统一连接和执行。

### 管理 MCP

启用 `tools.mcp.enabled` 和 `tools.mcp.managed_enabled`，设置 `web.token_env` 后打开 `/mcp`。输入面板令牌可以搜索 Registry、提交固定版本的 npm、Python 或 Docker 服务，或登记公开 HTTPS 的 Streamable HTTP 服务。页面显示安装和连接状态，可以更新、启停或卸载。填写的凭据加密保存，服务清单引用凭据名。

托管服务声明允许的成员 ID 和房间。客厅用 `family`，自建房间用 `/房间` 显示的 ID。例如给雾岛纪在客厅开放某个服务时，可将其成员卡 ID 写进 `allowedAgents`、把 `family` 写进 `allowedRooms`。原有 YAML 中声明的 MCP 服务器继续使用原来的配置和权限。

Docker 方式要求运行安忒洛斯的用户能使用本机 Linux 容器引擎，镜像通过 stdio 提供 MCP。清单使用 `kind: "docker"` 和带明确版本标签或 SHA-256 digest 的 `image`。安忒洛斯拉取后固定镜像，启动时沿用固定版本。更新后的服务通过 MCP 握手再替换旧实例。

## 更新已有安装

备份 `config.yaml`、`.env`、`personas/`、已有 SQLite 数据库和它所在的数据目录，再停止旧实例，启动新版。数据库会自动增加发送账号字段，历史任务归到原主账号。成员卡、旧信件和日记继续从原有文件读取。给同一 OneBot、Discord Bot 或 Telegram Bot 保留一个正在运行的接收实例。

```bash
npm run typecheck
npm run build
npm test
```

开发联调可用 `npm run sim` 与 `npm start -- --config config.sim.yaml`。跨端发送、Telegram 轮询和家庭工作台有本地模拟测试。平台权限、容器挂载、真实群文件和原生语音请在首次部署时用自己的账号核对。

如果安装时服务器无法下载内置 FFmpeg，可安装系统 FFmpeg，设置 `FFMPEG_PATH` 指向可执行文件，再运行 `npm ci --ignore-scripts`。跨端音频转换及 Discord 音乐、语音用到 FFmpeg。

更多现有功能和故障检查见 [运行说明](docs/operations.md) 和 [完整配置示例](config.example.yaml)。项目使用 [MIT](LICENSE) 许可。
