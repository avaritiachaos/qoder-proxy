# Qoder CN Proxy

> Local OpenAI-compatible proxy for Qoder CN CLI. For learning and research use only.

[中文说明](README.zh-CN.md)

This project is a clean local proxy intended first for OpenCode. It exposes a small OpenAI-compatible API and calls the official Qoder CN CLI (`qoderclicn`) with `QODERCN_PERSONAL_ACCESS_TOKEN`.

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Qoder, Qoder CN, or OpenCode.

It is provided only for learning and local experimentation. Use it at your own risk and follow the terms of the upstream services and tools you connect to.

## Security Boundaries

- Authentication is only read from `QODERCN_PERSONAL_ACCESS_TOKEN`.
- The proxy listens on `127.0.0.1` only.
- Logs redact Authorization, cookie, token, access_token, and `QODERCN_PERSONAL_ACCESS_TOKEN`.
- The clean implementation does not read Qoder/QoderWork desktop client auth files.
- The clean implementation does not scan `%APPDATA%`, `%LOCALAPPDATA%`, or `%USERPROFILE%\.qoderwork`.
- Tokens must never be committed to source, config, README, tests, issues, or logs.

The old local experiment file `server.js` is intentionally excluded from the public repository by `.gitignore`.

## Requirements

- Node.js 18 or newer
- Qoder CN CLI

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` locally and set:

```text
QODERCN_PERSONAL_ACCESS_TOKEN=your-token-here
```

Do not commit `.env`.

Start the proxy:

```powershell
npm start
```

On Windows, you can also double-click:

```text
start-proxy.cmd
```

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

Current limits:

- OpenAI-compatible chat completions only
- Streaming responses are SSE-compatible, but the proxy waits for one complete Qoder CLI response before emitting content
- Tool calls are not supported
- One Qoder CN CLI subprocess is started per chat request
- Qoder CN CLI output must be structured JSON

## Models

The proxy exposes these model IDs:

- `qoder-cn`
- `auto`
- `qwen3.7-max`
- `glm-5.1`
- `kimi-k2.6`
- `qwen3.6-plus`
- `qwen3.6-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash`

Qwen3.7-Max also has direct effort aliases:

- `qwen3.7-max-effort-low`
- `qwen3.7-max-effort-medium`
- `qwen3.7-max-effort-high`
- `qwen3.7-max-effort-max`

The aliases are mapped back to Qoder CN CLI model `Qwen3.7-Max` plus `--reasoning-effort`.

## Reasoning Options

Global environment variables:

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

Per request, the proxy accepts:

- `reasoning_effort` or `reasoningEffort`
- `context_window` or `contextWindow`
- `max_tokens` or `maxOutputTokens`
- OpenCode/provider option shapes such as `providerOptions`

## OpenCode

This repository includes a project-level `opencode.json`. When OpenCode is started from this project directory, it uses:

```text
http://127.0.0.1:3000/v1
```

Example CLI usage:

```powershell
opencode run --model qoder-cn-local/qwen3.7-max --variant high "只返回 OK"
```

Or use the direct alias:

```powershell
opencode run --model qoder-cn-local/qwen3.7-max-effort-high "只返回 OK"
```

## Curl Checks

```powershell
curl.exe http://127.0.0.1:3000/health
```

```powershell
curl.exe http://127.0.0.1:3000/v1/models
```

```powershell
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"只返回 OK\"}]}"
```

## Test

```powershell
npm test
```

## License

MIT. See [LICENSE](LICENSE).
