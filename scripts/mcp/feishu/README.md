# 飞书官方 MCP 运行代码

这是 `/opt/qq-group-bot-mcp/feishu` 运行程序的源码镜像。代码固定使用官方 `@larksuiteoapi/lark-mcp 0.5.1`；设备授权使用官方 `@larksuite/cli 1.0.98`。两个安装目录独立，锁文件均已保存。此目录不含凭据、访问令牌或设备授权状态。

## 重建目录

把本目录顶层运行文件与顶层 `package.json`、`package-lock.json` 放到 `/opt/qq-group-bot-mcp/feishu`，执行 `npm ci --omit=dev`。把 `device-cli/` 的两个包文件放到 `/opt/qq-group-bot-mcp/feishu-cli`，在该目录执行 `npm ci --omit=dev`。运行程序使用这两个固定绝对路径；源码镜像自身放在 QQ 项目的 `scripts/` 下不改变这些路径。

`generate-catalog.cjs` 可从锁定版本重新生成 `selected-tools.json`、`tool-auth-modes.json`。它只选择文档、云盘、多维表格、电子表格、幻灯片、知识库和邮箱业务域。在 0.5.1 中得到 229 个 API，幻灯片域尚无工具，电子表格单元格批量读写也不在该版目录内。发现工具不代表应用或用户已具备对应权限。

## 私密配置

仅在服务器运行目录创建权限 `0600` 的 `.env`，父目录权限 `0700`：

```dotenv
FEISHU_APP_ID=<应用标识>
FEISHU_APP_SECRET=<应用密钥>
FEISHU_EXPECTED_USER_OPEN_ID=<本次获准登录的用户标识>
```

不得把实际配置、`user-token.private.json`、设备授权文件、CLI 密钥存储目录或 MCP 缓存提交到项目。

启动入口是 `/usr/bin/node --env-file=/opt/qq-group-bot-mcp/feishu/.env /opt/qq-group-bot-mcp/feishu/run.mjs`。密钥不进入命令行参数。程序使用隔离 HOME/XDG 目录，不读取原有 MCP 登录缓存。

`run.mjs` 使用官方程序库的 `auto` 模式。经过身份核对的新用户令牌启用后，支持用户身份的 API 默认以用户身份调用，只有应用身份的 API 使用应用身份。模型提供的 `useUAT` 会被服务器覆盖。用户身份尚未启用时，可兼容应用身份的接口仍使用应用身份，仅用户接口返回缺登录。

## 重新登录

1. 首次准备隔离 CLI 配置时运行 `python3 prepare-login.py`。应用密钥通过 stdin 交给官方 CLI，设备授权使用 Bearer 模式以兼容官方 MCP。
2. 仅在本人准备好扫码时运行 `python3 start-device-login.py`。它请求应用已经获准的相关用户权限，输出官方登录链接，并生成 `/tmp/qqbot-feishu-login.png`。设备 code 保存在私密文件，不输出。
3. 运行 `python3 poll-device-login.py` 等待授权。令牌只写入权限 `0600` 的 `user-token.private.json`。
4. 运行 `python3 validate-user.py` 核对实际登录用户。仅当与预先配置的用户一致时，才写入 `user-token.enabled.json`。程序只输出是否匹配，不输出用户标识或令牌。
5. 运行 `node probe.mjs` 做只读连接、权限和列表检查；然后统一重启 QQ bot，让 MCP 子进程采用新用户身份。

授权链接过期后应等待本人准备好，再重新发起一次；不自动反复建立授权。不要从旧项目、旧缓存或已过期 refresh token 恢复身份。

需要本人扫码后自动完成服务器动作时，可在发起本次登录后，只启动一次 `complete-device-login.py` 后台进程。它只等待这一次授权，身份与预先指定的用户匹配后才启用新令牌，重启 QQ bot 载入用户身份，再执行只读验收。超时、拒绝或身份不匹配会停止，不建立新授权，不向外发送通知，不写业务资源。结果仅包含状态、计数和错误类别，保存在运行目录 `login-completion.public.json`。`python3 test-completion.py` 使用临时目录及模拟子进程验证成功、拒绝、过期、错误用户和超时分支，不执行真实重启或 API 请求。

`user-token.mjs` 按需通过官方 `https://accounts.feishu.cn/oauth/v3/token` 刷新访问令牌，使用单进程 Promise 与文件锁防止并发刷新，原子替换私密令牌文件。重新登录后的真实刷新仍需在相应授权生效后验证。刷新失败会要求重新登录，不会把用户请求悄悄切到另一身份。

## 验证范围

`probe.mjs` 只执行凭据鉴权、权限/应用信息查询、MCP 工具发现、云盘文件列表和知识库空间列表检查；不创建文档，不发邮件或消息，不打印列表正文。连接成功、权限成功、资源可见和业务写入成功是不同结果，应分别报告。

QQ 主程序只向主人提供 `feishu_tools` 与 `feishu_call` 两个入口。原始 `mcp__feishu__` 工具不得直接向模型暴露；写入、发送、删除等动作仍由主程序的真实主人指令和任务重放保护控制。

官方来源：[MCP 源码](https://github.com/larksuite/lark-openapi-mcp)、[CLI 源码与设备登录说明](https://github.com/larksuite/cli)、[设备授权和令牌交换实现](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go)。
