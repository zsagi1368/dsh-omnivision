# dsh-omnivision

[English](README.md) | [中文](README.zh.md)

面向 **DeepSeek Harness (DSH)** 的 Cordis 插件包：在图片到达 DeepSeek **之前**先转成文字描述——模型只会看到纯文本，KV Cache / 前缀缓存不会被多模态内容扰动。UI 侧通过"影子历史 (shadow history)"机制继续展示原始图片。

> **状态：alpha，尚未进行集成测试。** 插件核心、Provider 链、工具与安全层已在库层面实现并通过单元/集成测试，但**尚未接入真实的 DeepSeek Harness 运行时**。下文的 `PluginContext` / `processMessage` 契约即集成界面。一切接口均可能变化。

## 工作原理（KV Cache 安全架构）

```
用户贴入图片
        |
        v
+-----------------------------------------------+
| 预处理桥接层（本插件，在 DeepSeek 之前执行）      |
|  1. 校验路径 / 大小 / 符号链接                   |
|  2. 描述缓存查询（稳定键）                       |
|  3. Provider 故障转移链 -> 文字                  |
|  4. 将消息改写为纯文本                           |
+-----------------------------------------------+
        |
        v   文本标记，如 [Image 1: ...] / [已识图1: ...]
   DeepSeek  <---- 只收纯文本；KV Cache 不受影响
        |
        v
 影子历史：UI 保留原始图片事件，
 模型侧历史保存文字替换内容
```

两个性质保证了缓存安全：

- **纯文本进、纯文本出。** DeepSeek 永远不会收到图片部分；图片不会改变会话的请求结构。
- **稳定的查询模板。** 发送给 Provider 的视觉查询是由 `language` + `visionDepth` 派生的固定模板——绝不是用户的原始消息。带来的效果：同一张图在不同用户提示词下都能命中本地描述缓存，且 Provider 侧的前缀缓存因提示词前缀可预测而保持温热。

影子历史：当 `processMessage` 收到 `eventId` 时，会返回
`shadows: [{ surfaceOp: keep, modelOp: replace }]` 对——宿主 UI 保留图片用于展示，而模型可见历史替换为描述文字。

## Provider 链（故障转移顺序）

按顺序尝试 Provider，直到一个成功：

1. `extraProviders`（编程注入缝，主要用于测试）
2. `providers[]` 配置项，按声明顺序
3. LM Studio（当 `localLmStudio.enabled`）
4. Ollama（当 `localOllama.enabled`）
5. 免费云兜底（当 `freeFallback: true`）：
   - `freeCloudFirst: false`（默认）：OVH -> 智谱（有 key 时）-> Zen（有 key 时）
   - `freeCloudFirst: true`：智谱（有 key 时）-> Zen（有 key 时）-> OVH

| Provider | `providers[].name` | 默认模型 | 鉴权 | 说明 |
|---|---|---|---|---|
| OpenAI | `openai` | `gpt-4o` | `OPENAI_API_KEY` | OpenAI 兼容 `/v1` |
| Anthropic | `anthropic` | `claude-3-5-sonnet-20241022` | `ANTHROPIC_API_KEY` | Messages API |
| Google Gemini | `gemini` | `gemini-2.0-flash` | `GEMINI_API_KEY` | key 走 `x-goog-api-key` 请求头 |
| 智谱 | `zhipu` | `glm-4.6v-flash` | `ZAI_API_KEY` | 免费档，需要 key |
| OVH Free | `ovh`（别名 `ovh-free`） | `Qwen2.5-VL-72B-Instruct` | 无 | 完全匿名；零配置默认项 |
| OpenCode Zen | —（经 `freeZen`） | `big-pickle`（可配） | `OPENCODE_API_KEY`（可配） | 免费档，需登录 key |
| Ollama | —（经 `localOllama`） | `qwen2.5-vl:7b` | 无 | 本地，豁免 SSRF 检查 |
| LM Studio | —（经 `localLmStudio`） | `qwen2.5-vl-7b` | 无 | 本地，豁免 SSRF 检查 |
| 任意 OpenAI 兼容 | 其他任意 name + `baseUrl` | 经 `model` 指定（必填） | 经 `apiKeyEnv` 可选 | 通用适配器 |

所有默认值都可通过 `providers[].model` / `baseUrl` / `apiKeyEnv` 按条目覆盖。

### 环境变量

| 环境变量 | 使用方 | 是否必需 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI Provider | 否 |
| `ANTHROPIC_API_KEY` | Anthropic Provider | 否 |
| `GEMINI_API_KEY` | Gemini Provider | 否 |
| `ZAI_API_KEY` | 智谱（设置后自动加入免费兜底链） | 否 |
| `OPENCODE_API_KEY` | OpenCode Zen 免费档（`freeZen.enabled` 且已设置时自动加入） | 否 |

