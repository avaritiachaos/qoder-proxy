# Qoder CN Proxy

将 Qoder CN CLI (`qoderclicn`) 封装为本地 OpenAI / Anthropic 兼容 API，使 OpenCode、SillyTavern、Claude Code 等工具能够直接对接 Qoder CN 的模型能力。

本项目仅供学习与本地实验使用，与 Qoder 官方无关。

[English](README.en.md)

## 工作原理

`qoderclicn` 是一个命令行工具，只接受文本输入、返回文本输出。而大多数开发工具期望对接的是 OpenAI 或 Anthropic 格式的 HTTP API。本代理充当中间层：接收 API 格式的请求，将其转换为 CLI 调用，再将 CLI 输出转换回 API 格式返回。

支持两种 API 格式：

- **OpenAI 格式**（`/v1/chat/completions`）—— 适用于 OpenCode、SillyTavern 等支持 OpenAI 兼容接口的工具
- **Anthropic 格式**（`/v1/messages`）—— 适用于 Claude Code

两种格式均已支持工具调用（`tool_calls` / `tool_use`），可运行 Agent 模式。

## 工具调用实现方式

由于 `qoderclicn` 本身只处理文本，不具备原生的工具调用通道，代理采用 Prompt 注入 + 输出解析的方式实现：将工具定义注入到 Prompt 中作为格式指令，再从模型的文本输出中提取 JSON 并解析为工具调用。

这与直接调用 OpenAI 或 DeepSeek 等官方 API 有本质区别 —— 官方 API 提供独立的 `tools` 参数通道，模型原生理解工具调用协议。代理只能通过 Prompt 模拟，因此可靠性取决于底层模型是否能稳定输出符合格式的 JSON。

## Prompt 注入策略（反污染）

代理采用三条路径，仅在必要时注入最少内容：

- **客户端自带 system prompt（无工具）**：零注入。模型行为完全由客户端的 system prompt 控制，代理不添加任何内容。
- **简单对话（无 system prompt，无工具）**：仅注入一句元指令 —— "回答对话中最新的用户消息"，不构成角色定义。
- **Agent 模式（有工具参数）**：仅注入 `[Tool Protocol]` 格式指令，包含工具列表和输出格式规范，不含任何角色定义语句。

## 安全边界

- 认证仅使用环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN`，不读取桌面客户端的登录状态
- 仅监听 `127.0.0.1`，不暴露到网络
- 日志自动脱敏 token、cookie、Authorization 头等敏感信息
- 不扫描 `%APPDATA%`、`%LOCALAPPDATA%` 或 `~/.qoderwork`
- `.env`、token、日志均不纳入版本控制

## 安装

需要 Node.js 18+ 和 Qoder CN CLI：

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

安装依赖并创建配置：

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，填入令牌：

```
QODERCN_PERSONAL_ACCESS_TOKEN=your-token-here
```

令牌创建地址：https://qoder.com.cn/account/integrations （创建后仅显示一次，请妥善保存）

请勿将 `.env` 提交到 Git。

启动：

```powershell
npm start
```

Windows 也可以双击 `start-proxy.cmd`。

## 支持的模型

`qoder-cn`、`auto`、`qwen3.7-max`、`glm-5.1`、`kimi-k2.6`、`qwen3.6-plus`、`qwen3.6-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`

Qwen3.7-Max 推理强度别名：`qwen3.7-max-effort-low`、`-medium`、`-high`、`-max`

## 客户端接入指南

### OpenCode

仓库自带 `opencode.json` 配置文件，从项目目录启动 OpenCode 即可：

```powershell
opencode run --model qoder-cn-local/qwen3.7-max --variant high "reply OK"
```

也可直接使用推理强度别名：

```powershell
opencode run --model qoder-cn-local/qwen3.7-max-effort-high "reply OK"
```

### SillyTavern

使用 Chat Completion 的自定义 OpenAI 兼容源：

- API 类型：Chat Completion
- Source：Custom (OpenAI-compatible)
- Base URL：`http://127.0.0.1:3000/v1`
- API Key：任意值（如 `not-used`）
- Model：从下拉列表选择或手动输入模型 ID

注意：Base URL 不要追加 `/chat/completions`；不要将 Qoder CN 令牌填入 SillyTavern —— 令牌只需配置在代理的 `.env` 中。

### Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "not-used"
claude --model qwen3.7-max
```

`ANTHROPIC_BASE_URL` 不要追加 `/v1`，Claude Code 会自动拼接 API 路径。

已支持 `tool_use` 和 `tool_result`，Claude Code 可以在 Agent 模式下执行文件编辑和命令操作（可靠性取决于底层模型的工具调用 JSON 输出能力）。

可选：配置 PowerShell 快捷命令 —— `Claude-qwen`（qwen3.7-max）、`Claude-glm`（glm-5.1）、`Claude-kimi`（kimi-k2.6），大小写不敏感。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI 格式对话（支持 tools） |
| POST | `/v1/messages` | Anthropic 格式对话（支持 tool_use） |
| POST | `/v1/messages/count_tokens` | Token 估算 |

## 推理参数

通过环境变量设置全局默认值：

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

也可在每次请求中通过 `reasoning_effort`、`context_window`、`max_tokens` 参数单独指定。

## 流式输出

当客户端请求 `stream: true` 且不包含工具参数时，代理使用 `qoderclicn --output-format stream-json` 进行实时增量流式输出，文本内容会在生成时即时以 SSE 事件转发给客户端。

当请求包含工具参数时，流式请求会自动降级为非流式响应（工具调用需要完整 JSON 输出才能解析）。

## 当前限制

- 工具调用通过 Prompt 注入 + 文本解析实现，非模型原生能力，可靠性因模型而异
- 工具调用的响应不走流式，始终为完整 JSON 返回
- 每次请求启动一个新的 `qoderclicn` 子进程
- 若模型输出非法 JSON 或拒绝使用工具格式，响应自动降级为纯文本

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

## 许可证

MIT。详见 [LICENSE](LICENSE)。
