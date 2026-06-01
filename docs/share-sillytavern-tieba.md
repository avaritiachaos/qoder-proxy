分享一个本地反代工具，酒馆可以接 Qoder CN 的模型了（Qwen、GLM、Kimi、DeepSeek）

## 是什么

一个开源的本地代理，把 Qoder CN 的模型包装成酒馆能识别的 OpenAI 格式 API。接上之后酒馆里就能直接选 Qwen3.7-Max、GLM-5.1、Kimi-K2.6、DeepSeek-V4 这些模型用了。

GitHub：https://github.com/avaritiachaos/qoder-cn-proxy

## 大家最关心的：会不会污染角色卡？

不会。这个代理有个反污染机制 —— 当酒馆发过来的请求自带 system prompt（也就是你的角色卡和预设），代理什么都不加，零注入。你的角色人格完全由酒馆控制，不会被代理塞进什么"你是一个编程助手"之类的东西。

## 怎么接

装好之后在酒馆里这么配：

- API 类型：Chat Completion
- Source：Custom (OpenAI-compatible)
- Base URL：http://127.0.0.1:3000/v1
- API Key：随便填，比如 not-used
- Model：填你想用的模型 ID，比如 qwen3.7-max

注意不要把 Qoder CN 的令牌填进酒馆里，令牌只放在代理的 .env 文件里。

## 安装步骤

1. 装 Node.js 18+（https://nodejs.org）
2. 装 Qoder CN CLI：`npm install -g @qodercn-ai/qoderclicn`
3. 下载项目：`git clone https://github.com/avaritiachaos/qoder-cn-proxy`（或者直接去 GitHub 页面下载 ZIP）
4. 进入目录，`npm install`
5. 复制 `.env.example` 为 `.env`，编辑填上你的令牌
6. `npm start` 启动

令牌在这里创建：https://qoder.com.cn/account/integrations ，创建后只显示一次，记得保存。

## 支持哪些模型

qwen3.7-max、glm-5.1、kimi-k2.6、qwen3.6-plus、qwen3.6-flash、deepseek-v4-pro、deepseek-v4-flash

还能选推理强度，比如 qwen3.7-max-effort-high 会让模型想得更深入再回答。

## 补充说明

- 支持流式输出，打字效果是实时的，不是等全部生成完再出
- 完全本地运行，只监听 127.0.0.1，不会暴露到网络
- 开源 MIT 协议，代码都在 GitHub 上

有什么问题可以在帖子里问，也可以去 GitHub 提 issue。
