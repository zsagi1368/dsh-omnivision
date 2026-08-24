# dsh-vision-router 深度架构分析报告

**研究日期**: 2026-08-21  
**版本**: v1.7.3  
**分析目标**: 理解完整架构、路由机制、provider链、free fallback系统，为全新视觉插件开发提供参考

---

## 一、架构概述

### 1.1 项目定位

dsh-vision-router 是 DeepSeek Harness (DSH) 的视觉插件，为纯文本 DSH Agent 提供视觉能力。核心理念：

> **DeepSeek 只负责思考，内置免费视觉链 + 14个深看工具负责"看"；图片轮次就像普通工具调用一样自然、可定位、可验证。**

关键设计哲学：**不是把图片翻译成文字再喂给 DeepSeek，而是让图片轮直接交给视觉模型看原图**（像素保真），同时保留 DeepSeek 作为"大脑"。

### 1.2 技术栈

| 维度 | 选型 |
|------|------|
| 语言 | 纯 JavaScript / Node.js（ESM） |
| 依赖 | `sharp`（图像缩放/处理）、`puppeteer-core`（HTML截图）、`potrace`（SVG矢量化）、`undici`（HTTP）、`@deepseek-ai/schemastery`（配置schema） |
| 无依赖 | 无 Python、无 ML 框架 |
| 引擎要求 | Node.js >=22.19.0 或 >=24.0.0 |
| 代码量 | index.js 7721行 + lib/ 49个模块，总计约 350KB+ |

### 1.3 核心模块层级

```
entry.js (入口 + 多层 wrapper 组装)
    ↓
index.js (核心逻辑: vision_describe/ground/crop/pixel_diff/ocr等14工具)
    ↓
lib/ (49个专业模块，按职责分层)
    ├── mixed-router.js          # 混合内容智能分路（精度优化）
    ├── vision-execution-policy.js  # 执行策略/compatibility bridge
    ├── vision-model-registry.js  # 多源模型注册表
    ├── live-model-discovery.js   # 动态发现provider可用模型
    ├── session-vision-state.js   # 图片记忆/缓存系统
    ├── vision-resilience.js      # 失败分类/熔断/退避
    ├── structured-flow-hardening.js  # 结构化流程防护
    ├── structured-bootstrap.js   # 1+x 流程（预识别+深挖）
    ├── depth-guidance.js         # 深度档位引导（fast/standard/deep）
    ├── adversarial-hardening.js  # 安全边界（HTML截图沙箱）
    ├── local-vision-stabilizer.js  # 本地Ollama/LM Studio路由
    ├── file-logger.js            # 诊断日志系统
    └── ... (其余模块)
```

### 1.4 apply() 函数：多层 Context Wrapper

`entry.js` 的 `apply(ctx, config)` 函数是整个插件的核心组装点，按以下顺序逐层包装 context：

```javascript
// entry.js apply() 的包装顺序（从外到内）：
1. installLocalMutationRouteBoundary(ctx)          // 同源/Fetch安全
2. installVisionRouterFileLogging(localMutationCtx) // 文件日志
3. contextWithDelegatedReplay(logging.ctx)         // 委派式replay
4. contextWithReplayEnvelopeV2Compat(delegatedReplayCtx) // v2兼容
5. installScreenshotSourceBoundary(runtimeCtx)     // 截图源安全
6. installAdversarialHardening(screenshotSourceCtx) // 对抗性加固
7. installOllamaColdStartGuard(hardenedCtx)        // Ollama冷启动防护
8. installLocalVisionStabilizer(ollamaColdStartCtx) // 本地视觉稳定器
9. installVisionAttachmentAdmissionPolicy(stabilizedCtx) // 附件准入策略
10. installVisionRouterRemoteSettingsBridge(stabilizedCtx) // 远程设置桥
11. installSettingsRc8ClientLifecycle(stabilizedCtx) // rc.8生命周期
12. protectHostProviderOwnership(settingsCtx)       // 保护宿主provider所有权
13. installHostSettingsCompatibility(ownershipCtx)  // 宿主设置兼容
14. attachmentContextForContract(settingsCtx)       // 附件兼容
15. installVisionToolRuntimeBoundary(attachmentCompatCtx) // 工具运行时边界
16. installStructuredFlowHardening(toolRuntimeCtx)  // 结构化流程防护
17. contextWithCoalescedAdapterUpdates(structuredCtx) // 合并adapter更新
18. installLiveModelDiscovery(reconciledCtx)        // 动态模型发现
19. installVisionModelRegistry(reconciledCtx, liveDiscovery) // 模型注册表
20. installClientPresentationBoundary(reconciledCtx) // 客户端展示边界
21. installLiveModelClientPrelude(reconciledCtx)    // 模型客户端预装
22. contextWithVisionExecutionPolicy(reconciledCtx) // 执行策略
23. installTesseractExecFileCompat(executionCtx)    // Tesseract兼容
```

