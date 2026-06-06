# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-06-06

### Added

- **Dual CLI backend**: Support both Qoder CN (`qoderclicn`) and Qoder Global (`qodercli`) via `CLI_BACKEND` env var.
- **Web Console**: Dashboard now shows the active CLI backend.

### Changed

- **Project renamed**: "Qoder CN Proxy" → "Qoder Proxy" to reflect dual-backend support.
- npm package renamed from `qoder-cn-proxy` to `qoder-proxy`.

### Fixed

- **Windows npm shim path**: Correctly resolve `qoderclicn` / `qodercli` bundle paths on Windows.

## [1.3.0] - 2026-06-05

### Added

- **Streaming with tools**: Enable streaming responses even when tools are present (e.g. for Claude Code compatibility). Tool call parsing is skipped in streaming mode and returned as plain text deltas, while non-streaming mode still parses tool_calls/tool_use blocks.

### Fixed

- **Avoid Windows command-line limit**: Fixed `ENAMETOOLONG` errors when spawning the CLI on Windows with a large number of tools by moving long system prompts to an attachment file.
- **Unknown model fallback**: Fallback unknown model IDs (like Claude Code's model IDs) to `auto` instead of passing them directly to the CLI and failing.
- Add tool-call detection logging to make troubleshooting easier.

## [1.2.0] - 2026-06-03

### Added

- **Web Console UI**: Added a sleek glassmorphic Web Console UI at `/ui` featuring a dashboard, model list, chat test tab, config overview, and usage analytics.
- **Theme support**: Built-in support for light and dark modes.
- **Local usage tracking**: Added a usage logging module and API endpoints (`/usage/local`, `/usage/reset-local`) with local database storage (`usage.json`).
- Added `start-ui.cmd` launcher script.

## [1.1.0] - 2026-06-01

### Added

- **True streaming**: When `stream: true` and no tools are present, the proxy now uses `qoderclicn --output-format stream-json` for real-time incremental text streaming. Text deltas are forwarded as SSE events immediately as they arrive from the CLI, instead of buffering the entire response.
- OpenAI Tool Calls support: `/v1/chat/completions` now accepts `tools` parameter and `role: 'tool'` messages. When the model outputs a tool call, the response contains `tool_calls` with `finish_reason: 'tool_calls'`. If parsing fails, the response falls back to plain text.
- Anthropic Tool Use support: `/v1/messages` now accepts `tools` with `input_schema` and `tool_result` content blocks. When the model outputs a tool call, the response contains `tool_use` content blocks with `stop_reason: 'tool_use'`. Mixed text + tool_use blocks are supported.
- Shared `tool-parser.js` module: centralized tool prompt injection, output parsing, ID generation, and result formatting. Both OpenAI and Anthropic endpoints reuse this module.
- Anthropic content block handling: `image`, `document`, `thinking`, unknown types produce tagged placeholders instead of being silently dropped.
- Model metadata: `/v1/models` returns `capabilities.reasoning` and `effort_alias` per model.
- Tool call output parser with brace-balanced JSON extraction for cases where the model omits markdown fences.
- OpenAI `arguments` correctly returned as JSON string per spec (not parsed object).
- Anthropic `input` correctly returned as parsed object per spec (not JSON string).
- Tool call IDs use `call_` prefix for OpenAI and `toolu_` prefix for Anthropic.
- Tool results in multi-turn conversations are formatted with `<tool_result id="...">` tags preserving call/use ID linkage.
- Previous assistant `tool_calls` in message history are formatted as `[assistant called tool: ...]` for prompt context continuity.
- `--append-system-prompt` support: system messages from the client are extracted and passed to the CLI via `--append-system-prompt` flag.
- `files` field in `package.json` for safer npm publishing (whitelist approach).

### Changed

- Default timeout increased from 120s to 300s (5 minutes) for tool-heavy requests.
- `validateChatRequest` no longer rejects `role: 'tool'` messages or `tool_calls` in message history.
- `validateAnthropicMessagesRequest` now accepts `system` role in messages array for Anthropic-compatible clients.
- `anthropicToOpenAiMessages` no longer injects a "text-only" warning when tools are provided; instead it injects the actual tool definitions as a system prompt.
- `normalizeAnthropicText` now uses `<tool_result id="...">` and `<tool_use name="..." id="...">` tags instead of `[tool_result]` / `[tool_use]` bracket format.
- Streaming responses for tool call outputs are downgraded to non-streaming (single JSON response), since tool calls cannot be incrementally streaming.
- Tool call requests with `stream: true` use the non-streaming CLI path and downgrade to compatibility-shaped SSE.

## [1.0.0] - 2025-06-01

### Added

- OpenAI-compatible `/v1/chat/completions` endpoint with SSE streaming support.
- Anthropic-compatible `/v1/messages` endpoint (text-only; tool use is not yet supported).
- Anthropic token counting stub at `/v1/messages/count_tokens`.
- Health check endpoint at `GET /health`.
- Model listing endpoint at `GET /v1/models`.
- Model registry with 9 base models: `qoder-cn`, `auto`, `qwen3.7-max`, `glm-5.1`, `kimi-k2.6`, `qwen3.6-plus`, `qwen3.6-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`.
- Effort aliases for Qwen3.7-Max: `qwen3.7-max-effort-low`, `-medium`, `-high`, `-max`.
- Per-request reasoning options (`reasoning_effort`, `context_window`, `max_tokens`) and global environment variable overrides.
- OpenCode integration via project-level `opencode.json`.
- Local client compatibility through the OpenAI-compatible Chat Completion custom endpoint.
- Text-only usage through the Anthropic-compatible endpoint.
- Optional local PowerShell shortcut examples for model selection.
- `start-proxy.cmd` launcher with pre-flight checks for `.env` and `QODERCN_PERSONAL_ACCESS_TOKEN`, endpoint URL display, and token redaction.
- Smoke test suite (`npm run smoke` / `npm run smoke:full`) for quick health and model checks.
- Unit test suite using the Node.js built-in test runner (`node --test`).
- `README.md` and `README.zh-CN.md` with setup, usage, and curl examples.
- `SECURITY.md` documenting security boundaries and responsible disclosure.
- `.env.example` template for local configuration.
- MIT license.

### Security

- Proxy listens on `127.0.0.1` only — not exposed to the network.
- Authentication sourced exclusively from `QODERCN_PERSONAL_ACCESS_TOKEN` environment variable.
- Log output redacts Authorization headers, cookies, tokens, and access tokens.
- Qoder CLI subprocess runs with an isolated `HOME` directory (`.runtime/`) to prevent reading desktop client auth files.
- No scanning of `%APPDATA%`, `%LOCALAPPDATA%`, or `%USERPROFILE%\.qoderwork`.
- Tokens, `.env`, `.runtime/`, and logs are excluded from Git via `.gitignore`.
