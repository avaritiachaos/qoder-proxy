# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-09-05

### Changed

- **CLI built-in tools are now disabled by default** (`--tools=` is appended to the CLI invocation). The upstream CLI is a full agent: with its tools enabled, a plain chat request could turn into minutes of multi-turn file/shell loops inside the proxy's own working directory — easily outliving `QODERCN_TIMEOUT_MS` and surfacing in agent clients (e.g. Claude Code) as empty responses ("No response requested.") or `upstream_timeout` errors. Measured latency for the same model/prompt dropped from ~220s to ~3s. Set `QODERCN_CLI_TOOLS=1` to keep the CLI's built-in tools.

### Fixed

- **Requests could hang forever when the CLI exited but its stdio pipes stayed open** (e.g. a descendant process inheriting stdout): `close` never fires, so the request promise never settled and even the timeout kill could not end it. Both CLI runners now settle from the `exit` event after a short flush grace period, and force-settle shortly after a timeout kill.
- **Duplicated text in longer streaming replies**: the CLI's `stream-json` assistant events carry cumulative snapshots of the growing message (same message id, text blocks growing from the start — verified against qodercli 1.1.41), not incremental deltas. Forwarding them directly replayed earlier text whenever a reply spanned multiple snapshots. A snapshot tracker now aligns text blocks per message and emits only newly grown suffixes.
- `.env.example` suggested `QODERCN_TIMEOUT_MS=120000`, below the 300s code default and far below what queued, tool-heavy agent requests need; it now suggests 600000.

### Added

- **True streaming for tool-declared requests**: `stream: true` requests that carry `tools` no longer wait for the fully buffered reply. The text part streams live through a safety gate (`findStreamingSafePrefixLength`) that withholds any tail which could still be or grow into the tool-call JSON payload — unclosed or closed ` ```json ` fences, unbalanced or `"tool_calls"`-bearing JSON objects, trailing partial backticks. Once the stream completes, the withheld tail is parsed and tool calls are appended as structured `delta.tool_calls` chunks (OpenAI) or `tool_use` blocks with `input_json_delta` (Anthropic). Agent clients like Claude Code now show live progress and receive tool confirmations in real time, while structured tool calling is unchanged. Skipped when `SERVER_TOOL_EXECUTION=1` — the multi-round server-side tool loop stays buffered.
- **Model registry update** (matching `qodercli --list-models`, qodercli 1.1.41):
  - New routing tiers: `ultimate` (`Ultimate`), `performance` (`Performance`), `efficient` (`Efficient`), `lite` (`Lite`), `cantus` (`Cantus`).
  - New models: `qwen3.8-flash` (`Qwen3.8-Flash`), `kimi-k3` (`Kimi-K3`), `glm-5.3-flash` (`GLM-5.3-Flash`).
  - Renamed to their current CLI offerings: `qwen3.8-max-preview` → `qwen3.8-max` (`Qwen3.8-Max`, effort aliases renamed accordingly), `glm-5.2` → `glm-5.3` (`GLM-5.3`), `minimax-m2.7` → `minimax-m3` (`MiniMax-M3`).
  - Removed `qwen3.6-flash`, which is no longer offered by the CLI. Requests for removed model IDs fall back to `auto`.
  - Synchronized model keys in `opencode.json` and both Chinese/English READMEs.

## [1.5.1] - 2026-07-29

### Fixed

- **Claude Code 504 timeouts and empty response issue (#9)**:
  - Deduplicated tool prompt injection in Anthropic message handler and CLI builder so heavy tool definitions (70+ tools) are not repeated twice.
  - Compacted `[Tool Protocol]` JSON stringification, cutting tool prompt token overhead by ~65%.
  - Added endpoint path aliases (`/v1/messages`, `/messages`, `/v1/v1/messages`, etc.) to handle common CCSwitch / Claude Code base URL path configuration mismatches.
  - Increased default `QODERCN_TIMEOUT_MS` to 300,000ms (5 minutes) for heavy agent tasks.

## [1.5.0] - 2026-07-26

Security release. Everyone running 1.4.x or earlier should update.

### Breaking

- **Browser clients served from a non-loopback origin are now refused.** Native
  clients (OpenCode, Trae, Cline, editor plugins, curl) send no `Origin` header
  and are unaffected. But if you drive the proxy from a hosted web UI — a remote
  LobeChat/NextChat instance pointed at `127.0.0.1`, say — those requests now get
  `403 origin_not_allowed`. Add the origin to `ALLOWED_ORIGINS` to restore it,
  understanding that any page on that origin can then spend your quota.

### Security

- **Cross-origin requests are now refused.** The proxy previously ran
  `cors({ origin: true })` with no authentication of any kind, so any web page
  the user visited could POST to `http://127.0.0.1:3000/v1/chat/completions`
  and read the response — spending the user's Qoder quota and issuing arbitrary
  prompts under their account. Browser requests are now accepted only from
  loopback origins; anything else gets `403 origin_not_allowed`, on the
  preflight as well as the request.
- **DNS rebinding is now blocked.** Requests whose `Host` header names a
  non-loopback host are refused with `403 host_not_allowed`, so a domain that
  resolves to `127.0.0.1` can no longer reach the proxy.