**最后**调用 `core.apply(executionCtx, runtimeConfig)` 完成最终注册。

---

## 二、路由机制

### 2.1 两种路由模式

插件支持两种路由模式，通过 `config.routing` 和 `config.reverseRouting` 控制：

#### 模式A：工具模式（默认，`routing: false`）
- **图片留在视觉模型侧，推理留在 DeepSeek 侧**
- 图片轮中的图片被改写为 text marker（`[attached image: <id>]`），DeepSeek 继续用纯文本模型处理
- 模型通过调用 `vision_describe` / `vision_ground` / `vision_crop` 等工具按需看图
- **优点**：图片不污染 KV cache，DeepSeek 上下文完全保留
- **缺点**：需要模型主动调用工具

#### 模式B：整轮路由（`routing: true`）
- **图片轮整轮切换到视觉模型**
- 包含图片的消息直接被发送到 vision model
- 类似传统"切模型"方案，但自动触发
- **优点**：零工具调用开销
- **缺点**：改变请求前缀可能让长会话的 provider prefix/KV cache 整体失效

#### 推荐模式：反向路由（`reverseRouting: true`，默认）
- 保持官方 DeepSeek 路由原样
- 额外注册一个 `deepseek-vision`（可通过 `wrapperRoute` 配置）包装路由
- 用户在模型选择器选择 `"+ 自动识图"` 后缀的模型组
- 这个模式保持了向后兼容性，同时提供视觉能力

### 2.2 附件/图片写入与标记

```javascript
// index.js: rewriteImageBlocks() - 将图片块改写为文本标记
export function rewriteImageBlocks(messages) {
  // 递归遍历 content，将所有 image block 替换为 text marker
  // 示例：[attached image: sha256:abc123] The current model cannot see images...
  // 同时收集所有 attachment refs
}

// toolImageMarker() - 工具产生的图片标记
// "[tool result produced image \"name\", attachment id \"id\".
//  The image was kept out of the text-model request to prevent session corruption..."
```

**关键设计**：工具生成的图片（如 `read_image`）会被替换为 text marker，防止 text-only adapter 拒绝嵌套图片。但用户手动上传的图片保留原样。

### 2.3 shadow 事件机制（session 级图片隔离）

```javascript
// planToolResultImageShadows() - 在事件日志层面创建 shadow replacement
// 当 session surface 上的 tool/result 事件包含图片时：
// 1. 人类可见的 transcript 保留原始图片
// 2. deriveMessages() 投影时使用 sanitized replacement（文字标记）
// 3. 这样后续的 text-model 请求不会看到这些图片
```

这是 DSH 原生支持的机制（`surfaceOp: {op:'replace'}`），插件利用这个特性实现图片隔离。

---

## 三、Provider 链与 Free Fallback 系统

### 3.1 提供商优先级链

```javascript
// index.js: providersOf() - 解析 provider 链
export function providersOf(config = {}) {
  // 1. 如果有 multi-provider 数组，按序展开
  // 2. 否则使用单 provider + fallbacks
  // 3. 默认兜底: vision-http / ovh/Qwen3.5-397B-A17B
}
```

**完整 provider 优先级**（从先到后）：

1. **`vision-http` + 用户配置**（`config.providers[]`）
   - 用户自定义的 provider/model 组合
   - 支持多个 provider，每个可配置多个 fallback models

2. **本地 Ollama**（`config.localOllama.enabled === true`）
   - baseURL: `http://127.0.0.1:11434/v1`（默认）
   - 格式：`openai`（/chat/completions）或 `anthropic`（/messages）
   - 无需 API Key

3. **本地 LM Studio**（`config.localLmStudio.enabled === true`）
   - baseURL: `http://localhost:1234/v1`（默认）
   - 同 Ollama，自动跳过未运行的后端

4. **httpProviders**（`config.httpProviders[]`）
   - 用户自定义的外部 HTTP 端点
   - 支持 OpenAI 和 Anthropic 格式

5. **内置免费 OVHcloud**（`config.freeFallback === true`，默认开启）
   - 端点：`https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`
   - 模型：`Qwen2.5-VL-72B-Instruct`（免费匿名）
   - 限制：2 req/min/IP/model

### 3.2 免费 Vision Chain 设计

#### 内置免费端点（OVHcloud）

```yaml
# presets/ovh.yaml
llm-pi-ai:
  providers:
    ovh:
      api: openai-completions
      baseURL: https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
      models:
        - id: Qwen2.5-VL-72B-Instruct
          name: "OVHcloud: Qwen2.5-VL-72B-Instruct (免费匿名)"
          contextWindow: 128000
          maxTokens: 8192
          input: [text, image]
```

#### 其他免费渠道预设

