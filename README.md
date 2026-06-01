# Qoder CN Proxy

Wraps the Qoder CN CLI into a local OpenAI / Anthropic-compatible API so that other tools (OpenCode, SillyTavern, Claude Code, CodeShion, etc.) can talk to it directly.

For learning and local experimentation only. Not affiliated with Qoder or OpenCode.

[中文说明](README.zh-CN.md)

## What it does

The Qoder CN CLI (`qoderclicn`) only accepts text input and returns text output. But most tools expect an API endpoint with OpenAI or Anthropic format. This proxy sits in the middle: tools send API-format requests, the proxy translates them into CLI calls, then translates the CLI output back into API format.

Two formats are supported:

- OpenAI format (`/v1/chat/completions`) — for OpenCode, SillyTavern, CodeShion
- Anthropic format (`/v1/messages`) — for Claude Code

Both now support tool calls (tool_calls / tool_use), so Agent mode works.

## How tool calls work

Since `qoderclicn` only understands text, the proxy injects tool definitions into the prompt as format instructions, then parses the model's text output to extract JSON tool calls. This is fundamentally different from calling the official DeepSeek or OpenAI API — those have a dedicated `tools` parameter channel, and models natively understand tool calls without any extra prompt. The proxy can only simulate tool calls through prompt injection, so reliability depends on whether the underlying model consistently outputs parseable JSON.

## Will the injected prompt pollute character personas

No. The proxy uses three paths, injecting only what's necessary:

- SillyTavern / character roleplay (has system prompt, no tools): zero injection. The character persona is entirely controlled by the client's system prompt. The proxy adds nothing.
- Simple chat (no system prompt, no tools): a single sentence — "Answer the latest user message" — not a role definition.
- Agent mode (tools present): only `[Tool Protocol]` format instructions — tool list and output format, no "you are a..." role statements.

SillyTavern will never see any injected prompt because it doesn't send tools parameters.

## Security

- Auth comes only from `QODERCN_PERSONAL_ACCESS_TOKEN` env var, never reads desktop client login state
- Only listens on `127.0.0.1`, never exposed to the network
- Logs redact tokens, cookies, Authorization headers
- Does not scan `%APPDATA%` or `~/.qoderwork`
- Never commit `.env`, tokens, or logs

## Setup

Requires Node.js 18+ and Qoder CN CLI:

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set your token:

```
QODERCN_PERSONAL_ACCESS_TOKEN=your-token-here
```

Get a token at: https://qoder.com.cn/account/integrations (shown once after creation, save it locally)

Do not commit `.env`.

Start:

```powershell
npm start
```

Or on Windows, double-click `start-proxy.cmd`.

## Models

`qoder-cn`, `auto`, `qwen3.7-max`, `glm-5.1`, `kimi-k2.6`, `qwen3.6-plus`, `qwen3.6-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`

Qwen3.7-Max effort aliases: `qwen3.7-max-effort-low`, `-medium`, `-high`, `-max`

## Connecting tools

### OpenCode

The repo includes an `opencode.json`. Start OpenCode from this project directory:

```powershell
opencode run --model qoder-cn-local/qwen3.7-max --variant high "reply OK"
```

Or use the effort alias directly:

```powershell
opencode run --model qoder-cn-local/qwen3.7-max-effort-high "reply OK"
```

### SillyTavern

Use Chat Completion with a custom OpenAI-compatible source:

- API type: Chat Completion
- Source: Custom (OpenAI-compatible)
- Base URL: `http://127.0.0.1:3000/v1`
- API Key: `not-used`
- Model: select from dropdown or type manually

Don't add `/chat/completions` to the Base URL. Don't put your Qoder CN token in SillyTavern — keep it only in the proxy's `.env`.

### Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "not-used"
claude --model qwen3.7-max
```

Don't add `/v1` to `ANTHROPIC_BASE_URL` — Claude Code adds the API path itself.

Now supports `tool_use` and `tool_result`, so Claude Code can do real Agent-mode file editing and command execution (assuming the underlying model reliably outputs tool call JSON).

Optional PowerShell shortcuts: `Claude-qwen` (qwen3.7-max), `Claude-glm` (glm-5.1), `Claude-kimi` (kimi-k2.6). Case-insensitive.

### CodeShion (紫苑)

Connect via OpenAI format `/v1/chat/completions`. When tools are provided, it runs in Agent mode with tool calls. Without tools, it runs in plain chat mode with zero prompt injection — character personas stay clean.

## Endpoints

- `GET /health` — health check
- `GET /v1/models` — model list
- `POST /v1/chat/completions` — OpenAI format (with tools support)
- `POST /v1/messages` — Anthropic format (with tool_use support)
- `POST /v1/messages/count_tokens` — token estimate

## Reasoning options

Global defaults via environment:

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

Or per-request: `reasoning_effort`, `context_window`, `max_tokens`.

## Current limits

- Tool calls are implemented through prompt injection + text parsing, not native model capability. Reliability varies by model.
- Tool call responses are always non-streaming (complete JSON response).
- Text streaming is "fake streaming" — the proxy waits for CLI to finish, then emits a few SSE chunks.
- Each request spawns a new qoderclicn subprocess.
- If the model outputs invalid JSON or ignores tool format, the response falls back to plain text.

## Quick checks

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v1/models
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

## Tests

```powershell
npm test
```

## License

MIT. See [LICENSE](LICENSE).