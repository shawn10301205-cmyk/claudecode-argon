# Claude Code × Gemini Argon

让 Claude Code 通过本机桥接调用 Gemini App 中的 Argon。原理很简单：桥接服务转换两边的请求与响应格式，Claude Code 负责工具执行，Gemini 提供模型回复。

本仓库提供首次配置用的 Skill 和配套运行时；配置完成后，在项目目录输入 `claude-argon` 即可启动。**使用者必须使用自己的账号与授权，不提供共享账号或共享凭据。**

## 适用环境

这是用于 **macOS Apple Silicon** 的实验性本机桥接 Skill。把整个文件夹或 ZIP 发给别人即可；**没有安装进制作者的 Codex**。接收者需要自己的 Gemini App、自己的 Google 登录、Node.js 22+、npm 和 Claude Code。

当前仅验证 Gemini App **1.128.14.1166** 的指定安装包。其他版本会明确拒绝，不会错误读取凭据。没有 Windows/Intel 兼容性承诺。本包不包含 Google/Anthropic 官方 App，也不是官方接口产品。

## 最简单用法

让接收者的本地智能体读取本包 `gemini-argon/SKILL.md`，并说：

> 按这个 Skill 完成我的 Gemini Argon 首次配置。检查和补齐依赖、路径与配置。读取本人 App 专用授权前先说明并征得我同意，不要使用其他人的登录文件；验证成功后，帮我安装 claude-argon 快捷命令，必要的 PATH 修改先说明并备份。

也可以直接打开终端，进入本包的 `gemini-argon` 文件夹：

```sh
node scripts/argon.mjs doctor
node scripts/argon.mjs doctor --repair --install-deps
```

第一次需要连接自己的账号。确认同意读取**本人 Gemini App 专用授权**后再执行：

```sh
node scripts/argon.mjs connect --consent-local-auth
```

macOS 钥匙串弹窗由本人确认。不需要把 Mac 或 Google 密码发给任何人。

验证授权并用本人额度发送一次短消息：

```sh
node scripts/argon.mjs doctor --verify-auth --smoke
```

成功时输出 `ready: true` 和 `liveVerified: true`。最后安装日常命令：

```sh
node scripts/argon.mjs install-command --configure-path
```

该步骤把运行程序复制到本人 App Support 的固定目录，在 `~/.local/bin/` 创建 `claude-argon`。若命令目录不在 PATH，会先备份再为本人 `~/.zprofile` 追加一小段标记配置；不想改 shell 配置可省略 `--configure-path`。已有同名命令不会覆盖，会明确报错。

**重新打开终端**（或执行安装结果中的 `activateCurrentTerminal`），进入要写代码的项目目录，以后直接运行：

```sh
claude-argon
# 或单次请求
claude-argon -p '帮我检查这个项目'
```

首次配置完成后，不必每次再执行 Skill。解压包可以移动或删除，已安装的运行程序会保留。保留 Node、Claude Code、Gemini App 和私有状态目录；授权撤销或版本变化时再用 Skill 检查修复。也可以不安装快捷命令，继续用本包 `node scripts/argon.mjs chat` 启动。

## 包含什么

- Skill 说明、本机桥接运行时、依赖锁定文件及文件完整性清单。
- 凭据结构/权限/账号/客户端/到期校验；自动续期；缺少短期 access token 时用完整续期授权恢复。
- 缺失本地口令、路径、代理配置和包内依赖的补齐流程。
- 一次性创建日常 `claude-argon` 命令，固定运行目录与 PATH 配置；重跑不会重复追加或覆盖其他入口。
- 按协议重新构造请求；**不依赖制作者的私有抓包**。

## 不包含什么

不含制作者的密码、Google 访问/续期令牌、App 授权文件、设备标识、代理节点、抓包、聊天记录、测试项目或本地日志。接收者自己的授权只存入其本机 `~/Library/Application Support/gemini-argon-skill/`，不要分享该目录。

Skill 本身不会改变已运行会话的模型；要通过本包启动新的 Claude Code 会话。工具仍由 Claude Code 执行并检查权限。当前是文字协议兼容层，不是已验证的原生 function calling；图片/二进制与真正逐 token 流暂不支持。token/费用显示是占位值，**不是免费承诺**。

首次连接、地区/账号资格、App 版本不兼容等不能靠复制别人凭据解决。遇到这些情况会清楚报告，不会默认切换模型、不修改系统代理或 TLS 安全设置。

ZIP 中不附带 node_modules；上述命令根据锁定文件在本包内安装依赖。只分享原始 ZIP，不分享任何个人状态目录。

## 获取源码

```sh
git clone https://github.com/shawn10301205-cmyk/claudecode-argon.git
cd claudecode-argon/gemini-argon
node scripts/argon.mjs doctor
```

也可在 GitHub 点击 **Code → Download ZIP**。仓库不包含 `node_modules`；首次安装按上面的锁定依赖步骤执行。不要把自己生成的授权、网关口令、配置或日志提交到仓库。