| Provider | Preset 文件 | 特点 |
|----------|-------------|------|
| **Zhipu (智谱)** | `zhipu.yaml` | `glm-4.6v-flash` 永久免费，`ZAI_API_KEY` |
| **DashScope (百炼)** | `dashscope.yaml` | 大陆直连，新用户 100万 token/90天 |
| **SiliconFlow (硅基流动)** | `siliconflow.yaml` | ¥14 赠金覆盖 Qwen2.5-VL |
| **OpenRouter** | `openrouter.yaml` | 免费模型（50次/天，名单轮换） |

#### freeCloudFirst 选项

```javascript
// index.js Config
freeCloudFirst: z.boolean().default(false)
```

开启后，云端后端先尝试内置 OVH 免费模型（免注册、免 Key），付费 httpProviders 仅在免费模型全部失败后作为兜底。

### 3.3 降级链逻辑

```javascript
// index.js 核心降级流程
async function callProviderChain(providerChain, messages, options) {
  let lastError
  
  for (const { provider, model } of providerChain) {
    try {
      // 1. 检查 circuit breaker（熔断器）
      const circuitCheck = circuitBreaker.inspect(key, fingerprint, scope)
      if (circuitCheck.blocked) continue  // 跳过被熔断的后端
      
      // 2. 检查 turn budget（时间预算）
      if (budget.expired()) {
        return buildVisionFailure('VISION_TURN_BUDGET_EXCEEDED', ...)
      }
      
      // 3. 调用后端
      const result = await callVisionBackend(provider, model, messages, {
        signal: combineSignals(options.signal, deadline.signal()),
        timeoutMs: Math.min(options.timeoutMs, budget.remaining()),
      })
      
      // 4. 成功 → 返回结果
      return result
      
    } catch (error) {
      // 5. 分类失败
      const classification = classifyVisionFailure(error)
      
      // 6. 记录到 circuit breaker
      circuitBreaker.record(key, fingerprint, classification, scope)
      
      // 7. 只有可重试类型才继续降级
      if (!classification.retryableProvider) break
      
      lastError = error
    }
  }
  
  // 8. 全部失败 → 返回结构化错误
  return buildVisionFailure({
    code: resultCodeForKinds(failedKinds),
    retryable: false,
    reason: 'All vision backends failed',
    attempted: [...providerChain],
  })
}
```

---

## 四、失败分类与熔断系统

### 4.1 失败分类体系

```javascript
// lib/vision-resilience.js
export const VISION_FAILURE_KINDS = {
  AUTH: 'AUTH',              // 401/403/未授权
  RATE_LIMIT: 'RATE_LIMIT',  // 429/限流
  TIMEOUT: 'TIMEOUT',        // 超时/中止
  SERVER: 'SERVER',          // 5xx 服务器错误
  INVALID_REQUEST: 'INVALID_REQUEST',  // 400/404/422
  NETWORK: 'NETWORK',        // 连接错误/DNS失败
  QUOTA: 'QUOTA',            // 402/额度不足
  REGION: 'REGION',          // 地区限制
  TOS: 'TOS',                // 服务条款拒绝
  NO_ADAPTER: 'NO_ADAPTER',  // 未注册 adapter
  REPETITION: 'REPETITION',  // 重复循环
  OTHER: 'OTHER',            // 其他
}
```

### 4.2 熔断器设计

```javascript
// lib/vision-resilience.js: createVisionCircuitBreaker()
export function createVisionCircuitBreaker({
  authTripTtlMs = 10 * 60 * 1000,      // AUTH 故障持续 10 分钟
  defaultRateCooldownMs = 60 * 1000,    // RATE_LIMIT 冷却 1 分钟
  maxBackends = 128,                    // 最多记录 128 个后端
}) {
  // AUTH/REGION/TOS → 直到 credential fingerprint 变化或 TTL 过期
  // RATE_LIMIT/QUOTA → Retry-After 感知的冷却期
  // INVALID_REQUEST/NO_ADAPTER → 直到 turn 结束
}
```

### 4.3 Turn 级失败记忆

```javascript
// lib/vision-resilience.js: createVisionTurnMemory()
export function createVisionTurnMemory({
  maxScopes = 64,           // 最多记录 64 个 turn scope
  maxSessions = 64,
  maxAttemptsPerScope = 64,
}) {
  // 每个 turn 记录失败的 backend 和 kind
  // 一旦所有 backend 都失败，后续调用直接返回 VISION_BACKEND_UNAVAILABLE_THIS_TURN
  // 不需要再尝试网络请求
}
```

### 4.4 结构化失败结果

```javascript
// lib/vision-resilience.js: buildVisionFailure()
export function buildVisionFailure({
  code,              // 'VISION_AUTH_FAILED' / 'VISION_RATE_LIMITED' / 'VISION_TIMEOUT' / 'VISION_BACKEND_UNAVAILABLE'
  retryable = false, // false 表示模型不应重试
  reason,
  attempted = [],    // 已尝试的 provider/model 列表
  advice,
}) {
  return { ok: false, code, retryable, reason, attemptedProviders: attempted, advice }
}
```

