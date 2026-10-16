---
name: gemini-argon
description: 在 macOS 上检查、连接或排查本人 Gemini App Argon 与 Claude Code 的本机桥接，包括凭据核验、缺失配置补齐及启动；不是通用 Gemini API 配置或账号共享工具。
---

# Gemini App Argon 本机桥接

使用本 Skill 附带的运行时，不下载其他人的登录文件，不把当前智能体的模型与新启动的 Claude Code 会话混为一谈。Skill 是连接操作说明，真正的请求由本机服务转发；加载 Skill 本身不会切换当前会话的底层模型。

先确定本文件所在目录的绝对路径，以下 `<skill-dir>` 均替换成该目录，不依赖当前工作目录。不需要将 Skill 安装进任何智能体即可执行脚本。只有用户要求安装 Skill 时，才复制到其选择的 Skill 目录；不要自行修改 Codex、Claude 的全局设置。

## 执行

1. 先运行 `node "<skill-dir>/scripts/argon.mjs" doctor`。这是本地检查，不读取钥匙串、不发送模型请求。优先检查 `package_integrity`；失败则停止使用该副本。
2. 用户要求配置或修复时，运行 `doctor --repair --install-deps`：只补齐专用状态目录、本地口令、现有 App/Claude 路径和网络配置，以及包内锁定依赖。不会安装全局软件、修改代理规则或放宽系统安全设置。读输出中的 `action_required`，逐项处理，不把进程存在或 HTTP 200 当成完整可用。
3. 只有首次连接或已明确撤销时，说明将读取**当前用户 Gemini App 专用授权与专用钥匙串项目**，向 Google 验证账号和客户端，并仅写到本机私有状态目录。取得用户针对该读取的明确同意后运行 `connect --consent-local-auth`。钥匙串弹窗必须由本人确认；不索要聊天中的密码，不修改 ACL。取消后停止，不循环弹窗。
4. 运行 `doctor --verify-auth` 核验 Google 账号、客户端、有效期。临近到期自动续期；拒绝授权则停止。不同账号的登录文件不能交叉补用。
5. 用户同意进行真实验证时，运行 `doctor --verify-auth --smoke`。至多发送一条固定短消息，可能消耗本人额度；不要为了凑“通过”重复调用。看 `liveVerified: true`，不能只看 `ready`。
6. 首次配置收尾时创建快捷命令：说明将复制程序到本人 App Support 下的固定运行目录，并在 `~/.local/bin/` 创建 `claude-argon`；若目录不在 PATH，`--configure-path` 会先备份再给本人 `~/.zprofile` 追加带标记的 PATH 配置。用户同意这些本机安装步骤后运行 `node "<skill-dir>/scripts/argon.mjs" install-command --configure-path`。已有其他同名命令会拒绝覆盖，不自动卸载、改名或替换。只需要创建快捷命令而不改 shell 配置时省略 `--configure-path`。Skill 本身不会安装进 Codex/Claude，也不会改其全局配置。
7. 安装成功后让用户重新打开终端（或在当前终端执行返回的 `activateCurrentTerminal`），再在项目目录运行 `claude-argon`，单次请求用 `claude-argon -p '用户要求'`。固定运行目录不依赖解压包，解压包之后可以移动；日常无需重复执行 Skill，授权失效等情况再回来修复。也可不安装快捷命令，继续用 `node "<skill-dir>/scripts/argon.mjs" chat`。不要从一个正在运行的 Claude 会话递归启动另一个代理来伪装模型切换；无法提供交互终端时给出启动命令。

缺少 Node、Claude Code、Gemini App、账号权限或出现未知 App 版本时，阅读 [setup.md](references/setup.md)。可补齐本机非秘密配置；不能伪造凭据、复制发布者账号、静默回退到其他模型，不能自动猜测未知二进制偏移。

## 能力与边界

- 目前只验证 macOS Apple Silicon、Gemini App `1.128.14.1166` 的指定 SHA-256；不宣称 Windows/Intel 或其他 App 版本已兼容。
- 请求由协议字段重新构造，不依赖发布者的抓包、设备标识、代理节点或访问令牌。模型选择参数只从接收者自己的已验证 App 安装包中读取；身份来自接收者自己的授权。
- Claude Code 仍执行自己的 Read/Edit/Bash，并负责权限检查。没有默认跳过权限；文字格式适配不等于原生 function calling。当前 `--bare` 隔离启动不会自动加载个人 CLAUDE.md、其他 Skills、插件、hooks。
- 图片/二进制、原生角色隔离、真正逐 token 流和所有 Claude 工具未获完整支持。完整上下文限 250 KB。模型内部标识不能仅靠模型自述证实；Argon 别名依据已观察到的 App 选项与相同协议选择参数。
- 返回的 token 用量为占位值，不代表免费。代码和工具结果会发送至本人 Google 账号；不要读取或发送用户未授权的资料。
- 状态目录为 `~/Library/Application Support/gemini-argon-skill/`，不写进分享包。只监听 `127.0.0.1:18185`；不把该本机服务暴露到局域网或公网。
- 收到错误时报告具体缺项、已验证项和仍未知项；不宣称账号已登录就一定有 Argon 权限，不保证此非官方接口长期可用。
