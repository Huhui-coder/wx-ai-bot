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

更新已有安装时，重新执行安装命令即可：安装器会先停止旧服务，再替换程序并启动新版；配置和微信绑定会保留。

默认仅监听本机 `127.0.0.1:3210`；`--port 端口` 可指定端口，`--no-open` 可关闭自动打开浏览器。`logs` 查看最近日志，`--help` 查看帮助。数据及登录状态保存在用户目录，不在程序文件旁。

## 使用

1. 在「连接设置」选择 DeepSeek，填写 API Key，保存后测试连接。自定义服务可填写自己的 API 地址和模型名称；须支持 OpenAI 风格的工具调用。
2. 选择工作目录。可以先在本机「对话」页面验证模型与电脑工具。
3. 点击「生成微信二维码」，用手机微信扫码并确认。如微信要求数字验证，在设置页填写。
4. 在微信给 Bot 发消息。只有扫码绑定的用户可以发起任务。

API Key 在本机设置页输入，无需发到开发者聊天里。Key 不会随普通消息传给模型，也不会提供给命令子进程。macOS 配置文件以 `0600` 权限保存，Windows 使用当前用户目录的访问权限；当前尚未接入系统钥匙串。

默认写文件、执行命令、截屏、安装 Skill、创建定时 AI 任务需要确认；普通文字提醒保存后即生效。shell 使用当前系统用户权限；工作目录不是操作系统沙箱。

### 授权方式

| 方式 | 说明 |
| --- | --- |
| 回复一个词 | 有待确认的操作时，在微信回复「同意」「拒绝」即可，不用输入编号；等待时间 15 分钟 |
| 本次对话都允许 | 回复「始终」或点网页按钮，本次对话内不再询问同类操作，`/new` 或重启后失效；安装 Skill 和定时任务只能逐次确认 |
| 命令前缀 | 在设置里填 `npm test` 这样的前缀，匹配的命令不再询问 |
| 全部自动 | 在设置中开启自动执行，用于完全信任当前电脑的情况 |

含 `;` `&` `|` `<` `>` `$` 反引号或括号的命令不会匹配任何前缀，`npm test; rm -rf ~` 仍然需要确认。

## 微信里可以说什么

发给助手的文字消息会先收到“收到指令，正在处理。”，处理完再收到结果。`/stop` 这类命令和“同意”“拒绝”直接回复，只发图片或附件时回复保存结果。

```text
你好，帮我解释一下这个项目是做什么的。
看看 package.json，帮我运行测试。
从 https://github.com/owner/repo 的 skills/example 目录安装 Skill，叫 example。
用 example Skill 处理工作目录里的这份文件。
把工作目录里的周报发给我。
截个屏给我看看。
总结一下我刚才发的 PDF。
每天早上 8 点运行 npm test，把结果发给我。
```

命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看使用帮助 |
| `/skills` | 列出 Skill |
| `/tasks` | 查看命令任务 |
| `/reminders` | 查看未完成的提醒和定时任务（北京时间） |
| `/cancel 编号` | 取消指定提醒或定时任务 |
| `/stop` | 停止处理和命令任务 |
| `/new` | 开始新对话 |
| `/approve`、`/deny`、`/always` | 允许一次、拒绝、本次对话都允许；只有一个待确认时可省略编号，也可直接回复「同意」「拒绝」「始终」 |

## 定时微信提醒

在微信或本机对话页告诉助手：

```text
明天下午 3 点提醒我总结日报。
每个工作日下午 6 点提醒我总结日报。
每周一、周三上午 9 点提醒我开会。
10 分钟后提醒我去开会。
查看我的提醒。
取消编号为……的提醒。
```

**所有时间统一使用 `Asia/Shanghai`（北京时间，UTC+8），与电脑系统时区无关。** 未说明上午/下午或日期而存在歧义时，助手会先澄清。创建成功会回复具体日期、北京时间和完整编号；也可以在网页「提醒」查看状态或取消。