- **`PROXY_API_KEY` is now actually enforced.** It was documented in
  `.env.example` since 1.0 but never read by any code, so users who set it
  believed they had authentication when they had none. It is now required on
  `/v1/*` and `/usage/*` as `Authorization: Bearer <key>` or `x-api-key: <key>`,
  compared in constant time. Leaving it empty preserves the old key-free
  behaviour, and the startup log now says which mode is active.
- **Server-side tool execution is confined to a workspace.** With
  `SERVER_TOOL_EXECUTION=1`, file tools only rejected paths starting with `..`,
  so an absolute path (`C:\Users\you\.ssh\id_rsa`) read or wrote anything the
  proxy user could reach. All of Read/Write/Edit/Glob/Grep/Bash are now confined
  to `SERVER_TOOL_WORKSPACE` (default: the working directory), checked both
  lexically and after symlink resolution.
- **The `Bash` tool is now an allowlist, and runs without a shell.** Its previous
  blocklist of dangerous commands was ineffective — `/rm\s+-rf\s+\/+/` missed
  `rm -fr /`, the fork-bomb pattern was an unescaped regex that matched
  something else entirely, and none of it applied to Windows. Combined with the
  open CORS policy above, a web page could reach remote code execution on the
  user's machine. `Bash` now requires `SERVER_TOOL_ALLOW_BASH=1` plus a
  non-empty `SERVER_TOOL_BASH_ALLOWLIST` of bare executable names, refuses shell
  metacharacters, refuses path-qualified executables, and spawns via
  `execFileSync` with no shell.
- **`GET /` no longer returns local filesystem paths.** It exposed `cli_home`
  (which embeds the OS username) and `cli_command` to any caller. Those are
  printed to the server's own startup log instead.

### Added

- `ALLOWED_ORIGINS` and `ALLOWED_HOSTS` as explicit opt-outs for people who
  deliberately front the proxy with another origin or hostname.
- `SERVER_TOOL_WORKSPACE`, `SERVER_TOOL_ALLOW_BASH`, and
  `SERVER_TOOL_BASH_ALLOWLIST` for scoping server-side tool execution.
- A **Proxy API Key** field in the web console (Config tab), stored in
  `localStorage`, so the console keeps working once a key is set.
- `SECURITY.md` now documents a private disclosure channel (GitHub private
  vulnerability reporting) and a written threat model.

### Fixed

- The web console's Dashboard always displayed **0 models**: it passed an
  unparsed `Response` object where JSON was expected, so `models.data` was
  always `undefined`.
- `Glob` patterns treated `.` as "any character", so `*.js` also matched files
  like `bjs`. Regex metacharacters in the pattern are now escaped before the
  glob wildcards are applied.
- `Glob` and `Grep` results are capped (500 matches) and report `truncated`
  rather than walking an entire tree without bound.

## [1.4.2] - 2026-07-20

### Added

- **New models** ([#7]): `qwen3.8-max-preview` (`Qwen3.8-Max-Preview`, with effort aliases), `qwen3.7-plus` (`Qwen3.7-Plus`), and `minimax-m2.7` (`MiniMax-M2.7`), matching Qoder CLI CN 1.1.0. Removed `qwen3.6-plus`, which is no longer offered by the CLI. Note: the new models require Qoder CLI CN ≥ 1.1.0 (`qoderclicn update`).

### Fixed

- **Empty responses in agent clients (OpenCode, Trae, …)** ([#8]): streaming requests that declare `tools` are now buffered, parsed, and returned as structured tool calls — OpenAI `delta.tool_calls` chunks with `finish_reason: "tool_calls"`, Anthropic `tool_use` content blocks with `input_json_delta` and `stop_reason: "tool_use"`. Previously (since 1.3.0) the raw tool-call JSON was streamed as plain text, which agent clients could not interpret and rendered as an empty message.
- **Silent stream failures**: when the CLI fails mid-stream, the proxy now emits an SSE error payload (OpenAI: `data: {"error": …}`; Anthropic: `event: error`) instead of silently ending the stream with no content.
- **Empty streams from unrecognized CLI output**: if `stream-json` output yields no recognizable assistant deltas, the final text is now extracted from the last meaningful record (e.g. a `result` record) as a fallback, matching non-streaming behavior.
- **Windows cmd.exe argument limit**: when the CLI is spawned through the `cmd.exe` fallback, `--append-system-prompt` is moved into the attachment file above ~7.5k characters (cmd.exe truncates command lines at 8,191 chars; the previous 30k threshold only guarded the CreateProcess limit). Long agent system prompts no longer break the spawn.

### Changed

- **Server-side tool execution is now opt-in** (`SERVER_TOOL_EXECUTION=1`): by default, tool calls are returned to the client for execution, which is what agent clients expect — they run tools in their own workspace. The previous default executed tools inside the proxy process and never surfaced `tool_calls` to the client.
- The OpenAI-compatible endpoint now accepts the `developer` role and routes it as a system message.

## [1.4.1] - 2026-07-17

### Changed

- **Model registry update**: `glm-5.1` → `glm-5.2` (`GLM-5.2`) and `kimi-k2.6` → `kimi-k2.7-code` (`Kimi-K2.7-Code`) to match current Qoder CLI model names.
- Synchronized model keys in `opencode.json` and both Chinese/English READMEs.

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