**所有 key 都是可选的。** 零配置、零 key 时，链中仍有匿名的 OVH 端点，图片描述开箱即用（受 OVH 不可控的限流约束）。可通过 `providers[].apiKeyEnv` 和 `freeZen.apiKeyEnv` 使用自定义环境变量名。

### 容错能力

- **熔断器**（内存态，由插件实例持有、跨调用共享，最多 128 个 Provider 条目）：`AUTH` / `REGION` / `TOS` 类失败封锁 Provider 10 分钟；`RATE_LIMIT` / `QUOTA` 60 秒；其他失败 30 秒。
- **超时**：`timeoutMs` 是单张图片跨整条链的总预算；`visionTaskTimeoutMs` 是单 Provider 预算，通过组合的 `AbortSignal` 强制执行。剩余预算计算避免后面的 Provider 超支。
- **失败分类**：抛出的异常会被分类（`AUTH`、`RATE_LIMIT`、`TIMEOUT`、`NETWORK` 等）并脱敏；不可重试的失败会终止链条，不做无意义重试。

### 缓存

按插件实例的 LRU 描述缓存，TTL 与容量可配。缓存键为
`sha256(sessionId | mode | 图片 contentHash | 查询模板)`——按会话隔离；由于查询永远是模板而非原始用户输入，同一张图在不同提示词下键值稳定。

## 模式

| `mode` | 预处理行为 | DeepSeek 收到的内容 |
|---|---|---|
| `auto`（默认） | 完整描述标记追加到消息后 | 每张图一个 `[Image 1: ...]` / `[已识图1: ...]`（Provider 返回结构化 OCR 时附最多 500 字符的 OCR 摘录） |
| `interactive` | 每图一两句话概括 + 工具提示行 | 短标记 + 提示可调用 `vision_describe` / `vision_ground` / `vision_detect` 获取细节 |
| `manual` | 不做预处理；原样返回内容 | 原始内容；由用户/模型通过工具驱动分析 |

多图时标记前有标题行（`2 images described:` / `已识图2张：`）。失败的图片永远不会产生标记（见下文）。

## 工具

所有工具注册在注册表中，经 `plugin.callTool(name, args)` 分发。
接受 `image` 参数的工具期望附件对象 `{ path, contentHash, mime?, bytes? }`。

| 工具 | 参数 | 依赖 | 状态 |
|---|---|---|---|
| `vision_describe` | `image`、`query?` | 视觉 Provider | 已实现 |
| `vision_ocr` | `image` | 视觉 Provider | 已实现 |
| `vision_detect` | `image` | 视觉 Provider | 已实现；严格 JSON 数组，解析失败回退原始文本 |
| `vision_ground` | `image`、`target` | 视觉 Provider | 已实现；严格 JSON `{found, box, label}`，0-1000 归一化坐标 |
| `vision_bootstrap` | `image` | 视觉 Provider | 已实现；结构化首轮分析 JSON |
| `vision_crop` | `image`、`box` | **`sharp`（可选 peer 依赖）** | 已实现；缺少 `sharp` 时返回清晰的依赖错误 |
| `vision_pixel_diff` | `image`、`reference` | **`sharp`（可选 peer 依赖）** | 已实现；缺少 `sharp` 时返回清晰的依赖错误 |
| `vision_trace` | — | — | **占位**：返回明确的未实现错误 |
| `vision_screenshot` | `html` | `puppeteer-core`（实现后手动安装） | **占位**：返回明确的未实现错误 |

`sharp` 是 `package.json` 中唯一声明的（可选）peer 依赖——`vision_crop` / `vision_pixel_diff` 在运行时真实加载它。`puppeteer-core` 与 `potrace` 未声明，因为目前没有代码引用它们；占位工具实现后再手动安装即可。

## 错误处理契约

失败信息绝不渗入模型可见内容。`processMessage` 返回：

```ts
interface ProcessMessageResult {
  rewritten: boolean;        // 至少一张图片描述成功
  newContent: string;        // 模型可见内容；全部失败时为原始内容
  imageCount: number;        // 通过校验的图片附件数
  descriptions: string[];    // 成功的摘要，按图片顺序
  shadows?: ShadowReplacement[]; // 仅当提供了 eventId 时
  hasErrors: boolean;
  failures?: AttachmentFailure[]; // 给 UI 层的逐附件明细——绝不渲染进 newContent
}

interface AttachmentFailure {
  index: number;                          // 在原始 attachments 数组中的位置
  path: string;
  reason: 'too_large' | 'symlink' | 'provider';
  message: string;                        // 已脱敏
}
```

