# Qoder CN Proxy

把 Qoder CN 的命令行工具包装成 OpenAI / Anthropic 兼容的本地 API，这样其他软件（OpenCode、酒馆、Claude Code、紫苑等）就能直接对接了。

仅供学习和本地实验使用。本项目不是 Qoder 或 OpenCode 的官方项目。

[English](README.md)

## 这东西是干嘛的

简单说：Qoder CN 有个命令行工具 `qoderclicn`，但很多软件只认 OpenAI 或 Anthropic 的 API 格式。这个代理就是一个中间人——软件按 API 格式发请求过来，代理翻译成命令行调用，再把结果翻译回 API 格式返回。

现在支持两种对接方式：

- OpenAI 格式（`/v1/chat/completions`）—— OpenCode、酒馆、紫苑用这个
- Anthropic 格式（/v1/messages）—— Claude Code 用这个

而且两种格式都支持工具调用（tool calls / tool_use），可以跑 Agent 模式了。

## 工具调用是怎么实现的

因为 `qoderclicn` 只接受文本输入、只输出文本，它本身不懂什么是工具调用。所以代理的做法是：把工具定义写进 Prompt 里告诉模型"你有这些工具可以用，需要调用时输出 JSON"，然后从模型的文本回复中提取出 JSON 解析成工具调用格式。

这跟直接调 DeepSeek 或 OpenAI 官方 API 是不一样的——官方 API 有独立的 `tools` 参数通道，模型原生就知道怎么处理工具调用，不需要任何额外 Prompt。反代只能用 Prompt 注入来模拟，可靠性取决于底层模型是否听话地输出 JSON。

## Prompt 会不会污染角色人格

不会。代理用了三条路径，只在必要时注入最少的内容：

- 酒馆 / 紫苑角色扮演（自带 system prompt，不带工具）：零注入。角色人格完全由客户端的 system prompt 控制，代理什么都不加。
- 简单对话（没有 system prompt，没有工具）：只加一句"回答对话中最新的用户消息"，不是角色定义。
- Agent 模式（带了工具参数）：只注入 `[Tool Protocol]` 格式指令，告诉模型工具列表和输出格式，不含任何"你是..."角色定义。

所以酒馆用来跑角色扮演完全不会受影响——酒馆不发 tools 参数，代理就不注入任何东西。

## 安全边界

- 认证只用环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN`，不会读桌面客户端的登录信息
- 只监听 `127.0.0.1`，不会暴露到网络上
- 日志里会脱敏 token、cookie 等敏感信息
- 不会扫描 `%APPDATA%` 或 `~/.qoderwork`
- token 不要写进源码、测试、截图或日志

## 怎么装

需要 Node.js 18 或更高版本，以及 Qoder CN CLI：

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

然后：

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，填上你的令牌：

```
QODERCN_PERSONAL_ACCESS_TOKEN=你的令牌
```

令牌在这里创建：https://qoder.com.cn/account/integrations ，创建后只显示一次，保存好。

不要提交 `.env` 到 Git。

启动：

```powershell
npm start
```

Windows 也可以双击 `start-proxy.cmd`。

## 支哪些模型

`qoder-cn`、`auto`、`qwen3.7-max`、`glm-5.1`、`kimi-k2.6`、`qwen3.6-plus`、`qwen3.6-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`

Qwen3.7-Max 还可以直接选推理强度：`qwen3.7-max-effort-low`、`-medium`、`-high`、`-max`

## 怎么接入各种软件

### OpenCode

仓库里自带 `opencode.json`，从项目目录启动 OpenCode 就行：

```powershell
opencode run --model qoder-cn-local/qwen3.7-max --variant high "只返回 OK"
```

或直接选别名：

```powershell
opencode run --model qoder-cn-local/qwen3.7-max-effort-high "只返回 OK"
```

### 酒馆 (SillyTavern)

用 Chat Completion 的自定义 OpenAI 源：

- API 类型：Chat Completion
- Source：Custom (OpenAI-compatible)
- Base URL：`http://127.0.0.1:3000/v1`
- API Key：随便填，比如 `not-used`
- Model：下拉选或手动填模型 ID

注意：Base URL 不要加 `/chat/completions`，也不要把 Qoder token 填进酒馆——令牌只放在代理的 `.env` 里。

### Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "not-used"
claude --model qwen3.7-max
```

`ANTHROPIC_BASE_URL` 不要加 `/v1`，Claude Code 会自己拼路径。

现在支持 `tool_use` 和 `tool_result` 了——Claude Code 可以真正用 Agent 模式做文件编辑和命令执行（前提是底层模型能稳定输出工具调用 JSON）。

可选的 PowerShell 快捷命令：`Claude-qwen`（对应 qwen3.7-max）、`Claude-glm`（glm-5.1）、`Claude-kimi`（kimi-k2.6）。大小写不敏感。

### 紫苑 (CodeShion)

通过 OpenAI 格式 `/v1/chat/completions` 接入。带 tools 参数时走 Agent 模式（工具调用），不带 tools 时走纯对话模式——纯对话模式下代理零注入，不会污染紫苑的角色人格。

## 接口一览

- `GET /health` —— 健康检查
- `GET /v1/models` —— 模型列表
- `POST /v1/chat/completions` —— OpenAI 格式对话（支持 tools）
- `POST /v1/messages` —— Anthropic 格式对话（支持 tool_use）
- `POST /v1/messages/count_tokens` —— token 估算

## 推理参数

环境变量设全局默认：

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

也可以每次请求单独传 `reasoning_effort`、`context_window`、`max_tokens`。

## 当前限制

- 工具调用靠 Prompt 注入 + 文本解析实现，不是模型原生能力，可靠性取决于模型是否听话输出 JSON
- 工具调用的响应不走流式，永远是完整返回
- 文本流式是"假流式"——等 CLI 完成后一次性发出几个 chunk
- 每次请求启动一个新的 qoderclicn 子进程
- 如果模型输出非法 JSON 或拒绝用工具，自动降级为纯文本回复

## 快速检查

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v1/models
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"只返回 OK\"}]}"
```

## 测试

```powershell
npm test
```

## 许可证

MIT。见 [LICENSE](LICENSE)。