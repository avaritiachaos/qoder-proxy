# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- `validateChatRequest` no longer rejects `role: 'tool'` messages or `tool_calls` in message history.
- `anthropicToOpenAiMessages` no longer injects a "text-only" warning when tools are provided; instead it injects the actual tool definitions as a system prompt.
- `normalizeAnthropicText` now uses `<tool_result id="...">` and `<tool_use name="..." id="...">` tags instead of `[tool_result]` / `[tool_use]` bracket format.
- Streaming responses for tool call outputs are downgraded to non-streaming (single JSON response), since tool calls cannot be incrementally streamed.
- This changelog.

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
- SillyTavern compatibility through the OpenAI-compatible Chat Completion custom endpoint.
- Claude Code text-only usage through the Anthropic-compatible endpoint.
- PowerShell shortcuts for Claude Code: `Claude-qwen`, `Claude-glm`, `Claude-kimi`.
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
