# Qoder CN Proxy

## Disclaimer

This project is only for personal-account local compatibility experiments and protocol adapter research.
Users must hold their own lawful Qoder account and Personal Access Token.
This project does not provide, share, resell, rent, or transfer any Qoder account, Token, or quota.
Do not deploy this project as a public service, community endpoint, commercial API, relay service, or multi-user shared service.
Do not use this project to bypass Qoder's official billing, risk controls, rate limits, regional restrictions, or usage restrictions.
Please comply with Qoder's official terms of service. If official rules do not allow your use case, stop using this project immediately.
This project is not affiliated with Qoder.

[中文说明](README.md)

## Project Scope

This project adapts the Qoder CN CLI (`qoderclicn`) into a local-only OpenAI / Anthropic-compatible HTTP interface for studying protocol differences across local clients, message formats, streaming responses, and tool call schemas.

It is not an official API, does not imply official authorization, and does not provide account, Token, or quota services. All model calls depend on the user's own Qoder CN Personal Access Token.

## How It Works

`qoderclicn` is a command-line tool that accepts text input and returns text output. Many local clients and developer tools expect an OpenAI or Anthropic-format HTTP API. This project acts as a local adapter: it receives compatible API requests, translates them into CLI invocations, and converts CLI output back into compatible responses.

Supported local protocol formats:

- **OpenAI-compatible format**: `/v1/chat/completions`
- **Anthropic-compatible format**: `/v1/messages`

Both formats include tool-call field adaptation (`tool_calls` / `tool_use`) for compatibility research. Reliability depends on whether the underlying model consistently emits valid JSON.

## Tool Call Implementation

Because `qoderclicn` only handles text and has no native tool-calling channel, this project implements tool-call adaptation through prompt format instructions and output parsing: tool definitions are added as formatting guidance, then JSON tool calls are extracted from model text output.

This is different from calling official OpenAI, Anthropic, DeepSeek, or similar APIs. Official APIs usually provide a native `tools` parameter channel. This project only simulates protocol behavior at the text layer and should not be treated as an equivalent replacement.

## Security Boundaries

- Authentication uses only the `QODERCN_PERSONAL_ACCESS_TOKEN` environment variable and does not read desktop client login state
- Default host is `127.0.0.1`
- Not intended or supported for public services, shared services, or commercial APIs
- Logs redact tokens, cookies, Authorization headers, and other sensitive data
- Does not scan `%APPDATA%`, `%LOCALAPPDATA%`, or `~/.qoderwork`
- `.env`, tokens, and logs are excluded from version control

## Abuse Policy

- No public deployment
- No multi-user sharing
- No API resale
- No bypassing official billing, risk controls, rate limits, regional restrictions, or usage restrictions
- No collecting, storing, or forwarding other people's Tokens
- No providing, sharing, renting, reselling, or transferring accounts, Tokens, or quota

## Safety Recommendations

- Use only on your own machine
- Bind only to `127.0.0.1`
- Do not bind to `0.0.0.0` and do not expose the service to the public internet
- Do not send your Token to anyone
- Do not commit `.env` to Git
- If you suspect a Token leak, revoke the PAT immediately from the official Qoder account page and create a new one

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

Edit `.env` and set the Personal Access Token created by your own account:

```env
QODERCN_PERSONAL_ACCESS_TOKEN=your-token-here
```

PAT page: https://qoder.com.cn/account/integrations

Optional official referral entry: https://qoder.com.cn/referral?referral_code=pex0n1GlDjFK4aT1BWpiCoSyEjDGD6GB

Store it securely. Do not commit `.env` to Git, and do not enter your Qoder CN Token into third-party clients or share it with others.

Start:

```powershell
npm start
```

On Windows, you can also double-click `start-proxy.cmd`.

Default local address:

```text
http://127.0.0.1:3000
```

If you manually change host behavior through environment variables or code edits, keep it bound to `127.0.0.1`. Do not bind to `0.0.0.0`, and do not expose it through port forwarding, reverse proxies, tunnels, or cloud servers.

## Supported Models

`qoder-cn`, `auto`, `qwen3.7-max`, `glm-5.1`, `kimi-k2.6`, `qwen3.6-plus`, `qwen3.6-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`

Qwen3.7-Max reasoning effort aliases: `qwen3.7-max-effort-low`, `-medium`, `-high`, `-max`

## Local Client Adaptation

### OpenAI-Compatible Interface

For local clients that support custom OpenAI-compatible endpoints:

- Base URL: `http://127.0.0.1:3000/v1`
- API Key: use a local placeholder value, for example `not-used`
- Model: select from `/v1/models` or enter a model ID manually

Do not enter your Qoder CN Token into the client. Keep the Token only in this project's local `.env`.

### Anthropic-Compatible Interface

For local clients that support custom Anthropic-compatible endpoints:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "not-used"
```

Do not append `/v1` to `ANTHROPIC_BASE_URL`; clients usually add API paths automatically.

### OpenCode Example

The repository includes `opencode.json` for local compatibility verification:

```powershell
opencode run --model qoder-cn-local/qwen3.7-max --variant high "reply OK"
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/v1/models` | Model list |
| POST | `/v1/chat/completions` | OpenAI-compatible chat with tools field adaptation |
| POST | `/v1/messages` | Anthropic-compatible chat with tool_use field adaptation |
| POST | `/v1/messages/count_tokens` | Token estimation |

## Reasoning Options

Set global defaults via environment variables:

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

Or specify per request via `reasoning_effort`, `context_window`, and `max_tokens`.

## Streaming

When a client requests `stream: true` without tools, this project uses `qoderclicn --output-format stream-json` for incremental streaming and forwards text as local SSE events.

When a request includes tool parameters, streaming is downgraded to a non-streaming response because tool-call parsing requires complete JSON output.

## Current Limitations

- Tool calls are implemented through prompt format instructions and text parsing, not native model capability
- Tool-call responses are always non-streaming complete JSON responses
- Each request spawns a new `qoderclicn` subprocess
- If the model emits invalid JSON or refuses the tool format, the response falls back to plain text

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

This project may be discussed on the [LINUX DO](https://linux.do) community. Please follow this README's disclaimer, safety recommendations, and abuse policy when discussing or sharing it.