**关键指令**：`VISION_DO_NOT_RETRY_ADVICE` 告诉模型不要因 auth/rate-limit 失败而重复调用 vision 工具。

---

## 五、14 个 Deep Tools 设计

### 5.1 工具列表与职责

| 工具 | 功能 | 是否需要 sharp |
|------|------|----------------|
| `vision_describe` | 图片描述/Q&A | 否（可选缩放） |
| `vision_ground` | 元素定位（返回坐标） | 否 |
| `vision_crop` | 裁剪图片区域 | 是 |
| `vision_pixel_diff` | 像素级对比（两图） | 是 |
| `vision_colors` | 提取主色调 | 是 |
| `vision_ocr` | 文本识别（Tesseract） | 否 |
| `vision_long_screenshot_ocr` | 长截图 OCR（分 tile） | 是 |
| `vision_html_screenshot` | HTML 转截图（Puppeteer） | 否 |
| `vision_present` | 发布图片到会话 | 否 |
| `vision_read` | 读取图片文件 | 否 |
| `vision_trace` | SVG 矢量化（potrace） | 是 |
| `vision_cutout` | 前景提取（segmenation） | 是 |
| `vision_detect` | 检测 UI 元素 | 否 |
| `vision_bootstrap` | 结构化预识别（1+x 流程） | 否 |

### 5.2 vision_describe 核心实现

```javascript
// index.js vision_describe 关键逻辑
async function visionDescribe(args, exec) {
  // 1. 解析图片源（本地文件 / attachmentId）
  const images = await resolveImages(args.paths, args.attachmentIds, exec)
  
  // 2. 按 content hash 查找缓存
  const cacheKey = createHash('sha256')
    .update(imageBytes)
    .update(question || '')
    .digest('hex')
  
  if (config.cache && cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }
  
  // 3. 超大图片 downscale（sharp）
  if (config.downscale && bytes.length > config.downscaleMaxPixels) {
    bytes = await sharp(bytes).resize(...).png().toBuffer()
  }
  
  // 4. 构建 OpenAI/Anthropic 兼容请求
  const messages = buildVisionMessages(images, question, jsonMode)
  
  // 5. 沿 provider 链调用
  const result = await callProviderChain(providerChain, messages, {
    signal: exec.signal,
    timeoutMs: config.visionTaskTimeoutMs,
  })
  
  // 6. 缓存结果
  if (config.cache) cache.set(cacheKey, result)
  
  return result
}
```

### 5.3 vision_pixel_diff 流式实现

```javascript
// lib/pixel-diff-stream.js
export async function compareRgbaStreams(streamA, streamB, {
  width, height, threshold = 16, cols = 8, rows = 8
} = {}) {
  // 流式处理：不加载完整帧到内存
  // 1. 创建 AsyncByteReader 包装两个 RGBA 流
  // 2. 逐块读取 4 字节（一个 RGBA 像素）
  // 3. 计算 R/G/B 最大差值，超过 threshold 即为不同
  // 4. 8x8 网格统计差异比例
  // 5. 返回 { differing, total, ratio, cells: [...] }
}
```

**设计亮点**：
- 流式处理，避免大图片内存爆炸
- 网格化统计，定位差异区域
- 输入校验：声明尺寸与实际字节数必须一致

### 5.4 vision_html_screenshot 安全沙箱

```javascript
// lib/adversarial-hardening.js
export function createSecureHtmlScreenshotExecute(ctx, core, config, deps = {}) {
  return async (args, exec) => {
    // 1. 仅允许 .html/.htm 文件
    // 2. 必须在 session workspace 内
    // 3. 使用 Puppeteer + setOfflineMode(true) 离线渲染
    // 4. 请求拦截：只允许 file:// 同源请求
    // 5. 完整页面高度有上限（50M 像素）
    // 6. 并发控制：最多 2 个并行截图
    // 7. 输出到 artifact 目录（带 run ID 隔离）
  }
}
```

---

## 六、1+x 结构化流程（Bootstrap + 深挖）

### 6.1 核心思想

```javascript
// lib/structured-flow-hardening.js
// 结构化 1+x 流程：每张图片先做 bootstrap 预识别，再做 x 次深挖
// fast = 1次深挖, standard = 2次, deep = 4次
```

### 6.2 Bootstrap 提示词设计

```javascript
// lib/structured-bootstrap.js
export function structuredBootstrapQuestion() {
  return `This is pass 1 of a required 1+x vision workflow.
Build a task-independent visual map of the image itself;
do not accept, invent, or optimize for a user/task goal in this pass.
Inspect the image directly.

