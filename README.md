# Qoder Proxy

## 免责声明

本项目仅用于个人账号的本地兼容性实验与协议适配研究。
使用者必须自行持有合法的 Qoder 账号和 Personal Access Token。
本项目不提供、共享、转售、出租任何 Qoder 账号、Token 或额度。
不得将本项目部署为公网服务、公益站、商业 API、中转站或多人共享服务。
不得用于规避 Qoder 官方的计费、风控、速率限制、地域限制或使用限制。
请遵守 Qoder 官方服务条款；如官方不允许，请立即停止使用。
本项目与 Qoder 官方无关。

[English](README.en.md)

## 项目定位

本项目把 Qoder CLI（`qoderclicn` 或 `qodercli`）适配为仅供本机访问的 OpenAI / Anthropic 兼容 HTTP 接口，用于研究不同客户端协议、消息格式、流式响应和工具调用格式之间的差异。

支持两个后端：

- **CN 后端**：`qoderclicn`，对接 qoder.com.cn
- **Global 后端**：`qodercli`，对接 qoder.com

它不是官方 API，不代表 Qoder 官方授权，也不提供任何账号、Token 或额度服务。所有请求都依赖使用者自行配置的个人 Qoder 认证。

## 工作原理

`qoderclicn` 和 `qodercli` 都是命令行工具，接受文本输入并返回文本输出。许多本地客户端或开发工具使用 OpenAI 或 Anthropic 格式的 HTTP API。本项目作为本地适配层：接收兼容格式请求，将其转换为 CLI 调用，再把 CLI 输出整理为兼容格式响应。

支持两种本地协议格式：

- **OpenAI 兼容格式**：`/v1/chat/completions`
- **Anthropic 兼容格式**：`/v1/messages`

两种格式均支持工具调用字段适配（`tool_calls` / `tool_use`），用于协议兼容性研究。可靠性取决于底层模型是否能稳定输出符合格式的 JSON。

## 工具调用实现方式

由于 CLI 本身只处理文本，不具备原生工具调用通道，本项目采用 Prompt 格式指令 + 输出解析的方式实现工具调用适配：将工具定义作为格式说明加入请求上下文，再从模型文本输出中提取 JSON。

这与直接调用 OpenAI、Anthropic、DeepSeek 等官方 API 不同。官方 API 通常提供原生 `tools` 参数通道；本项目只能做文本层面的协议模拟，因此不应把它视为等价替代。

## 安全边界

- 仅监听 `127.0.0.1`，且不提供改绑其他地址的选项
- **浏览器跨源请求一律拒绝**（仅允许本机 loopback 来源）。否则你访问的任意网页都能在后台调用代理、消耗你的 Qoder 额度
- **`Host` 头不是 loopback 的请求一律拒绝**，用于阻断 DNS rebinding
- 设置 `PROXY_API_KEY` 后，`/v1/*` 与 `/usage/*` 强制校验密钥
- 不建议也不支持作为公网服务、共享服务或商业 API 使用
- 日志自动脱敏 token、cookie、Authorization 头等敏感信息
- `.env`、token、日志均不纳入版本控制

需要提醒的是：**不设置 `PROXY_API_KEY` 时，本机上任何进程都可以使用这个代理。** loopback 绑定挡的是外部网络，挡不住本机。建议设置一个。

### 客户端认证（PROXY_API_KEY）

在 `.env` 中设置后，客户端需要在请求头中携带：

```text
Authorization: Bearer <PROXY_API_KEY>
```

或者（Anthropic 系客户端习惯）：

```text
x-api-key: <PROXY_API_KEY>
```

留空则不校验密钥。`/health` 始终开放，便于脚本探活。

如果你有本机 Web 应用需要从浏览器调用代理，用 `ALLOWED_ORIGINS` 显式放行；如果你确实要用别的主机名访问，用 `ALLOWED_HOSTS`。这两个开关默认为空——一旦使用，安全模型就需要你自己评估了。

### 上游认证方式

| 后端 | 认证方式 | 环境变量 |
|------|--------|--------|
| CN (`qoderclicn`) | Personal Access Token | `QODERCN_PERSONAL_ACCESS_TOKEN` |
| Global (`qodercli`) | OAuth 登录（`qodercli login`） | 无需配置 |

### 服务端工具执行（默认关闭）

`SERVER_TOOL_EXECUTION=1` 会让代理在**你的机器上**执行模型返回的工具调用，而模型是被客户端发来的 prompt 引导的。除非你的客户端确实无法自己执行工具，否则请保持关闭。开启时：

