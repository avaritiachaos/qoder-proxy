# Qoder CN Proxy

> Qoder CN CLI 的本地 OpenAI-compatible 协议代理。仅供学习、研究和本地实验使用。

这个项目优先面向 OpenCode，提供一个最小的本地兼容协议代理：客户端按 OpenAI Chat Completions 格式请求本服务，本服务再调用官方 Qoder CN CLI `qoderclicn`。

## 免责声明

本项目不是 Qoder、Qoder CN 或 OpenCode 的官方项目，也未获得其背书或赞助。

本项目仅供学习和本地实验使用。使用者需要自行遵守上游服务、CLI、模型和账号体系的使用条款，并自行承担风险。

## 安全边界

- 认证只读取环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN`。
- 服务只监听 `127.0.0.1`。
- 日志会脱敏 Authorization、cookie、token、access_token 和 `QODERCN_PERSONAL_ACCESS_TOKEN`。
- clean 实现不会读取 Qoder/QoderWork 桌面客户端的本地认证文件。
- clean 实现不会扫描 `%APPDATA%`、`%LOCALAPPDATA%` 或 `%USERPROFILE%\.qoderwork`。
- 不要把 token 写进源码、配置、README、测试、issue、截图或日志。

根目录旧实验文件 `server.js` 已通过 `.gitignore` 排除，不会作为公开仓库内容发布。

## 环境要求

- Node.js 18 或更新版本
- Qoder CN CLI

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

## 安装和启动

```powershell
npm install
Copy-Item .env.example .env
```

编辑本地 `.env`，填入：

```text
QODERCN_PERSONAL_ACCESS_TOKEN=你的 token
```

不要提交 `.env`。

启动服务：

```powershell
npm start
```

Windows 也可以双击：

```text
start-proxy.cmd
```

## 接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

当前限制：

- 只实现 OpenAI-compatible chat completions
- SSE streaming 格式兼容，但代理会先等待 Qoder CLI 完整返回，再一次性输出内容
- 暂不支持 tool calls
- 每个 chat 请求会启动一次 Qoder CN CLI 子进程
- Qoder CN CLI 必须返回结构化 JSON，非结构化输出不会被猜测解析

## 模型

代理暴露这些模型 ID：

- `qoder-cn`
- `auto`
- `qwen3.7-max`
- `glm-5.1`
- `kimi-k2.6`
- `qwen3.6-plus`
- `qwen3.6-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash`

Qwen3.7-Max 额外提供普通模型别名，方便在 OpenCode 模型列表里直接选择推理强度：

- `qwen3.7-max-effort-low`
- `qwen3.7-max-effort-medium`
- `qwen3.7-max-effort-high`
- `qwen3.7-max-effort-max`

这些别名会映射回 Qoder CN CLI 的 `Qwen3.7-Max`，并附加对应的 `--reasoning-effort`。

## 推理强度和输出选项

可以用环境变量设置全局默认值：

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

也可以在单次请求中传入：

- `reasoning_effort` 或 `reasoningEffort`
- `context_window` 或 `contextWindow`
- `max_tokens` 或 `maxOutputTokens`
- OpenCode/provider option 形态，例如 `providerOptions`

## OpenCode 使用

仓库内置项目级 `opencode.json`。从本项目目录启动 OpenCode 时，会使用：

```text
http://127.0.0.1:3000/v1
```

示例：

```powershell
opencode run --model qoder-cn-local/qwen3.7-max --variant high "只返回 OK"
```

或者直接选择推理强度别名：

```powershell
opencode run --model qoder-cn-local/qwen3.7-max-effort-high "只返回 OK"
```

## SillyTavern / 酒馆配置

在酒馆里使用 Chat Completion 的自定义 OpenAI-compatible 源：

- API 类型：`Chat Completion`
- Chat Completion Source：`Custom (OpenAI-compatible)`
- Custom Endpoint / Base URL：`http://127.0.0.1:3000/v1`
- API Key：`not-used`
- Model：从模型下拉框选择，或手动填写模型 ID

Base URL 不要写成 `/v1/chat/completions`。不要把 Qoder CN token 填进酒馆；token 只放在代理运行环境或本地 `.env` 里。

## curl 检查

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

## 测试

```powershell
npm test
```

## 许可证

MIT。详见 [LICENSE](LICENSE)。