提醒通过当前扫码绑定的微信发送，创建前需先绑定并在微信给 Bot 发过消息。用自然语言创建时由你配置的模型理解并调用本机提醒工具；任务保存后，到点发送不再调用模型。支持一次性提醒（最长提前 366 天），以及重复提醒；最多 100 条未完成任务。支持每天、周一至周五和每周指定星期的重复提醒；“工作日”仅指周一至周五，不自动识别法定节假日或调休。

任务保存在私有数据目录的 `reminders.json`，程序重启后恢复，关机、休眠或暂停连接期间错过的提醒会在恢复后补发，并标注原定时间。电脑需保持运行、联网才能准点发送；关闭网页和终端不影响后台提醒。`/stop` 停止当前聊天任务，不会删除提醒；取消请使用网页按钮、聊天取消或 `/cancel 编号`。

发送失败保留待发状态，按退避间隔重试；微信会话凭据过期时，需要重新发消息或扫码恢复。更换微信账号或 Bot 后，旧任务会阻止发送，避免提醒发给其他人。只有微信接口确认接受后才显示「已发送」；网络超时后使用相同发送 ID 重试，无法保证平台严格只送达一次。

重复提醒以同一个编号持续运行，每次发送后更新下一次时间；取消会停止整组后续提醒。电脑离线多天后只补发一次错过的提醒，再安排下一个未来时间，不会连续补发多天的消息。发送回执按“任务编号＋本次计划时间”区分，重启不会把已确认的一次再次加入队列。

## 定时 AI 任务

提醒到点发送固定文字；定时任务到点由模型无人值守地执行一段指令，把结果发到微信：

```text
每天早上 8 点运行 npm test，把结果发给我。
每 60 分钟检查一次服务状态，有问题再告诉我。
明天晚上 10 点汇总工作目录里的日报文件。
```

支持一次性、每天、周一至周五、每周指定星期和固定间隔（15 到 1440 分钟）。时间、补跑、取消和换绑保护都与提醒相同：错过多个周期时恢复后只补跑一次，换绑后旧任务不会执行，用 `/cancel 编号` 或网页取消。设置为「无事不通知」的任务，正常时不发消息，失败一定会通知。

无人值守时没有人能审批，所以**权限在创建时确定**：创建任务需要你确认一次，确认内容包含任务要自动执行的命令前缀和是否可写文件。运行中遇到范围外的操作会直接拒绝并告诉你，任务不能给自己加权限，也不能再创建任务，不会使用聊天时临时给的「始终允许」。开启「全部自动」时不受此限。定时任务与微信聊天共用一段对话，所以之后可以追问结果。

任务开始执行就视为已送达，中途重启不会重跑，避免重复修改；程序会告诉你哪个任务被中断。

## 把电脑上的文件发到微信

让助手把工作目录或收件目录里的文件发给你，单个文件最大 25 MB。PNG、JPEG、GIF、WebP、BMP 以图片发送，其他格式以文件发送，视频也按文件发送。文件在本机用 AES-128-ECB 加密后上传到微信 CDN，只发给绑定的微信。

说「截个屏给我看」时，助手截取当前屏幕保存到工作目录的「截图」文件夹再发送，截屏需要你确认。macOS 需要在「系统设置 → 隐私与安全性 → 屏幕录制」允许 `weixin-lite`，否则截图可能只有桌面背景；电脑锁屏时无法截取。

## 阅读文件

助手可以读取工作目录和收件目录里的 PDF、Word（docx）、Excel（xlsx）、PowerPoint（pptx）和文本文件，文本支持 UTF-8、GBK、UTF-16；长文档会分段读取，单个文件最大 50 MB。扫描版 PDF 没有文字层，老版 `.doc`、`.xls`、`.ppt` 需要先另存为新格式。

发文件时附带文字，保存后会自动交给模型处理。没有附带文字时只保存，之后说“总结我刚才发的文件”，助手能找到最近收到的 20 个文件。