Return ONE valid JSON object:
{
  "visual_kind": "chat|document|ui|code|general|mixed|unknown",
  "content_kind": "person|animal|plant|food|vehicle|machine|architecture|object|scene|meme|unknown",
  "mixed_of": [],
  "overview": "<concise factual overview>",
  "regions": [{"id": "r1", "location": "...", "role": "...", "content": "..."}],
  "visible_text": [{"region_id": "r1", "text": "...", "uncertain": false}],
  "entities": [{"id": "e1", "type": "button|input|...", "label": "...", "region_id": "r1"}],
  "relationships": [{"from": "e1", "relation": "...", "to": "e2"}],
  "uncertainties": [{"region_id": "r1", "detail": "..."}],
  "recommended_followups": [{"tool": "vision_describe|...", "target": "...", "reason": "..."}]
}`
}
```

**设计要点**：
- bootstrap 结果存入 session memory（`SessionMemoryView`）
- 深挖阶段的引导文案来自 bootstrap 结果中的 `recommended_followups`
- OCR 只在确实需要逐字保真时才推荐（可执行代码、合同、表格数字等）

### 6.3 混合内容分路（Mixed Router）

```javascript
// lib/mixed-router.js
export const MAX_MIXED_BRANCHES = 2

const BRANCH_GUIDANCE = new Map([
  ['document:code', '逐字转写（代码可执行性例外）'],
  ['document:form', '语义优先，逐字字段名/值确需引用时用 OCR'],
  ['document:table', '结构提取优先，数字/金额逐字'],
  ['document:', '语义优先；仅当需要逐字引用时才用 OCR'],
  ['ui:', 'detect / ground 优先（元素清单与像素定位）'],
  ['code:', '逐字转写（可执行性例外）'],
  ['table:', '结构提取优先，数字/金额逐字'],
  ['_default', '放行（模型自由选择识别方式）'],
])

const KIND_PRIORITY = ['ui', 'document', 'code', 'table', 'chat', 'general']
```

**工作流程**：
1. bootstrap 识别出 `visual_kind: mixed`
2. 按 `KIND_PRIORITY` 排序，最多取 2 个分支
3. 每个分支注入对应的 `guidance` 引导文案
4. 模型按分支逐个验证，不混用识别方式

---

## 七、Image Memory / 缓存系统

### 7.1 Session Vision State Store

```javascript
// lib/session-vision-state.js
export function createSessionVisionStateStore(config = {}) {
  // 按 session 存储图片描述和 attachment 引用
  // 使用 WeightedLruMap 实现带权重的 LRU 淘汰
  return {
    setDescription(session, attachmentId, description),  // 缓存图片描述
    getDescription(session, attachmentId),               // 读取缓存
    recordAttachments(session, refs),                    // 记录 attachment
    lookupAttachment(session, attachmentId),             // 查找 attachment
    forgetSession(session),                              // 清理 session
    stats(),                                             // 统计信息
  }
}
```

**关键特性**：
- `descriptionMaxEntries: 64`，`descriptionMaxChars: 256KB`
- `attachmentMaxEntries: 256`
- `idleTtlMs: 3600000`（1小时 idle 后清理）
- 支持 stable（按 session.id）和 weak（按 session 对象）两种存储

### 7.2 vision_describe 缓存

```javascript
// index.js vision_describe 中的缓存逻辑
if (config.cache) {
  const cacheKey = createHash('sha256')
    .update(imageBytes)
    .update(question || '')
    .update(jsonMode ? 'json' : 'plain')
    .digest('hex')
  
  if (visionStateStore.hasDescription(session, cacheKey)) {
    return visionStateStore.getDescription(session, cacheKey)
  }
  
  // ... 执行推理 ...
  
  // 存入缓存
  visionStateStore.setDescription(session, cacheKey, result)
}
```

---

## 八、Live Model Discovery（动态模型发现）

### 8.1 发现流程

```javascript
// lib/live-model-discovery.js
export function createLiveModelDiscoveryManager(ctx, options = {}) {
  // 1. 从 llm-pi-ai providers 收集所有配置的 provider
  // 2. 并发（默认 3 个）调用各 provider 的 /models 端点
  // 3. 结果缓存到 $DSH_HOME/cache/vision-router/live-models.json
  // 4. 刷新策略：fresh 15分钟内有效，stale 24小时内可用
  // 5. 失败退避：30秒后重试
}
```

### 8.2 缓存结构

```json
{
  "version": 1,
  "providers": [
    {
      "provider": "openrouter",
      "fingerprint": "sha256之...的前24位",
      "discoveredAt": 1692600000000,
      "models": [
        {"id": "qwen2.5-vl-72b-instruct", "name": "Qwen2.5-VL-72B"},
        {"id": "glm-4.6v-flash", "name": "GLM-4.6V-Flash"}
      ],
      "evidenceGeneration": 5,
      "routeMismatch": false
    }
  ]
}
```

### 8.3 Trusted Vision Hints（可信视觉提示）

