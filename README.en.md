# Qoder CN Proxy

Wraps the Qoder CN CLI (`qoderclicn`) into a local OpenAI / Anthropic-compatible API, enabling tools like OpenCode, SillyTavern, and Claude Code to interface with Qoder CN models directly.

For learning and local experimentation only. Not affiliated with Qoder.

[中文说明](README.md)

## How It Works

`qoderclicn` is a command-line tool that accepts text input and returns text output. Most development tools, however, expect an OpenAI or Anthropic-format HTTP API. This proxy acts as an intermediary layer: it receives API-format requests, translates them into CLI invocations, and converts the CLI output back into API format.

Two API formats are supported:

- **OpenAI format** (`/v1/chat/completions`) — for OpenCode, SillyTavern, and other OpenAI-compatible tools
- **Anthropic format** (`/v1/messages`) — for Claude Code

Both formats support tool calls (`tool_calls` / `tool_use`) for Agent mode.

## Tool Call Implementation

Since `qoderclicn` only handles text and has no native tool calling channel, the proxy implements tool calls through prompt injection and output parsing: tool definitions are injected into the prompt as format instructions, and the model's text output is parsed to extract JSON tool calls.

This differs fundamentally from calling official OpenAI or DeepSeek APIs, which provide a dedicated `tools` parameter channel where models natively understand the tool calling protocol. The proxy can only simulate tool calls through prompts, so reliability depends on whether the underlying model consistently produces well-formatted JSON.

## Prompt Injection Policy (Anti-Pollution)

The proxy uses three paths, injecting only what is necessary:

- **Client provides a system prompt (no tools)**: Zero injection. The model's behavior is entirely controlled by the client's system prompt. The proxy adds nothing.
- **Simple chat (no system prompt, no tools)**: A single meta-instruction — "Answer the latest user message" — not a role definition.
- **Agent mode (tools present)**: Only `[Tool Protocol]` format instructions — tool list and output format specification, with no role-defining statements.

## Security

- Authentication uses only the `QODERCN_PERSONAL_ACCESS_TOKEN` environment variable; never reads desktop client login state
- Listens on `127.0.0.1` only; never exposed to the network
- Logs automatically redact tokens, cookies, Authorization headers, and other sensitive data
- Does not scan `%APPDATA%`, `%LOCALAPPDATA%`, or `~/.qoderwork`
- `.env`, tokens, and logs are excluded from version control

## Setup

Requires Node.js 18+ and Qoder CN CLI:

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

Install dependencies and create configuration:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set your token:

```
QODERCN_PERSONAL_ACCESS_TOKEN=your-token-here
```

Create a token at: https://qoder.com.cn/account/integrations (displayed only once after creation — save it securely)

Don't have a Qoder CN account yet? [Sign up via this link](https://qoder.com.cn/referral?referral_code=pex0n1GlDjFK4aT1BWpiCoSyEjDGD6GB) to get bonus credits.

Do not commit `.env` to Git.

Start the proxy:

```powershell
npm start
```

On Windows, you can also double-click `start-proxy.cmd`.

## Supported Models

`qoder-cn`, `auto`, `qwen3.7-max`, `glm-5.1`, `kimi-k2.6`, `qwen3.6-plus`, `qwen3.6-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`

Qwen3.7-Max reasoning effort aliases: `qwen3.7-max-effort-low`, `-medium`, `-high`, `-max`

## Client Integration Guide

### OpenCode

The repository includes an `opencode.json` configuration file. Start OpenCode from the project directory:

```powershell
opencode run --model qoder-cn-local/qwen3.7-max --variant high "reply OK"
```

Or use an effort alias directly:

```powershell
opencode run --model qoder-cn-local/qwen3.7-max-effort-high "reply OK"
```

### SillyTavern

Use Chat Completion with a custom OpenAI-compatible source:

- API type: Chat Completion
- Source: Custom (OpenAI-compatible)
- Base URL: `http://127.0.0.1:3000/v1`
- API Key: any value (e.g. `not-used`)
- Model: select from dropdown or enter a model ID manually

Do not append `/chat/completions` to the Base URL. Do not enter your Qoder CN token in SillyTavern — keep it only in the proxy's `.env`.

### Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "not-used"
claude --model qwen3.7-max
```

Do not append `/v1` to `ANTHROPIC_BASE_URL` — Claude Code adds the API path automatically.

Supports `tool_use` and `tool_result`, enabling Claude Code to operate in Agent mode for file editing and command execution (reliability depends on the underlying model's tool call JSON output capability).

Optional: configure PowerShell shortcuts — `Claude-qwen` (qwen3.7-max), `Claude-glm` (glm-5.1), `Claude-kimi` (kimi-k2.6). Case-insensitive.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/v1/models` | Model list |
| POST | `/v1/chat/completions` | OpenAI-format chat (supports tools) |
| POST | `/v1/messages` | Anthropic-format chat (supports tool_use) |
| POST | `/v1/messages/count_tokens` | Token estimation |

## Reasoning Options

Set global defaults via environment variables:

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

Or specify per-request via `reasoning_effort`, `context_window`, `max_tokens` parameters.

## Streaming

When a client requests `stream: true` without tools, the proxy uses `qoderclicn --output-format stream-json` for real-time incremental streaming. Text content is forwarded as SSE events to the client as it is generated.

When a request includes tool parameters, streaming is automatically downgraded to a non-streaming response (tool calls require complete JSON output for parsing).

## Current Limitations

- Tool calls are implemented via prompt injection and text parsing, not native model capability; reliability varies by model
- Tool call responses are always non-streaming (complete JSON response)
- Each request spawns a new `qoderclicn` subprocess
- If the model produces invalid JSON or refuses the tool format, the response falls back to plain text

## Quick Verification

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v1/models
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

## Testing

```powershell
npm test
```

## License

MIT. See [LICENSE](LICENSE).

## Community

This project is promoted and discussed on the [LINUX DO](https://linux.do) community. Feel free to join the conversation.