模型支持图片输入时，在设置中开启「模型支持看图」，助手就能查看 PNG、JPEG、GIF、WebP 图片，每张不超过 5 MB，只在当次处理时发给模型，不写入对话历史。没有开启时不会向模型发送图片。

## 长任务

`run_command` 默认最长 2 分钟，编译、下载这类任务由助手按需延长，上限在设置里调整，默认 30 分钟，最大 12 小时。长任务启动后助手会结束本轮，每 5 分钟把最新输出发到微信，结束时发送结果；微信断开时结果留在待发队列，恢复后送达。`/tasks` 可随时查看运行时长和最新输出。

## 保持在线

在「连接设置」可以开启两项，默认都关闭：

- **登录电脑后自动启动**：macOS 写入当前用户的 LaunchAgent，Windows 写入当前用户的启动项，不需要管理员权限。注意是**登录后**启动，不是开机后；电脑需要设置自动登录才能在无人值守时恢复。macOS 上程序不能放在桌面、文稿、下载文件夹，否则登录时会被系统拦截，所以开发目录运行时会拒绝开启；工作目录在这些文件夹里时，首次访问可能弹窗询问。
- **运行时防止电脑休眠**：服务退出后自动解除。不能阻止合盖休眠，笔记本请接电源并保持开盖。

程序异常退出后会自动重启，地址和已打开的网页不变，连续失败 5 次后停止并记录日志；配置损坏这类启动错误会立刻报告，不会反复重试。

## 微信图片与通用附件保存

在「连接设置 → 微信图片与附件保存目录」填写本机文件夹的完整路径并保存。默认使用工作目录下的 `微信收件箱`，目录会在首次收件时创建。

手机给已绑定的 Bot 发图片或文件附件后，程序从微信 CDN 下载，用消息提供的 AES-128-ECB 密钥在本机解密，按日期保存，例如：

```text
微信收件箱/2026-10-29/image-消息摘要-1.png
微信收件箱/2026-10-29/file-消息摘要-1-报价单.pdf
```

Bot 会回复保存成功的数量和每个文件的完整路径。支持一条消息最多 9 个图片或附件，每个上限 25 MB；支持 PNG、JPEG、GIF、WebP、BMP、TIFF、HEIC 和 AVIF，按实际文件格式命名。文件附件支持 PDF、Word、Excel、ZIP、文本等任意格式，保留原文件名并加上唯一前缀，清理不兼容 Windows/macOS 的文件名字符；同名附件互不覆盖。收到的文件只保存，不自动打开、执行或解压。下载、解密、大小校验或写入失败会明确回复原因。

保存图片和附件不调用模型 API，无需模型 Key，也不需要开启「允许自动执行命令」。只有消息附带文字，或你之后让助手阅读时，才会用到模型。收到的文件内容不会自动加入模型对话历史。

重复消息不会重复保存；程序重启后会恢复中断的收件任务，已保存的文件不会覆盖。保存目录变更仅影响后续收到的消息。程序暂停、退出或电脑休眠期间无法即时收件；恢复后只能处理微信接口仍会投递的消息。

## Skill

Skill 是一个包含 `SKILL.md` 的目录，可附带 `scripts/`、`references/` 等文件。支持从本机目录或 GitHub 仓库根地址加子目录安装。不会自动运行安装脚本；助手会读说明、检查环境，随后调用本机工具执行。

安装后即时出现在模型可用目录中。默认只发送名称和简介，模型需要时读取全文；不需要训练或重启模型。

依赖普通命令、脚本和文件操作的 Skill 最容易复用。依赖 Codex、Claude、特定 MCP、飞书工具或其他专用平台 API 的 Skill，需要相应工具适配、软件或凭据。第一版不承诺所有 Skill 都兼容。

## 数据与边界

