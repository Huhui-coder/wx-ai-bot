# wx-ai-bot · 微信小助理

一个本机运行的轻量微信 AI 助手。填写 DeepSeek 或其他兼容 Chat Completions 的模型 API，扫码绑定微信；日常聊天和电脑操作均由你配置的模型处理。

不要求安装 Hermes、OpenClaw、Claude Code 或 Codex。

## 一条命令安装并打开

发布版为单文件命令行程序，内置运行时和网页。用户无需安装 Python、Node.js、Bun 或 npm。首次填写模型 Key、微信扫码；后续启动自动恢复已保存的配置。

macOS（Apple Silicon 与 Intel）：

```bash
curl -fsSL https://raw.githubusercontent.com/Huhui-coder/wx-ai-bot/main/install.sh | sh
```

Windows 64 位，在 PowerShell 中执行：

```powershell
irm https://raw.githubusercontent.com/Huhui-coder/wx-ai-bot/main/install.ps1 | iex
```

安装器会从 [GitHub Releases](https://github.com/Huhui-coder/wx-ai-bot/releases) 下载对应系统的程序，验证 SHA-256，安装到当前用户目录并自动打开网页，不需要管理员权限。

也可以手动下载单文件：

| 系统 | 文件 |
| --- | --- |
| macOS Apple Silicon | `weixin-lite-darwin-arm64` |
| macOS Intel | `weixin-lite-darwin-x64` |
| Windows x64 | `weixin-lite-windows-x64.exe` |

macOS 手动下载后先 `chmod +x 文件名`，再运行文件；Windows 可直接运行 exe。当前发布包没有 Apple 公证或 Windows 代码签名，系统可能提示确认来源。Windows ARM 暂未提供原生版本。

## 启动、状态、停止

macOS 安装后：

```bash
~/.local/bin/weixin-lite
~/.local/bin/weixin-lite status
~/.local/bin/weixin-lite stop
```

Windows 安装后：

```powershell
& "$env:LOCALAPPDATA\WeixinLite\weixin-lite.exe"
& "$env:LOCALAPPDATA\WeixinLite\weixin-lite.exe" status
& "$env:LOCALAPPDATA\WeixinLite\weixin-lite.exe" stop
```

把程序所在目录加入 PATH 后即可使用 `weixin-lite`、`weixin-lite status`、`weixin-lite stop`。默认命令会后台启动并打开浏览器，关闭终端和网页不影响服务；重复运行会打开已有页面，不创建第二个微信连接。

更新已有安装时，先用上面的 `stop` 命令停止后台服务，再重新执行安装命令；配置和微信绑定会保留。已运行的服务不会因为替换程序文件而自动重启。

默认仅监听本机 `127.0.0.1:3210`；`--port 端口` 可指定端口，`--no-open` 可关闭自动打开浏览器。`logs` 查看最近日志，`--help` 查看帮助。数据及登录状态保存在用户目录，不在程序文件旁。

## 使用

1. 在「连接设置」选择 DeepSeek，填写 API Key，保存后测试连接。自定义服务可填写自己的 API 地址和模型名称；须支持 OpenAI 风格的工具调用。
2. 选择工作目录。可以先在本机「对话」页面验证模型与电脑工具。
3. 点击「生成微信二维码」，用手机微信扫码并确认。如微信要求数字验证，在设置页填写。
4. 在微信给 Bot 发消息。只有扫码绑定的用户可以发起任务。

API Key 在本机设置页输入，无需发到开发者聊天里。Key 不会随普通消息传给模型，也不会提供给命令子进程。macOS 配置文件以 `0600` 权限保存，Windows 使用当前用户目录的访问权限；当前尚未接入系统钥匙串。

默认写文件、执行命令、安装 Skill 需要允许一次，可在页面操作或微信回复 `/approve 编号`。信任当前电脑环境时，可在设置中开启自动执行。shell 使用当前系统用户权限；工作目录不是操作系统沙箱。

## 微信里可以说什么

```text
你好，帮我解释一下这个项目是做什么的。
看看 package.json，帮我运行测试。
从 https://github.com/owner/repo 的 skills/example 目录安装 Skill，叫 example。
用 example Skill 处理工作目录里的这份文件。
```

命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看使用帮助 |
| `/skills` | 列出 Skill |
| `/tasks` | 查看命令任务 |
| `/stop` | 停止处理和命令任务 |
| `/new` | 开始新对话 |
| `/approve 编号` | 允许一次具体操作 |
| `/deny 编号` | 拒绝操作 |

## 微信图片保存

在「连接设置 → 微信图片保存目录」填写本机文件夹的完整路径并保存。默认使用工作目录下的 `微信收件箱`，目录会在首次收图时创建。

手机给已绑定的 Bot 发图片后，程序从微信 CDN 下载，用消息提供的 AES-128-ECB 密钥在本机解密，按日期保存，例如：

```text
微信收件箱/2026-10-29/image-消息摘要-1.png
```

Bot 会回复保存成功的图片数量和每张图片的完整路径。支持一条消息最多 9 张图片，每张上限 25 MB；支持 PNG、JPEG、GIF、WebP、BMP、TIFF、HEIC 和 AVIF，按实际文件格式命名。下载、解密或写入失败会明确回复原因，不会谎报成功。

收图不调用模型 API，无需模型 Key，也不需要开启「允许自动执行命令」。图片附带的文字不会在本次收图中交给模型；需要分析图片内容时，目前需使用其他工具。图片保存不会自动加入模型对话历史。

重复消息不会重复保存；程序重启后会恢复中断的收图任务，已保存的文件不会覆盖。保存目录变更仅影响后续收到的消息。程序暂停、退出或电脑休眠期间无法即时收图；恢复后只能处理微信接口仍会投递的消息。

## Skill

Skill 是一个包含 `SKILL.md` 的目录，可附带 `scripts/`、`references/` 等文件。支持从本机目录或 GitHub 仓库根地址加子目录安装。不会自动运行安装脚本；助手会读说明、检查环境，随后调用本机工具执行。

安装后即时出现在模型可用目录中。默认只发送名称和简介，模型需要时读取全文；不需要训练或重启模型。

依赖普通命令、脚本和文件操作的 Skill 最容易复用。依赖 Codex、Claude、特定 MCP、飞书工具或其他专用平台 API 的 Skill，需要相应工具适配、软件或凭据。第一版不承诺所有 Skill 都兼容。

## 数据与边界

- 数据默认放在 `~/.weixin-lite/`，可用 `WEIXIN_LITE_HOME` 修改；配置、对话、微信凭据和轮询状态均保存在本机。请勿把该目录提交到 Git。
- 本机测试页与微信共用同一段会话，一次处理一个模型任务。
- 文件工具限制在工作目录内；已安装 Skill 的文件通过独立工具读取。shell 有本机用户权限，非沙箱。
- 支持文本、微信已转写的语音，以及接收图片并自动保存。图片发送、模型看图、其他文件收发、屏幕点击和语音识别尚未实现。
- 命令保留最近的输出，单条命令最长运行 120 秒；任务列表只保留当前进程内的任务。
- 微信入站消息先持久化再推进游标；重复 ID 不重复执行。重启中断的模型任务不会自动重跑，以免重复修改；图片任务可安全恢复。
- 微信发送失败的回复会留在本机待发队列，可在设置页重试。无法保证平台永远兼容，也无法保证网络超时后消息严格只送达一次。
- 程序和电脑需保持运行、联网。关闭终端不影响后台服务，`weixin-lite stop` 才会停止；当前不安装开机启动项。
- 对话和所需工具结果会交给你选定的模型服务；微信消息经腾讯通道传输。

## 开发与验证

只有从源码开发才需要 Node.js 22.13+（建议 Node 24）。最终用户直接使用单文件程序即可。从 GitHub 安装 Skill 另需 git；Skill 脚本依赖的软件也需按说明安装。

```bash
git clone https://github.com/Huhui-coder/wx-ai-bot.git
cd wx-ai-bot
npm ci --ignore-scripts
npm start
```

开发版 `npm start` 也会后台运行并打开浏览器，`npm stop` 可停止。macOS 开发者可双击 `启动.command`。

```bash
npm test
npm run check
```

编译单文件需要开发者安装 Bun 1.2.17：

```bash
npm run build:binary
# 指定平台：
npm run build:binary -- bun-darwin-arm64
npm run build:binary -- bun-darwin-x64
npm run build:binary -- bun-windows-x64
```

编译结果位于 `dist/`，网页和依赖全部内置。可用 `WEIXIN_LITE_TEST_BINARY=./dist/对应文件 npm test` 同时测试源码与真实单文件程序。GitHub Actions 会分别在 Apple Silicon、Intel Mac、Windows x64 上原生构建并执行测试；推送 `v*` 标签时，三个平台全部通过后才发布 Releases，并附 SHA256SUMS。

测试覆盖：模型 API 请求格式、DeepSeek 工具调用上下文保留、Skill 安装到脚本执行的完整循环、授权拒绝、任务停止/超时、路径越界、凭据脱敏、微信用户绑定/去重、二维码流程、本机 HTTP 接口，以及后台启动、并发重复启动、停止、重启和内置网页资源。

模型与微信使用可控的模拟服务验证协议与执行逻辑。真实模型请求需要用户填写 API Key，微信端真实收发需要用户扫码后再验收。

## 实现与参考

```text
微信消息 / 本机测试页
        ↓
自选模型 API ↔ 工具执行循环
                    ├─ 文件读写
                    ├─ shell 命令
                    └─ Skill 列表 / 读取 / 安装
微信图片 → CDN 下载 → 本机 AES 解密 → 按日期保存 → 回复路径
```

两个直接运行依赖：`qrcode`（显示二维码）、`yaml`（解析 Skill 说明头）。使用 Node 内置 HTTP、fetch、文件与子进程 API，无前端构建工具或数据库。

参考资料：

- [Hermes skills_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py)：Skill 简介目录与按需读取的思路。
- [nanobot Skill 加载](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/skills.py)和[执行循环](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/loop.py)：能力说明、模型工具调用与结果回传。
- [Tencent/openclaw-weixin 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)和[扫码实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)：独立 HTTP 通信实现的依据；当前对齐 2.4.10 的客户端元数据；图片下载及密钥格式参照其 [media-download.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/media/media-download.ts) 和 [pic-decrypt.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/pic-decrypt.ts)。第三方实现不代表腾讯官方支持。
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)：模型提出工具调用，由本机执行并回传结果。

详细方案筛选见同目录的调研文档。本项目没有引入上述 Agent 框架作为运行依赖。