- 非图片、路径越权、不可读的文件会被静默跳过（不算错误）。
- 超限（`> maxImageBytes`）与符号链接附件产生 `failures` 条目。
- 全部图片失败时，`rewritten` 为 `false`，`newContent` 为原始内容。

## 配置参考

权威来源：`src/config/schema.ts`（`OmniVisionConfig` / `DEFAULT_CONFIG`）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | `'auto' \| 'interactive' \| 'manual'` | `'auto'` | 预处理交互模式（见"模式"） |
| `routing` | `'pre-step' \| 'tool-call' \| 'hybrid'` | `'pre-step'` | **仅为声明式**——为前向兼容而保留；当前运行时始终执行 pre-step 桥接 + 常驻工具注册表 |
| `providers` | `Array<{ name, model?, apiKeyEnv?, baseUrl? }>` | `[]` | 显式 Provider 条目，按序尝试。`name` 映射到内置工厂（`openai`、`anthropic`、`gemini`、`zhipu`、`ovh`）；未知 name **带** `baseUrl` 时成为通用 OpenAI 兼容 Provider；未知 name 且无 `baseUrl` 时被忽略 |
| `localOllama.enabled` | `boolean` | `false` | 将本地 Ollama 加入链中 |
| `localOllama.baseURL` | `string` | `'http://127.0.0.1:11434/v1'` | Ollama OpenAI 兼容端点（应为本地地址，否则告警） |
| `localOllama.model` | `string` | `'qwen2.5-vl:7b'` | Ollama 视觉模型 |
| `localLmStudio.enabled` | `boolean` | `false` | 将本地 LM Studio 加入链中 |
| `localLmStudio.baseURL` | `string` | `'http://localhost:1234/v1'` | LM Studio 端点 |
| `localLmStudio.model` | `string` | `'qwen2.5-vl-7b'` | LM Studio 视觉模型 |
| `freeFallback` | `boolean` | `true` | 在链尾追加免费云兜底（OVH / 智谱 / Zen） |
| `freeCloudFirst` | `boolean` | `false` | `true` 时免费云（智谱、Zen）排在 OVH 之前 |
| `freeZen.enabled` | `boolean` | `true` | key 存在时加入 OpenCode Zen 免费档 |
| `freeZen.model` | `string` | `'big-pickle'` | Zen 模型 id。**免费档模型会随时间轮换**——当前 id 下线时需手动更新 |
| `freeZen.apiKeyEnv` | `string` | `'OPENCODE_API_KEY'` | 存放 Zen 登录 key 的环境变量；仅当其已设置时 Zen 才加入链 |
| `maxImageBytes` | `number` | `4194304`（4 MiB） | 单图硬性大小限制，调用 Provider 前经 `statSync` 强制执行 |
| `maxImagePixels` | `number` | `20000000`（20 MP） | **仅 schema 层面**：`validateConfig` 在 100 MP 以上告警，但运行时无像素检查（插件不解码图片） |
| `cache` | `boolean` | `true` | 启用描述缓存 |
| `cacheTtlSeconds` | `number` | `3600` | 缓存 TTL |
| `cacheMaxEntries` | `number` | `200` | 缓存容量（真 LRU 淘汰） |
| `timeoutMs` | `number` | `120000` | 单张图片跨整条故障转移链的总预算 |
| `visionTaskTimeoutMs` | `number` | `45000` | 链内单个 Provider 的超时 |
| `language` | `'zh' \| 'en'` | `'zh'` | 查询模板与文本标记的语言 |
| `visionDepth` | `'fast' \| 'standard' \| 'deep'` | `'standard'` | 描述模板的详细程度（影响 `auto` 模式 / `vision_describe` 的提示词） |
| `progressiveTools` | `boolean` | `false` | **仅为声明式**——保持 `false` 使工具面自会话开始即稳定（对话中途扩充工具列表会使长上下文 KV/前缀缓存失效）；尚未挂接任何运行时分支 |

## 安全

