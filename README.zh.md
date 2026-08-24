<div align="center">

# dsh-omnivision

**让 DeepSeek 看见图像——而不碰它的 KV Cache。**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的视觉桥接插件：
每张图片在到达模型**之前**就被转换为忠实的文字描述，请求始终保持纯文本形态、前缀缓存
持续保温；聊天界面照常显示原始图片。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-232%20passing-brightgreen)](tests)
[![Coverage](https://img.shields.io/badge/coverage-98%25-brightgreen)](reports)

[English](README.md) · **简体中文**

</div>

---

## 为什么

往对话里贴图，通常意味着切换到多模态消息格式——每张图片都会使提示词前缀缓存失效、拖慢
后续每一轮，并且把你和单一厂商的视觉 API 绑死。

**dsh-omnivision 走另一条路：图片根本不进入模型请求。** pre-step 桥接层先把图片描述成
文字。DeepSeek 收到的消息结构与"没有图片时"完全一致——同样的纯文本形状、同样的可缓存性；
而用户在界面上仍然能看到自己发的图（影子历史层）。

## 工作原理

```
 用户粘贴图片                        ┌────────────────────────────┐
        │                           │  视觉 Provider 链           │
        ▼                           │  LM Studio → Ollama →      │
┌──────────────────┐    描述请求      │  OpenAI / Anthropic /      │
│ 校验             │ ─────────────► │  Gemini / Zhipu / Zen /    │
│ 路径·大小        │   （返回文字）   │  OVH Free（免登录）         │
│ 符号链接         │                └────────────────────────────┘
└──────────────────┘                         │
        │                                    ▼
        │                          [已识图1: 一张设置对话框截图…]
        ▼                                    │
┌──────────────────┐                         ▼
│ 影子历史          │                 纯文本消息 ──►  DeepSeek
│ UI 显示原图，     │              （与无图请求结构完全相同）
│ 模型只看到文字    │
└──────────────────┘
```

三个关键设计决策：

| 决策 | 效果 |
|---|---|
| **稳定查询模板** —— 描述请求通过由 `language` × `visionDepth` 生成的固定模板发出，从不使用用户原始输入 | 同一张图片跨不同用户消息都能命中本地缓存；provider 侧的前缀缓存看到的是重复、可预测的提示词 |
| **失败绝不污染模型上下文** —— 失败的图片不产生任何标记，只通过结构化 `failures[]` 数组上报给界面 | 内部错误、provider 名称、网络细节永远不可能泄漏进对话 |
| **全量配置驱动** —— 模型、端点、API key 环境变量名、超时、缓存大小/TTL 都是普通配置字段 | 换厂商或指向私有网关，不改一行代码 |

## 特性

- 🔒 **构造上保证 KV Cache 安全** —— 有图无图，模型请求形状逐字节一致
- 🏭 **Provider 工厂** —— OpenAI、Anthropic、Gemini、Zhipu、OVH Free、Ollama、LM Studio，外加通用 OpenAI 兼容工厂
- 🆓 **零配置可用** —— 一个 key 都不设，匿名 OVH 端点照样提供视觉能力
- 🧯 **干净的失败契约** —— 逐图失败原因（`too_large` / `symlink` / `provider`）旁路返回
- 🛠️ **工具注册表** —— 九个可分发的视觉工具，带参数校验与凭据脱敏
- ⚡ **真实的韧性** —— 持久熔断器、强制超时预算的 failover 链、带 TTL 与会话隔离的 LRU 缓存
- 🛡️ **纵深防御** —— 分段路径白名单、符号链接拒绝、大小限制、SSRF 防护、三层凭据脱敏

## 安装

> **状态：alpha。** npm 发布筹备中，当前请从源码安装。

```bash
git clone https://github.com/zsagi1368/dsh-omnivision.git
cd dsh-omnivision
npm ci
npm run build        # 产出 dist/index.js + 类型声明
npm test             # 232 个测试，约 1 秒
```

要求 **Node ≥ 22.19**。可选 peer 依赖 [`sharp`](https://www.npmjs.com/package/sharp)
启用 `vision_crop` / `vision_pixel_diff`。

## 快速开始

```ts
import { createOmnivisionPlugin, resolveConfig } from 'dsh-omnivision';

const plugin = createOmnivisionPlugin({
  config: resolveConfig({
    language: 'zh',              // 'zh' | 'en' —— 标记与提示词语言
    visionDepth: 'standard',     // 'fast' | 'standard' | 'deep'
  }),
  workspace: process.cwd(),      // 允许读取图片附件的根目录
  sessionId: 'session-1',        // 描述缓存的隔离作用域
});

// Pre-step：把消息交给 DeepSeek **之前**调用
const result = await plugin.processMessage(content, attachments, eventId);

if (result.rewritten) {
  sendToDeepSeek(result.newContent);      // 纯文本，已附加标记
}
if (result.hasErrors) {
  surfaceInUi(result.failures);           // 绝不会出现在 newContent 里
}

// 工具：按需深入分析某张图
const hit = await plugin.callTool('vision_ground', {
  image: attachments[0],
  target: '登录按钮',
});
```

模型实际看到的内容（auto 模式，中文）：

```
<用户原始文字>

[已识图1: 一张设置对话框，两栏布局…
OCR: 常规 | 外观 | 高级]
```

## Provider 链

严格按顺序尝试，直到某个成功。依次为：你的自定义配置 → 本地后端 → 免费兜底尾部：

| 顺序 | Provider | 默认模型 | 鉴权 | 说明 |
|---|---|---|---|---|
| 1 | 自定义项（`config.providers`） | 可配置 | 可选 | 内置命名（`openai`/`anthropic`/`gemini`/`zhipu`/`ovh`）或任意 OpenAI 兼容 `baseUrl` |
| 2 | LM Studio *（启用时）* | `qwen2.5-vl-7b` | 无 | 本地，`allowLocalNetwork` |
| 3 | Ollama *（启用时）* | `qwen2.5-vl:7b` | 无 | 本地，`allowLocalNetwork` |
| 4a | OVH Free | `Qwen2.5-VL-72B-Instruct` | **无** | 完全匿名——零配置视觉 |
| 4b | Zhipu | `glm-4.6v-flash` | `ZAI_API_KEY` | 检测到 key 才入链 |
| 4c | OpenCode Zen Free | `big-pickle` *（可配置）* | `OPENCODE_API_KEY` | 检测到 key 才入链 |

`freeCloudFirst: true` 会把有 key 的免费 provider 排到 OVH 之前。免费模型若拒收图片，
链会自动滑向下一级。

**环境变量（全部可选）：**

| 变量 | 启用 |
|---|---|
| `OPENAI_API_KEY` | OpenAI（`gpt-4o`） |
| `ANTHROPIC_API_KEY` | Anthropic（`claude-3-5-sonnet-20241022`） |
| `GEMINI_API_KEY` | Google Gemini（`gemini-2.0-flash`） |
| `ZAI_API_KEY` | Zhipu GLM-V flash |
| `OPENCODE_API_KEY` | OpenCode Zen 免费档 |

**一个环境变量都不设**，插件也能通过匿名 OVH 端点完整工作。

## 模式

| 模式 | 行为 |
|---|---|
| `auto` *（默认）* | 静默追加完整描述标记；用户无感 |
| `interactive` | 一句话摘要 + 工具提示；模型按需用工具深挖 |
| `manual` | 不做预处理——工具仍可供显式调用 |

## 工具集

所有工具经 `plugin.callTool(name, args)` 与导出的注册表（`registerTool` / `getTool` /
`listTools`）分发。参数自动校验，handler 异常先脱敏再返回。

| 工具 | 参数 | 依赖 | 状态 |
|---|---|---|---|
| `vision_describe` | `image`、`query?` | 视觉 provider | ✅ |
| `vision_ocr` | `image` | 视觉 provider | ✅ |
| `vision_detect` | `image`、`category?` | 视觉 provider | ✅ 严格 JSON 列表，原文兜底 |
| `vision_ground` | `image`、`target` | 视觉 provider | ✅ 严格 JSON `{found, box, label}`，0–1000 归一化坐标 |
| `vision_bootstrap` | `image` | 视觉 provider | ✅ 结构化首轮分析 |
| `vision_crop` | `image`、`box` | sharp *（可选 peer）* | ✅ 裁剪输出 PNG 到临时目录 |
| `vision_pixel_diff` | `image`、`reference` | sharp *（可选 peer）* | ✅ 真像素空间对比，相似度 0–1 |
| `vision_trace` | — | — | 🚧 占位，返回明确的未实现错误 |
| `vision_screenshot` | `html` | — | 🚧 占位，返回明确的未实现错误 |

注册自定义工具：

```ts
import { registerTool } from 'dsh-omnivision';

registerTool({
  name: 'vision_palette',
  description: '提取主色调',
  inputSchema: { required: ['image'] },
  async handler(ctx, args) { /* ctx.bridge, ctx.image, ctx.config */ },
});
```

## 配置

部分配置会与 `DEFAULT_CONFIG` 合并；嵌套对象做一层深合并。权威来源：
[`src/config/schema.ts`](src/config/schema.ts)。

```ts
config: resolveConfig({
  language: 'zh',
  visionDepth: 'standard',
  freeZen: { model: 'big-pickle' },   // Zen 免费模型在这里轮换
})
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | `'auto' \| 'interactive' \| 'manual'` | `'auto'` | 图片处理策略 |
| `routing` | `'pre-step' \| 'tool-call' \| 'hybrid'` | `'pre-step'` | 声明式路由提示 |
| `providers` | `Array<{name, model?, apiKeyEnv?, baseUrl?}>` | `[]` | 自定义 provider 覆盖，最高优先级 |
| `localLmStudio` | `{enabled, baseURL, model}` | `false`，`http://localhost:1234/v1` | 本地后端 |
| `localOllama` | `{enabled, baseURL, model}` | `false`，`http://127.0.0.1:11434/v1` | 本地后端 |
| `freeFallback` | `boolean` | `true` | 追加免费 provider 尾部 |
| `freeCloudFirst` | `boolean` | `false` | 有 key 的免费 provider 排在 OVH 前 |
| `freeZen` | `{enabled, model, apiKeyEnv}` | `true`、`'big-pickle'`、`'OPENCODE_API_KEY'` | OpenCode Zen 免费档 |
| `maxImageBytes` | `number` | `4194304`（4 MiB） | 单图处理硬上限 |
| `maxImagePixels` | `number` | `20000000` | schema 层防护（`validateConfig` 在 >100 MP 时告警） |
| `cache` | `boolean` | `true` | 启用描述缓存 |
| `cacheTtlSeconds` | `number` | `3600` | 缓存条目存活时间 |
| `cacheMaxEntries` | `number` | `200` | 每会话 LRU 容量 |
| `timeoutMs` | `number` | `120000` | 整链超时预算 |
| `visionTaskTimeoutMs` | `number` | `45000` | 单 provider 超时预算 |
| `language` | `'zh' \| 'en'` | `'zh'` | 标记与提示词语言 |
| `visionDepth` | `'fast' \| 'standard' \| 'deep'` | `'standard'` | 描述提示词详略档位 |
| `progressiveTools` | `boolean` | `false` | 声明式工具暴露提示 |

## 错误处理契约

失败永不改动模型可见内容：

```ts
interface ProcessMessageResult {
  rewritten: boolean;       // 全部失败时为 false
  newContent: string;       // 至少一张成功前保持原样
  imageCount: number;
  descriptions: string[];   // 仅成功项
  hasErrors: boolean;
  failures?: Array<{
    index: number;
    path: string;
    reason: 'too_large' | 'symlink' | 'provider';
    message: string;        // 已脱敏
  }>;
}
```

全部失败时 `newContent` 原样返回，原因链落在 `failures`——展示方式由界面决定。

## 安全

**文件系统**

- **分段级路径策略** —— 包含性判断基于 `path.relative`，`/tmp-evil` 永远匹配不上 `/tmp`；只允许根的"内容"，根本身不算
- **根路径规范化** —— workspace / 临时目录 / 额外目录在比较前一律经 `realpathSync` 处理，符号链接组件无法伪造包含关系
- **叶节点符号链接探测** —— `allowInput` / `allowOutput` 对最终路径分量做 lstat 探测，植入的符号链接直接拒绝
- **TOCTOU 复核** —— provider 在 `readFileSync` 前一刻复核目标仍是普通文件
- **大小限制** —— 经 `stat` 强制执行单图上限；无论配置如何，provider 读取硬上限 25 MB

**网络**

- **每次远程调用前的 SSRF 防护** —— DNS 解析后拒绝私有、回环、链路本地、多播/保留网段，**包括 CGNAT（`100.64.0.0/10`）与 IPv4 映射 IPv6 形式**（`::ffff:10.0.0.5` 按其内嵌 v4 地址判断）
- **不跟随重定向** —— 所有请求 `redirect: 'manual'`；本地后端（Ollama / LM Studio）需显式 `allowLocalNetwork` 豁免

**凭据**

- 三层脱敏覆盖所有错误出口 —— 已知密钥精确匹配 → 形状正则 → URL userinfo；密钥只存在于环境变量中

## 开发

| 命令 | 用途 |
|---|---|
| `npm run build` | 打包（`dist/index.js`）+ 生成类型声明 |
| `npm test` | 运行 232 个测试（约 1 秒，零网络） |
| `npm run coverage` | V8 覆盖率报告 |
| `npm run lint` / `npm run format` | Biome 检查 / 自动修复 |
| `npm run dev` | 监听重建 |

测试套件完全离线（mock fetch/DNS）且跨平台——路径一律经 `os.tmpdir()` 构造，Windows、
Linux、macOS 结果一致。

## 状态与路线图

- ✅ 核心桥接、Provider 工厂、工具注册表、安全层
- ✅ 已对运行中的 DeepSeek Harness 宿主完成集成验证并加固（monorepo 扩展形态）
- ✅ 232 个测试 · 98% 语句覆盖率 · typecheck 与 lint 干净
- 🔲 首次 npm 发布
- 🔲 `vision_trace` / `vision_screenshot` 实现

## 许可证

[MIT](LICENSE) © zsagi1368