```javascript
// lib/trusted-vision-hints.js
// 智谱 bigmodel.cn 的视觉模型可能不在 OpenAI /models 列表中
// 但插件知道它们是视觉模型，所以加入 trusted hints
export const TRUSTED_VISION_HINTS = Object.freeze({
  bigmodel: Object.freeze({
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4.6v', name: 'GLM-4.6V' },
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash' },
      { id: 'glm-4.1v-thinking-flash', name: 'GLM-4.1V-Thinking-Flash' },
      { id: 'glm-4v-flash', name: 'GLM-4V-Flash' },
    ],
  }),
})
```

---

## 九、Vision Model Registry（多源模型注册表）

```javascript
// lib/vision-model-registry.js
export function installVisionModelRegistry(ctx, liveDiscovery, options = {}) {
  // 整合四个来源的模型：
  // 1. DSH adapter catalog (llm.models) — 权威来源
  // 2. Provider live /models listing — 端点证据
  // 3. Trusted vision hints — 兼容性提示
  // 4. Saved settings — 用户配置
  
  // decorateVisionModelSnapshot() 将四个来源合并
  // 每个模型带 source 标签：'live' | 'known' | 'configured'
}
```

**模型来源优先级**：
```javascript
export const VISION_MODEL_REGISTRY_REVISION = 2
// sources: ['dsh-catalog', 'provider-live', 'trusted-vision-hints', 'saved-compat']
```

---

## 十、DSH 集成（cordis.patch.yml）

### 10.1 Bundle Patch

```yaml
# cordis.patch.yml
# 1. 插入 vision-router 配置行
- insert:
    - id: vision-router
      name: dsh-vision-router
      config:
        progressiveTools: false

# 2. 覆盖 attachment-local 配置
- id: attachment-local
  config:
    maxImageBytes: 20971520       # 20 MiB
    maxImagePixels: 100000000     # 1 亿像素
    maxImageDimension: 10000      # 最长边 10000px
```

### 10.2 Package.json 声明

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-api-remotes"
      ]
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

### 10.3 安装命令

```bash
# 一条命令完成插件安装和配置
dsh plugin add dsh-vision-router
# 或
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
```

安装后：
- 自动加载 bundle patch
- 注册 14 个 vision tools
- 为现有 provider 创建 `+ 自动识图` 别名
- 写入 `settings.yaml` 的 vision-router 配置段

---

## 十一、HTTP 兼容性层

### 11.1 OpenAI Compatible 适配

```javascript
// lib/http-compat.js
export async function fetchWithOpenAICompatibility(fetchImpl, input, init, context = {}) {
  // Layer 1: 通用 OpenAI completions 请求
  // Layer 2: 已知 model-family presets（如 GLM-4V-Flash 的 max_tokens 限制）
  // Layer 3: 错误驱动的兼容性重试（最多 2 次）
  //   - max_tokens 超限 → 自动缩减
  //   - max_completion_tokens 提示 → 参数迁移
}
```

### 11.2 Anthropic Messages 适配

```javascript
// lib/catalog-corrections.js
export async function callAnthropicCompatible(provider, messages, options = {}) {
  // 将 harness messages 转换为 Anthropic wire 格式
  // 处理 system prompt、tool_use/tool_result 块
  // 支持 base64 图片编码
}
```

### 11.3 Catalog Routing Corrections（目录路由修正）

```javascript
// lib/catalog-corrections.js
export const CATALOG_ROUTING_CORRECTIONS = [
  {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
    // 实际应走 Anthropic Messages，但 catalog 标记为 openai-completions
    api: 'anthropic-messages',
    baseURL: 'https://opencode.ai/zen/go',
    wrongApi: 'openai-completions',
    wrongBaseURLPrefix: 'opencode.ai/zen/go',
  },
  // ... 更多修正
]
```

---

## 十二、安全设计

### 12.1 对抗性加固（Adversarial Hardening）

```javascript
// lib/adversarial-hardening.js
export function installAdversarialHardening(ctx, config = {}, core) {
  // 1. HTML 截图沙箱：
  //    - 仅允许 file:// 协议
  //    - 必须在 session workspace 内
  //    - 启用 offline mode
  //    - 并发上限 2
  // 2. 全局 fetch 包装：插件卸载时恢复原始 fetch
  // 3. Artifact 路径安全检查
}
```

### 12.2 图片资源治理

```javascript
// lib/image-resource-governor.js
export class ImageResourceGovernor {
  // 控制并发图片操作，防止内存爆炸
  // maxBytes: 256 MiB
  // maxConcurrent: 2
  // exclusive: 独占模式（超大图片时）
}
```

### 12.3 重复循环检测