- **路径策略**：分段感知白名单——图片文件只能从 DSH 工作区或系统临时目录读取（`/tmp-evil` 不会匹配 `/tmp`）；拒绝符号链接（`lstat`）；任何读取前经 `statSync` 校验大小。
- **SSRF 防护**：所有远程端点先做 DNS 解析 + 私有 / 回环 / 保留 IP 拒绝；所有 fetch 均 `redirect: 'manual'`；本地后端（Ollama、LM Studio）显式豁免。
- **硬读取上限**：无论配置如何，Provider 拒绝读取超过 25 MB 的文件。
- **凭据脱敏**（3 层，应用于所有错误出口）：当前已设置知名密钥（`OPENAI` / `ANTHROPIC` / `GEMINI` / `ZAI`）的精确匹配、token 形态正则（`sk-...`、`Bearer ...`、`api_key=...`）、URL userinfo 掩码。其他 key（如 `OPENCODE_API_KEY`）由形态层覆盖。
- 残余（已接受的）风险：SSRF 检查在 `fetch` 之前解析 DNS，而 `fetch` 会再次解析——经典的 DNS 重绑定 TOCTOU 窗口仍然存在。

## 安装 / 构建 / 测试

要求 Node.js `>= 22.19`。`npm` 与 `pnpm` 均可（脚本为普通 npm 脚本）。

```bash
npm install          # 或：pnpm install
npm run build        # vite build（ESM、node22 目标）+ tsc 声明文件输出 -> dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:watch   # vitest 监视模式
npm run coverage     # vitest run --coverage
npm run lint         # biome check src
npm run format       # biome check --write src
```

可选 peer 依赖（仅在使用相应工具时安装）：

```bash
npm i sharp             # vision_crop、vision_pixel_diff
npm i puppeteer-core    # 未来的 vision_screenshot
```

### 作为库使用

```ts
import { createOmnivisionPlugin, resolveConfig } from 'dsh-omnivision';

const plugin = createOmnivisionPlugin({
  // 传部分配置即可——插件会与 DEFAULT_CONFIG 合并。
  // 需要提前拿到完整生效配置时，可自行调用 resolveConfig()。
  config: resolveConfig({ language: 'zh', freeZen: { model: 'big-pickle' } }),
  workspace: process.cwd(),
  sessionId: 'session-1',
});

const result = await plugin.processMessage(content, attachments, eventId);
if (result.rewritten) sendToDeepSeek(result.newContent);
if (result.hasErrors) surfaceInUi(result.failures);

const toolResult = await plugin.callTool('vision_ground', {
  image: attachments[0],
  target: '登录按钮',
});
```

公开 API（来自 `src/index.ts`）：`OmniVisionPlugin`、`createOmnivisionPlugin`、
`PluginContext`、`ProcessMessageResult`、`AttachmentFailure`、`AttachmentFailureReason`、
`OmniVisionConfig`（类型）、`DEFAULT_CONFIG`、`resolveConfig`、`validateConfig`、
配置类型别名（`VisionMode`、`RoutingMode`、
`ImageAttachment`、`VisionDescription`、`FailureKind`）、`registerTool` / `getTool` /
`listTools` / `toolRegistry`、`ToolContext` / `ToolDefinition` / `ToolResult`（类型）、
`VisionProvider` / `VisionResult` / `VisionFailure`（类型）。

`plugin.stats()` 暴露缓存大小、被封锁的 Provider 和链长度；`plugin.dispose()` 清空缓存与熔断器状态。

## cordis.patch.yml

随包附带的补丁以最小配置挂载插件（为明确起见重申 schema 默认值），并设置 DSH 侧附件接入策略（20 MiB / 100 MP / 10000 px）。注意这是两个不同的层：补丁中 `attachment-local` 的限制约束 DSH 宿主接受用户附件的上限；插件自身的 `maxImageBytes`（默认 4 MiB）约束插件愿意发给视觉 Provider 的上限。介于两层之间的图片保留在 UI 中，但通过 `failures` API 上报而不是被描述。

## 开发状态

已完成（库层面）：

- KV Cache 安全的预处理桥接、三种模式、稳定描述模板
- 工厂化的 Provider 链、免费兜底（OVH / 智谱 / Zen）、Ollama 与 LM Studio
- LRU 缓存、超时、（实例级）持久熔断器、失败分类
- 工具注册表共 9 个工具（7 个已实现，2 个显式占位）
- 路径策略、SSRF 门禁、符号链接拒绝、凭据脱敏
- `tests/` 下的跨平台测试套件（bridge / integration / resilience / security）
- 构建（vite ESM + tsc `.d.ts`）、biome lint、typecheck 全绿

待办 / 未完成：

- **真实 DSH 集成测试**——插件尚未在真实 DeepSeek Harness 运行时中运行；影子历史操作已产出但还没有宿主消费。
- `routing` 与 `progressiveTools` 无运行时效果（声明式占位）。
- `maxImagePixels` 运行时不强制。
- `vision_trace` 与 `vision_screenshot` 为占位。
- Zen 免费档的模型轮换及其免费模型的视觉能力不受本插件控制（故障转移链会吸收拒绝）。

## 许可证

[MIT](LICENSE)