- 数据默认放在 `~/.weixin-lite/`，可用 `WEIXIN_LITE_HOME` 修改；配置、对话、微信凭据和轮询状态均保存在本机。请勿把该目录提交到 Git。
- 本机测试页与微信共用同一段会话，一次处理一个模型任务。
- 文件工具限制在工作目录内；已安装 Skill 的文件通过独立工具读取。shell 有本机用户权限，非沙箱。
- 支持文本、微信已转写的语音，以及图片和文件附件的收发。屏幕点击和语音识别尚未实现。
- 命令保留最近的输出，任务列表只保留当前进程内的任务，程序重启后不再跟踪之前的命令。
- 微信入站消息先持久化再推进游标；重复 ID 不重复执行。重启中断的模型任务不会自动重跑，以免重复修改，并会通知你；图片和附件任务可安全恢复。
- 微信发送失败的回复会留在本机待发队列，连接恢复后自动重试。无法保证平台永远兼容，也无法保证网络超时后消息严格只送达一次。
- 模型请求遇到网络错误、限流或服务端错误时自动重试 2 次。
- 数据文件落盘后再替换，并保留上一版；文件损坏时自动恢复到上一版。对话历史有上限，`service.log` 超过 5 MB 时轮转。
- 程序和电脑需保持运行、联网。关闭终端不影响后台服务，`weixin-lite stop` 才会停止。
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

测试覆盖：模型 API 请求格式与重试、DeepSeek 工具调用上下文保留、Skill 安装到脚本执行的完整循环、授权与命令前缀、定时任务权限、任务停止/超时、路径越界、凭据脱敏、微信用户绑定/去重、二维码流程、文件上传加解密、文档提取、数据文件恢复、本机 HTTP 接口，以及后台启动、并发重复启动、崩溃重启、停止和内置网页资源。

模型与微信使用可控的模拟服务验证协议与执行逻辑。真实模型请求需要用户填写 API Key，微信端真实收发需要用户扫码后再验收。

## 实现与参考

```text
微信消息 / 本机测试页
        ↓
自选模型 API ↔ 工具执行循环
                    ├─ 文件读写、文档提取、看图
                    ├─ shell 命令、截屏
                    ├─ 文件发送到微信
                    ├─ Skill 列表 / 读取 / 安装
                    └─ 提醒、定时任务创建 / 查看 / 取消
本机持久化提醒 → 定时器 → 微信待发队列 → 接口确认后记为已发送
定时任务 → 定时器 → 微信任务队列 → 无人值守执行 → 回复结果
微信图片/附件 → CDN 下载 → 本机 AES 解密 → 按日期保存 → 回复路径
本机文件 → AES 加密 → CDN 上传 → 微信媒体消息
守护进程 → 后台服务（异常退出时自动重启）
```

四个直接运行依赖：`qrcode`（显示二维码）、`yaml`（解析 Skill 说明头）、`unpdf`（提取 PDF 文字）、`iconv-lite`（解码 GBK，发布版运行时不内置）。使用 Node 内置 HTTP、fetch、文件与子进程 API，无前端构建工具或数据库。

参考资料：

- [Hermes skills_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py)：Skill 简介目录与按需读取的思路。
- [nanobot Skill 加载](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/skills.py)和[执行循环](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/loop.py)：能力说明、模型工具调用与结果回传。
- [Tencent/openclaw-weixin 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)和[扫码实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)：独立 HTTP 通信实现的依据；当前对齐 2.4.10 的客户端元数据；图片下载及密钥格式参照其 [media-download.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/media/media-download.ts) 和 [pic-decrypt.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/pic-decrypt.ts)，文件发送参照其 [upload.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/upload.ts) 和 [send.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts)。第三方实现不代表腾讯官方支持。
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)：模型提出工具调用，由本机执行并回传结果。

详细方案筛选见同目录的调研文档。本项目没有引入上述 Agent 框架作为运行依赖。

## 开源协议

本项目采用 [MIT License](LICENSE)，允许使用、修改和商业使用，分发时须保留版权声明和许可文本。第三方依赖遵循各自的许可证。