```javascript
// lib/repetition-guard.js
export function detectRepetitionLoop(text, options = {}) {
  // 检测 AI 输出中的重复循环
  // Pass 0: 精确周期匹配
  // Pass 1: 连续运行匹配
  // Pass 2: 短 token 密度检测
  // 发现循环 → 抛出 REPETITION 错误
}
```

---

## 十三、诊断与日志系统

### 13.1 文件日志

```javascript
// lib/file-logger.js
export function installVisionRouterFileLogging(ctx, options = {}) {
  // 日志路径: $DSH_HOME/logs/vision-router/vision-router.log
  // 旋转策略: 2 MB 单文件，最多保留 1 个 backup
  // 背压控制: 512 KB 待写 / 2048 条待写
  // 敏感信息脱敏: Bearer token, sk- 前缀 key, URL 中的 key
}
```

### 13.2 Doctor 诊断 CLI

```javascript
// lib/doctor-cli.js
// 命令: dsh-vision-router doctor
// 检查项：
// 1. Node.js 版本
// 2. sharp 安装状态
// 3. Tesseract 可用性
// 4. Chrome/Chromium 可用性
// 5. Profile 配置完整性
// 6. 冲突插件检测
```

---

## 十四、配置项总览

```javascript
// index.js Config schema（精简版）
export const Config = z.object({
  // 路由
  provider: z.string().default('vision-http'),
  model: z.string().default('ovh/Qwen3.5-397B-A17B'),
  fallbacks: z.array(z.string()).default([]),
  providers: z.array(z.object({ provider, model, fallbacks })).default([{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' }]),
  routing: z.boolean().default(false),
  reverseRouting: z.boolean().default(true),
  wrapperRoute: z.string().default('deepseek-vision'),
  
  // 视觉流程
  structuredVisionBootstrap: z.boolean().default(false),
  visionDepth: z.union(['fast', 'standard', 'deep']).default('standard'),
  visionDepthMaxCalls: z.number().default(0),
  guidanceOverrides: z.array(z.object({ kind, text })).default([]),
  
  // 本地后端
  localOllama: z.object({ enabled, baseURL, model, format, temperature, top_p }).default({}),
  localLmStudio: z.object({ enabled, baseURL, model, format, temperature, top_p }).default({}),
  
  // 外部 HTTP 端点
  httpProviders: z.array(z.object({ name, baseURL, model, apiKeyEnv, maxTokens })).default([]),
  
  // 免费兜底
  freeFallback: z.boolean().default(true),
  freeCloudFirst: z.boolean().default(false),
  
  // 图片处理
  downscale: z.boolean().default(true),
  downscaleMaxPixels: z.number().default(4000000),
  cache: z.boolean().default(true),
  cacheTtlSeconds: z.number().default(3600),
  cacheMaxEntries: z.number().default(200),
  
  // 超时
  timeoutMs: z.number().default(120000),
  visionTaskTimeoutMs: z.number().default(45000),
  ocrTimeoutMs: z.number().default(30000),
  visionTurnBudgetMs: z.number().default(90000),
  
  // 其他
  desktopScreenshot: z.boolean().default(false),
  artifactsDir: z.string().default('.dsh-vision-router/artifacts'),
  catalogCorrections: z.boolean().default(true),
  autoWrapProviders: z.boolean().default(true),
  wrappedProviders: z.array(z.object({ provider, models })).default([{ provider: 'deepseek-official', models: [] }]),
})
```

---

## 十五、架构优势分析

### 15.1 核心优势

| 维度 | 优势 |
|------|------|
| **像素保真** | 图片轮直接走视觉模型，不经过"图片→文字"转换 |
| **工具化** | 14 个 vision tools 让图片查看变成普通工具调用 |
| **免费开箱** | 内置 OVHcloud 免费端点，零配置可用 |
| **降级链** | 多 provider fallback + 本地 Ollama/LM Studio |
| **结构化流程** | 1+x bootstrap 模式提升复杂图片识别精度 |
| **无 Python** | 纯 JS/Node.js 依赖，部署简单 |
| **诊断完善** | Doctor CLI + 文件日志 + 失败分类 |
| **安全设计** | HTML 沙箱 + 路径安全 + 资源治理 |

### 15.2 设计亮点

1. **AsyncLocalStorage 用于 turn budget 传播**
   - `turn-budget-context.js` 使用 `AsyncLocalStorage` 在异步调用链中传递时间预算
   - 嵌套调用自动继承父 budget（取最小值）

2. **Proxy-based context wrapping**
   - 大量使用 `new Proxy(ctx, { get: ... })` 包装 context
   - 保持原始 context 不变，只拦截特定属性

3. **WeakMap 用于生命周期管理**
   - `wrappedContexts`、`wrappedDefinitions` 等使用 WeakMap
   - 避免内存泄漏，支持 GC

4. **Error classification taxonomy**
   - 统一的失败分类体系，便于下游决策

5. **Fingerprint-based 缓存键**
   - `routeFingerprint()` 使用 SHA-256 生成路由指纹
   - 凭证变化自动失效缓存

