# 接收者配置与故障处理

## 分享和使用

收到压缩包后解压，保留 `gemini-argon` 整个目录。直接让有本机文件/终端能力的智能体读取 `gemini-argon/SKILL.md`，或在终端运行其中的命令；无需先安装 Skill。

如果希望在 Claude Code 中以 `/gemini-argon` 使用，由接收者自行把整个 `gemini-argon` 文件夹复制到项目的 `.claude/skills/` 或个人 `~/.claude/skills/` 下。不要只复制 SKILL.md。这是接收者的选择，本包不会自己安装。已经启动的 Claude Code 不会因加载 Skill 直接换模型；要用桥接启动一个新的会话。

Claude Code Skill 布局参见 [官方 Skills 文档](https://code.claude.com/docs/en/skills)。Claude CLI 安装参见 [官方安装说明](https://code.claude.com/docs/en/setup)，Node 参见 [Node.js 下载](https://nodejs.org/en/download)。依赖缺失时先检查本机已有可用版本，安装系统软件需遵循用户指定方式；不要下载来源不明的 Gemini 安装包。本包不附带 Google 或 Anthropic 客户端本体。

## 自动补齐范围

- `doctor --repair`：建立独立 0700 状态目录；首次生成随机的 0600 本地网关口令；探测现有 Claude 和 Gemini 路径；探测环境变量/系统的本机 HTTP 代理、常见本地代理端口，否则使用直连；保存 0600 配置。
- `--install-deps`：仅在 `runtime` 内用 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定依赖。不安装全局命令或运行包安装脚本。需要可用 npm 与网络。
- `connect --consent-local-auth`：由本人同意后读取本人 App 专用项目；Google 验证通过才原子写入本机授权。不会把 Mac/Google 密码写入文件。
- `--verify-auth`：检查文件权限与结构、Google 返回的账号和 OAuth 客户端、到期时间。到期前续期；后续续期也验证账号，Google 拒绝时停止重试。
- 缺少访问令牌但有完整有效续期授权时可刷新。缺少 refresh token 或客户端参数时不能凭空生成，必须本人重新连接。
- `install-command`：环境和授权检查就绪后，把无状态程序复制到本人状态目录的 `releases/<清单哈希>/`，在该固定副本里安装锁定依赖，创建 `~/.local/bin/claude-argon`；之后移动/删除解压包不影响命令。`--configure-path` 仅在需要时备份并追加本人 `.zprofile`，默认只支持 zsh；不修改 Codex/Claude 配置。已有不同的同名命令、符号链接或不安全目录会明确拒绝，不自动覆盖。相同安装可重复执行。

首次完成命令安装后重新打开终端，再在项目目录运行 `claude-argon`。安装进程不能修改它的父终端环境；不重开终端时可执行返回的 `activateCurrentTerminal`。其他 shell 自行配置 PATH，程序不会猜测或修改其启动文件。更新后的分享包若遇到旧入口也会拒绝覆盖，需先由本人确认旧入口归属与升级方式。

可显式设置 `ARGON_APP_BINARY`、`ARGON_CLAUDE_BIN`、`ARGON_PROXY`、`ARGON_PORT`、`ARGON_STATE_DIR`。代理只接受无用户名密码的本机 `http://127.0.0.1:端口` / localhost / IPv6 loopback，或 `direct`。不自动切换节点、账户地区、系统代理、TLS 信任或证书。`network_route_config: ok` 仅表示找到合法配置，不是连通性证明。

## 常见结果

| 结果 | 处理 |
| --- | --- |
| 缺少凭据 | 本人登录 Gemini App 后明确同意一次 `connect`。 |
| 授权即将到期 | `--verify-auth` 或实际请求自动续期，不重新读钥匙串。 |
| Google 撤销/拒绝授权 | 停止后台重试，要求本人重新登录并连接。 |
| App 版本未支持 | 安装包哈希不匹配就停止。需更新适配器并复验；不能通过删除哈希检查解决。 |
| Google 地区/账号权限错误 | 报告上游错误，由本人确认官方可用性及 App 是否可用。不承诺用 Skill 绕过限制。 |
| 本机端口已有其他服务 | 使用另一个 `ARGON_PORT`，不杀掉未知进程；不同状态目录的服务不能混用。 |
| 口令损坏/权限不安全 | 报告具体文件类型。只允许修复专用文件的权限；不静默覆盖已有有效凭据，不修改其他项目文件。 |
| npm/网络失败 | 保留已有配置与授权，解决网络后只重跑依赖步骤；不重读钥匙串。 |
| 模型文字正常但工具失败 | 检查输入 schema、完整历史与 Claude 权限；不要宣称所有 Claude 工具都已支持。 |

## 维护与隐私

本包是实验性本机兼容层，不是 Google 或 Anthropic 官方服务。客户端更新、账号资格、网络环境、上游限制均可能影响可用性。MANIFEST 仅验证包内文件完整性，不是发布者数字签名，不能证明来源可信。

**只分享原始压缩包或其无状态 Skill 文件夹，不分享接收者的 App Support 状态目录。** 状态里的 `oauth.json`、`gateway-token`、日志、对话、请求和 Google/App 数据都不应该加入再分发包。卸载时先正常退出使用该包的会话；不要删除其他项目或发布者原有桥接的数据。