- 文件操作被限制在 `SERVER_TOOL_WORKSPACE`（默认为代理的工作目录），绝对路径和指向外部的符号链接都会被拒绝
- `Bash` 工具额外需要 `SERVER_TOOL_ALLOW_BASH=1` **且** `SERVER_TOOL_BASH_ALLOWLIST` 非空；命令不经过 shell 执行，因此管道、串联、重定向、命令替换都会被拒绝
- Windows 上因为不走 shell，无法执行 `.cmd`/`.bat` 包装（如 `npm`），只能执行真正的可执行文件（`node`、`git`、`python` 等）

请把这个特性当作实验性功能，并且和 `PROXY_API_KEY` 一起使用。

## 报告安全问题

请不要在公开 issue 里报告漏洞，使用 GitHub 的私密报告入口：[Report a vulnerability](https://github.com/avaritiachaos/qoder-proxy/security/advisories/new)。详见 [SECURITY.md](SECURITY.md)。

## 禁止用途 / Abuse Policy

- 禁止公网部署
- 禁止多人共享
- 禁止转售 API
- 禁止绕过官方计费、风控、速率、地域或使用限制
- 禁止收集、保存或转发他人的 Token
- 禁止提供、共享、出租、转售任何账号、Token 或额度

## 安全建议

- 只在本机使用
- 只监听 `127.0.0.1`
- 不要绑定 `0.0.0.0`，不要暴露到公网
- 不要把 Token 发给别人
- 不要把 `.env` 提交到 Git
- 如果怀疑 Token 泄露，立即到 Qoder 官方账号页面吊销 PAT 并重新创建

## 安装

需要 Node.js 18+。

**CN 后端**（必须）：

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

**Global 后端**（可选）：

```bash
npm install -g @qoder-ai/qodercli
qodercli --version
qodercli login   # 必须登录一次
```

安装依赖并创建配置：

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，配置后端和认证：

```env
# 选择后端: "cn" 或 "global"
CLI_BACKEND=cn

# CN 后端：填入你的 Personal Access Token
QODERCN_PERSONAL_ACCESS_TOKEN=your-cn-token

# Global 后端：运行 qodercli login 后无需配置令牌
```

CN 版 PAT 创建入口：https://qoder.com.cn/account/integrations

创建后请妥善保存。不要将 `.env` 提交到 Git，也不要把 Token 填入第三方客户端或分享给他人。

启动：

```powershell
npm start
```

Windows 也可以双击 `start-proxy.cmd`。

启动后默认地址为：

```text
http://127.0.0.1:3000
```

如果你通过环境变量或代码改动手动设置 host，请保持 `127.0.0.1`。不要绑定 `0.0.0.0`，不要通过端口映射、反向代理、隧道或云服务器暴露给公网。

## 双后端切换

通过 `.env` 中的 `CLI_BACKEND` 切换后端：

```env
CLI_BACKEND=cn       # 使用 qoderclicn
CLI_BACKEND=global   # 使用 qodercli
```

| 配置项 | CN 后端 | Global 后端 |
|---------|--------|----------|
| CLI 命令 | `qoderclicn` | `qodercli` |
| 认证方式 | Personal Access Token | `qodercli login`（OAuth） |
| 认证目录 | `~/.qoderworkcn` | `~/.qoder` |
| 环境变量 | `QODERCN_PERSONAL_ACCESS_TOKEN` | 不需要（登录后自动认证） |

切换后端后需重启代理服务生效。

## 支持的模型

`qoder-cn`、`auto`、`ultimate`、`performance`、`efficient`、`lite`、`cantus`、`qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-max`、`qwen3.7-plus`、`kimi-k3`、`kimi-k2.7-code`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`minimax-m3`

推理强度别名：`qwen3.8-max-effort-low`、`-medium`、`-high`、`-max`，以及 `qwen3.7-max-effort-low`、`-medium`、`-high`、`-max`

## 本地客户端适配

### OpenAI 兼容接口

适用于支持自定义 OpenAI 兼容接口的本地客户端：

- Base URL：`http://127.0.0.1:3000/v1`
- API Key：填写你在 `.env` 中设置的 `PROXY_API_KEY`；如果没设置，填任意占位值即可（例如 `not-used`）
- Model：从 `/v1/models` 返回列表选择，或手动输入模型 ID

注意：不要将 Qoder CN Token 填入客户端。Token 只应保存在本项目本机 `.env` 中。

### Anthropic 兼容接口

适用于支持自定义 Anthropic 兼容接口的本地客户端：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "your-PROXY_API_KEY"   # 未设置 PROXY_API_KEY 时填任意值
```

`ANTHROPIC_BASE_URL` 不要追加 `/v1`，客户端通常会自动拼接 API 路径。

### OpenCode 示例

仓库自带 `opencode.json` 配置文件，可用于本地兼容性验证：

```powershell
opencode run --model qoder-cn-local/qwen3.8-max --variant high "reply OK"
```

如果你设置了 `PROXY_API_KEY`，需要把 `opencode.json` 里 `options.apiKey` 的 `not-used` 换成你的密钥。

## API 端点

设置了 `PROXY_API_KEY` 的话，`/v1/*` 与 `/usage/*` 都需要携带密钥；`/health` 不需要。

| 方法 | 路径 | 需要密钥 | 说明 |
|------|------|------|------|
| GET | `/health` | 否 | 健康检查 |
| GET | `/v1/models` | 是 | 模型列表 |
| POST | `/v1/chat/completions` | 是 | OpenAI 兼容格式对话，支持 tools 字段适配 |
| POST | `/v1/messages` | 是 | Anthropic 兼容格式对话，支持 tool_use 字段适配 |
| POST | `/v1/messages/count_tokens` | 是 | Token 估算 |
| GET | `/usage/local` | 是 | 本地用量估算 |
| POST | `/usage/reset-local` | 是 | 重置本地用量统计 |

## 推理参数

通过环境变量设置全局默认值：

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

也可在每次请求中通过 `reasoning_effort`、`context_window`、`max_tokens` 参数单独指定。

其他环境变量：

- `QODERCN_TIMEOUT_MS`：单次请求超时（毫秒）。代理提示词 + 模型排队可能耗时数分钟，建议保持较大值（默认 300000，`.env.example` 示例为 600000）
- `QODERCN_CLI_TOOLS`：默认禁用 CLI 内置工具（追加 `--tools=`），让模型直接回答而不是在代理目录里跑文件/shell 代理循环。设为 `1` 可恢复 CLI 内置工具

## 流式输出

当客户端请求 `stream: true` 时，本项目使用 CLI 的 `--output-format stream-json` 进行增量流式输出，并以 SSE 事件实时转发给本地客户端。

包含工具参数的请求同样实时流式：回复的文本部分经过"安全门控"立即转发——门控暂扣仍可能长成工具调用 JSON 块的尾部（未闭合或已闭合的 ` ```json ` 围栏、未配平或含 `"tool_calls"` 的 JSON 对象、末尾的反引号前缀）；流结束后暂扣部分被解析，工具调用以结构化 `tool_calls` / `tool_use` 块一次性补齐。因此 Claude Code 等代理客户端可以实时看到执行进度，同时结构化工具调用行为不变。

例外：开启 `SERVER_TOOL_EXECUTION=1`（服务端执行工具）时，带工具的流式请求仍走缓冲路径。

## 当前限制

- 工具调用通过 Prompt 格式指令 + 文本解析实现，非模型原生能力
- 流式模式下，工具调用的 JSON 部分在流末尾一次性补齐（不完整的 JSON 无法提前解析）
- 每次请求启动一个新的 CLI 子进程
- 如果模型输出非法 JSON 或拒绝使用工具格式，响应会降级为纯文本
- 流式模式下，普通回复里未闭合的代码围栏会暂扣到围栏闭合后再显示（保守门控：宁可延迟显示，绝不把工具 JSON 泄漏为文本）

## 快速验证

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v1/models
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

## 测试

```powershell
npm test
```

## 本地 Web 控制台

启动后访问本地 Web 控制台：

```
http://127.0.0.1:3000/ui
```

快捷启动（自动打开浏览器）：

```powershell
.\start-ui.cmd
```

### 功能

| Tab | 说明 |
|-----|------|
| Dashboard | 显示 /health 状态、Base URL、模型数量、安全状态 |
| Models | 调用 /v1/models 显示模型列表 |
| Chat Test | 用 /v1/chat/completions 做简单非流式测试 |
| Config | 生成 OpenAI Compatible / Anthropic Compatible / OpenCode 配置示例 |
| Usage / Credits | 本地用量统计 |

### 本地用量统计说明

- Usage 页面显示的是**本地估算数据**，不代表 Qoder 官方账单或剩余额度
- token 数量基于简单字符数估算，标记为 `estimated`，不宣称准确
- 统计数据保存在内存中，持久化到本地 `usage.json`（不保存 prompt 正文、响应正文、token、Authorization、cookie）
- 官方额度：`qoderclicn --help` 中没有 quota/credits/usage 命令，因此**不实现官方额度自动读取**
- UI 不会读取、保存、显示 Qoder PAT

### Usage API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/usage/local` | 返回本地用量统计 |
| POST | `/usage/reset-local` | 重置本地用量统计 |

## 许可证

MIT。详见 [LICENSE](LICENSE)。