---

## 十六、可用于新插件的设计模式

### 16.1 推荐模式

| 模式 | 用途 | 参考模块 |
|------|------|----------|
| **多层 Context Wrapper** | 插件初始化时的能力叠加 | `entry.js` apply() |
| **AsyncLocalStorage** | 跨异步调用的上下文传递 | `turn-budget-context.js` |
| **Proxy-based 属性拦截** | 透明地包装对象行为 | `vision-execution-policy.js` |
| **WeakMap 生命周期管理** | 关联对象而不阻止 GC | 多处使用 |
| **结构化失败分类** | 统一的错误处理体系 | `vision-resilience.js` |
| **Provider 降级链** | 多后端容错 | `index.js` callProviderChain() |
| **Circuit Breaker** | 防止故障后端反复调用 | `vision-resilience.js` |
| **Turn-level Budget** | 单次任务时间上限 | `turn-budget-context.js` |
| **LruMap with Weight** | 内存有限的缓存 | `session-vision-state.js` |
| **Stream-based 处理** | 大图片流式处理 | `pixel-diff-stream.js` |
| **Shadow Event 机制** | 修改 session 表面不影响历史 | `planToolResultImageShadows()` |
| **Dynamic Model Discovery** | 运行时发现可用模型 | `live-model-discovery.js` |
| **Structured Bootstrap** | 1+x 分阶段识别流程 | `structured-bootstrap.js` |
| **Mixed Content Router** | 混合内容智能分路 | `mixed-router.js` |
| **Health Check / Doctor** | 插件健康诊断 | `doctor.js` / `doctor-cli.js` |
| **File Logging with Rotation** | 持久化诊断日志 | `file-logger.js` |

### 16.2 反模式（应避免）

| 反模式 | 原因 |
|--------|------|
| **同步阻塞调用** | DSH 是异步架构，同步操作会阻塞事件循环 |
| **全局状态污染** | 应使用 AsyncLocalStorage 而非全局变量 |
| **直接修改传入对象** | 应返回新对象或使用 Proxy |
| **忽略 AbortSignal** | 必须响应取消信号 |
| **硬编码模型 ID** | 应通过 discovery 或配置获取 |
| **无失败分类** | 应使用统一的 FAILURE_KINDS 体系 |
| **不限制并发** | 大图处理应使用 Governor 模式 |
| **不安全的路径拼接** | 必须校验路径 containment |

---

## 十七、代码质量评价

### 17.1 优点

| 维度 | 评价 |
|------|------|
| **模块化** | 49 个 lib 模块，职责清晰，单一职责原则好 |
| **测试覆盖** | 70+ 测试文件，覆盖率较高 |
| **错误处理** | 统一的失败分类和熔断机制 |
| **安全性** | 路径安全、沙箱、资源治理等多层防护 |
| **文档** | README.zh.md 详尽，包含工作原理说明 |
| **向后兼容** | 支持 rc.6/rc.7/rc.8 多版本 DSH |
| **配置 schema** | 使用 schemastery 定义完整配置类型 |

### 17.2 待改进点

| 问题 | 建议 |
|------|------|
| index.js 过大（350KB+） | 考虑拆分为多个子模块 |
| 注释以中文为主 | 增加英文注释提升国际化 |
| 部分模块耦合度高 | 进一步解耦 lib/ 模块依赖 |
| 无 E2E 测试 | 补充端到端集成测试 |
| 文档版本滞后 | 定期更新 CHANGELOG |

---

## 十八、总结

dsh-vision-router 是一个**工业级、生产就绪**的 DSH 视觉插件，其核心价值在于：

1. **像素保真的视觉路由**：图片轮直接交给视觉模型，不经过有损的文字转换
2. **完善的降级链**：云端免费 → 付费 provider → 本地 Ollama/LM Studio → OVH 免费兜底
3. **结构化识别流程**：1+x bootstrap 模式提升复杂图片的理解精度
4. **健壮的错误处理**：11 类失败分类 + 熔断器 + turn 级失败记忆
5. **安全设计**：多层边界防护，HTML 沙箱、路径安全、资源治理
6. **开箱即用**：内置免费端点，零配置即可体验视觉能力

**对新插件开发的启示**：
- 采用类似的 **context wrapper 链**模式组织插件初始化
- 复用 **AsyncLocalStorage** 实现 turn-level 预算管理
- 学习 **failure classification taxonomy** 设计统一的错误处理体系
- 参考 **circuit breaker** 模式防止故障扩散
- 借鉴 **streaming 处理**大图片的策略
- 使用 **shadow event** 机制实现 session 表面的安全修改

---

**报告完成时间**: 2026-08-21  
**分析版本**: dsh-vision-router v1.7.3  
**仓库路径**: `/home/z/vision-research/repos/dsh-vision-router`
