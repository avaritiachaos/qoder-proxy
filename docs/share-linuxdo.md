做了个本地反代，把 Qoder CN 的 CLI 包装成 OpenAI / Anthropic 兼容 API

## 背景

Qoder CN 有个命令行工具 qoderclicn，背后能跑 Qwen3.7-Max、GLM-5.1、Kimi-K2.6、DeepSeek-V4 这些模型。但问题是它只接受命令行文本输入，大部分工具只认 HTTP API。

所以写了个代理做中间层：工具发 API 请求过来 → 代理翻译成 CLI 调用 → 再把 CLI 输出翻译回 API 格式。

GitHub: https://github.com/avaritiachaos/qoder-cn-proxy

## 支持什么

两个端点：

- `/v1/chat/completions` —— OpenAI 格式，OpenCode、SillyTavern 这类工具用
- `/v1/messages` —— Anthropic 格式，Claude Code 用

两个格式都支持工具调用。OpenCode 和 Claude Code 可以跑 Agent 模式（文件读写、命令执行这些），前提是底层模型能稳定输出工具调用 JSON。

流式输出是真的，不是那种等全部生成完再一次性吐的假流式。用了 `--output-format stream-json`，文本增量实时转发。

## 工具调用怎么实现的

因为 qoderclicn 只有文本通道，没有原生的 tools 参数，所以是 Prompt 注入 + 输出解析：把工具定义写进 Prompt 告诉模型格式，再从回复里提取 JSON。

和官方 API 的原生 tool calling 肯定有差距，可靠性取决于模型听不听话。Qwen3.7-Max 表现还行。

## 不会污染 Prompt

代理有三条路径，只在必要时注入最少内容：

1. 客户端自带 system prompt（比如 SillyTavern）：零注入，什么都不加
2. 简单对话：只加一句元指令
3. Agent 模式（有 tools）：只加格式指令，不加角色定义

## 怎么用

```
git clone https://github.com/avaritiachaos/qoder-cn-proxy
cd qoder-cn-proxy
npm install
copy .env.example .env
```

编辑 .env 填上 Qoder CN 的令牌（在 https://qoder.com.cn/account/integrations 创建），然后 `npm start`。

需要 Node.js 18+ 和 qoderclicn（`npm install -g @qodercn-ai/qoderclicn`）。

## 支持的模型

qoder-cn, auto, qwen3.7-max, glm-5.1, kimi-k2.6, qwen3.6-plus, qwen3.6-flash, deepseek-v4-pro, deepseek-v4-flash

Qwen3.7-Max 还能选推理强度：qwen3.7-max-effort-low / medium / high / max

## 限制

- 工具调用是模拟的，不是原生能力
- 每次请求起一个子进程
- 工具调用的响应不走流式

基本上是个够用就好的本地玩具，MIT 开源，有兴趣的可以看看。
