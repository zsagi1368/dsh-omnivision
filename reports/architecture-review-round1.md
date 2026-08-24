# dsh-omnivision KV Cache 安全架构审查报告

**审查版本**: Round 1  
**审查日期**: 2026-08-21  
**审查范围**: 核心架构安全验证  

---

## 执行摘要

dsh-omnivision 采用 **Vision Pre-Step Bridge 架构**，核心创新在于将所有图像处理操作前置到 DeepSeek 请求发送之前，理论上可保证 KV Cache 完全不受图片数据污染。本报告对架构的安全性、正确性、边界条件进行系统性审查。

**总体评级**: ✅ **架构设计正确，存在若干需要修复的实现缺陷**

| 审查维度 | 评级 | 说明 |
|---------|------|------|
| KV Cache 安全性 | ⚠️ 部分满足 | 架构正确，但存在硬编码 event ID 和 mode 未传入问题 |
| Shadow History 机制 | ⚠️ 部分满足 | 抽象设计合理，但实际未接入 DSH 框架 |
| 三种模式实现 | ⚠️ 部分满足 | manual 模式正确，auto/interactive 存在配置问题 |
| 消息改写逻辑 | ✅ 正确 | 逻辑清晰，边界处理良好 |
| 缓存 Key 稳定性 | ⚠️ 部分满足 | 设计稳定但缺少会话隔离 |
| 异常处理安全性 | ✅ 通过 | 失败降级机制完善 |

---

## 一、KV Cache 安全性验证

### 1.1 核心机制分析

架构设计遵循以下原则：
```
用户输入 → VisionBridge 处理(图片→文本) → 纯文本请求 → DeepSeek
                                    ↓
                              原始图片保留在 UI 层
```

**关键安全断言**：
1. `VisionBridge.processImages()` 在发送请求前完成图片处理
2. `rewriteMessage()` 生成的 `RewrittenMessage` 不包含 `attachments` 字段
3. `removeImageAttachments()` 返回的对象仅包含 `role` 和 `content`

### 1.2 代码验证

**vision-bridge.ts (L79-84)**
```typescript
private createCacheKey(image: ImageAttachment, query: string): string {
  return createHash('sha256')
    .update(image.contentHash)
    .update(query || '')
    .digest('hex')
    .slice(0, 16);
}
```
✅ 缓存 key 基于 contentHash + query，不含图片二进制数据

**message-rewriter.ts (L6-10)**
```typescript
export interface RewrittenMessage {
  role: string;
  content: string;
  attachments?: never; // Always empty after rewriting
}
```
✅ TypeScript 类型系统强制 `attachments` 不可存在

**shadow-history.ts (L59-68)**
```typescript
export function removeImageAttachments(message: {...}): { content: string; role: string } {
  return {
    role: message.role,
    content: message.content,
  };
}
```
✅ 纯函数返回，不保留原始附件

### 1.3 ⚠️ 发现的问题

#### 问题 1-1: hardcode event ID

**文件**: `src/bridge/mode-strategy.ts:56`

```typescript
const shadows = createShadowReplacements('original-event-id', images, descriptions.map(d => d.summary));
```

**影响**: Shadow History 机制中的 `surfaceOp` 和 `modelOp` 使用固定字符串 `'original-event-id'`，这会导致：
- 无法正确关联原始消息事件
- DSH 框架无法执行实际的 shadow replacement
- 架构上存在断链风险

**严重程度**: 🔴 高 - 影响 Shadow History 核心功能

**修复建议**:
```typescript
// 需要从外部传入 originalEventId
const shadows = createShadowReplacements(
  originalEventId,  // 应作为参数传入
  images, 
  descriptions.map(d => d.summary)
);
```

#### 问题 1-2: mode 参数未传递到 Bridge

**文件**: `src/plugin/index.ts:27`

```typescript
this.bridge = new VisionBridge(this.providers, ctx.config.mode);
```

**分析**: `VisionBridge` 构造函数接受 `mode` 参数，但 `processImages()` 方法内部并未使用该参数：

**文件**: `src/bridge/vision-bridge.ts:38-60`
```typescript
async processImages(
  images: ImageAttachment[],
  query: string,
  signal?: AbortSignal,
): Promise<VisionDescription[]> {
  // mode 参数未被使用！
}
```

**影响**: 三种模式（auto/interactive/manual）在 Bridge 层无法区分处理逻辑，模式切换实际上无效。

**严重程度**: 🔴 高 - 三种模式功能退化

**修复建议**: 在 `processImages()` 中根据 mode 参数返回不同粒度的描述。

---

## 二、Shadow History 机制审查

### 2.1 架构设计

```typescript
// shadow-history.ts:9-14
export interface ShadowReplacement {
  surfaceOp: { op: 'keep'; eventId: string };      // UI 层保留原图
  modelOp: { op: 'replace'; eventId: string; replacement: string };  // 模型层替换为文本
}
```

设计意图：
- `surfaceOp`: UI 显示原始图片（用户视角）
- `modelOp`: DeepSeek 看到文本描述（模型视角）

### 2.2 正确性验证

**createShadowReplacements() 逻辑 (L20-38)**
```typescript
export function createShadowReplacements(
  originalEventId: string,
  images: ImageAttachment[],
  descriptions: string[],
): ShadowReplacement[] {
  if (images.length === 0) return [];
  
  const replacement = descriptions.join('\n\n');
  
  return [{
    surfaceOp: { op: 'keep', eventId: originalEventId },
    modelOp: { op: 'replace', eventId: originalEventId, replacement },
  }];
}
```
✅ 逻辑正确，返回操作对符合契约

### 2.3 ⚠️ 发现问题

#### 问题 2-1: Shadow History 未接入主流程

**文件**: `src/plugin/index.ts:58-104`

查看 `OmniVisionPlugin.processMessage()` 方法：

```typescript
async processMessage(
  content: string,
  attachments: unknown[] = [],
): Promise<{ rewritten: boolean; newContent: string; imageCount: number; descriptions: string[] }> {
  // ... 处理逻辑
  // ⚠️ 没有调用 createShadowReplacements()
  // ⚠️ 没有返回 shadow 信息给调用方
}
```

**影响**: Shadow History 机制虽然定义了接口，但在实际的插件入口点未使用，导致：
- DSH 框架无法感知 shadow replacement
- 架构上"UI/模型分离"仅停留在文档层面

**严重程度**: 🟡 中 - 功能性缺失但不会破坏 KV Cache 安全

**修复建议**: 
1. 扩展返回值类型，包含 `shadows?: ShadowReplacement[]`
2. 在 `processMessage()` 中调用 shadow history 逻辑
3. 在 DSH 集成层消费 shadows 进行实际替换

#### 问题 2-2: extractImageAttachments() 类型不匹配

**文件**: `src/bridge/shadow-history.ts:50-54`

```typescript
export function extractImageAttachments(
  message: { attachments?: ImageAttachment[] },
): ImageAttachment[] {
  return Array.isArray(message.attachments) ? message.attachments : [];
}
```

**问题**: `PluginContext.processMessage()` 接受的 attachments 类型是 `unknown[]`，而 `extractImageAttachments()` 期望 `ImageAttachment[]`。

**严重程度**: 🟢 低 - 实际运行中由调用方类型转换处理

---

## 三、三种模式实现审查

### 3.1 模式定义

| 模式 | 预期行为 | 当前实现 |
|-----|---------|---------|
| auto | 静默处理，用户无感知 | ✅ 定义正确 |
| interactive | 摘要+工具提示 | ⚠️ mode 参数未传递 |
| manual | 不干预，用户控制 | ✅ 正确 |

### 3.2 代码分析

**mode-strategy.ts 模式路由 (L123-139)**
```typescript
export async function processMessage(
  content: string,
  images: ImageAttachment[],
  mode: 'auto' | 'interactive' | 'manual',
  ctx: ProcessContext,
): Promise<ProcessResult> {
  switch (mode) {
    case 'auto':
      return processAutoMode(content, images, ctx);
    case 'interactive':
      return processInteractiveMode(content, images, ctx);
    case 'manual':
      return processManualMode(content, images, ctx);
    default:
      return { unchanged: true };
  }
}
```
✅ 模式路由逻辑正确

**manual 模式实现 (L111-118)**
```typescript
export async function processManualMode(
  content: string,
  images: ImageAttachment[],
  ctx: ProcessContext,
): Promise<ProcessResult> {
  // No processing, let user call tools directly
  return { unchanged: true };
}
```
✅ 正确：直接返回 unchanged，不干扰用户操作

### 3.3 ⚠️ 发现问题

#### 问题 3-1: interactive 模式的 __vision__ 标记

**文件**: `src/bridge/mode-strategy.ts:90`

```typescript
const enrichedContent = `${content}\n\n[__vision__: 已识图摘要: ${summary}]\n[__vision__: 需要详细分析？调用vision_describe/vision_ground工具]\n`;
```

**分析**:
- `__vision__` 标记会被 `sanitizeForDeepSeek()` 移除（message-rewriter.ts:71-73）
- 这意味着 interactive 模式下，工具提示在实际发送到 DeepSeek 前会被清除

**影响**: interactive 模式的核心价值（工具提示）被静默移除，导致该模式与 auto 模式行为趋同

**严重程度**: 🟡 中 - 功能退化

**修复建议**: 
- 方案 A: 在 `rewriteMessage()` 中保留工具提示（修改正则表达式）
- 方案 B: 将工具提示作为独立字段返回，由调用方决定是否展示

#### 问题 3-2: ProcessContext 未使用 mode

**文件**: `src/bridge/mode-strategy.ts:26-30`
```typescript
export interface ProcessContext {
  bridge: VisionBridge;
  mode: 'auto' | 'interactive' | 'manual';  // 声明但未使用
  signal?: AbortSignal;
}
```

各模式函数接收 `ctx` 但从未读取 `ctx.mode`

---

## 四、消息改写逻辑审查

### 4.1 rewriteMessage() 分析

**文件**: `src/bridge/message-rewriter.ts:16-42`

```typescript
export function rewriteMessage(
  originalContent: string,
  images: ImageAttachment[],
  descriptions: VisionDescription[],
): RewrittenMessage {
  if (images.length === 0 || descriptions.length === 0) {
    return { role: 'user', content: originalContent };
  }

  const markers = descriptions.map((desc, i) => {
    const num = i + 1;
    const summary = desc.summary || 'Image content';
    const ocr = desc.ocr ? `\nOCR: ${desc.ocr.substring(0, 500)}...` : '';
    return `[已识图${num}: ${summary}${ocr}]`;
  }).join('\n\n');

  const newContent = images.length === 1
    ? `${originalContent}\n\n${markers}`
    : `${originalContent}\n\n已识图${images.length}张：\n${markers}`;

  return {
    role: 'user',
    content: newContent,
  };
}
```

### 4.2 ✅ 正确性验证

| 测试场景 | 预期行为 | 实现状态 |
|---------|---------|---------|
| 无图片输入 | 返回原始内容 | ✅ |
| 单张图片 | 附加描述 | ✅ |
| 多张图片 | 批量标注 | ✅ |
| OCR 超长 | 截断到 500 字符 | ✅ |

### 4.3 extractDescriptions() 边界情况

**文件**: `src/bridge/message-rewriter.ts:54-66`

```typescript
export function extractDescriptions(content: string): VisionDescription[] {
  const descriptions: VisionDescription[] = [];
  const regex = /\[已识图(\d+): ([^\]]+)\]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const index = parseInt(match[1], 10);
    const summary = match[2];
    descriptions.push({ summary, raw: { _index: index } });
  }

  return descriptions;
}
```

**潜在问题**: 正则表达式 `([^\]]+)` 会贪婪匹配直到遇到 `]`，如果 summary 中包含 `]` 字符，会导致解析错误。

**修复建议**: 使用非贪婪匹配或更精确的正则：
```typescript
const regex = /\[已识图(\d+): ([^\]]*?)\]/g;
```

---

## 五、缓存 Key 生成审查

### 5.1 当前实现

**文件**: `src/bridge/vision-bridge.ts:79-85`

```typescript
private createCacheKey(image: ImageAttachment, query: string): string {
  return createHash('sha256')
    .update(image.contentHash)
    .update(query || '')
    .digest('hex')
    .slice(0, 16);
}
```

### 5.2 ✅ 正确性分析

| 属性 | 状态 | 说明 |
|-----|------|------|
| 确定性 | ✅ | 相同输入产生相同输出 |
| 唯一性 | ✅ | SHA-256 碰撞概率极低 |
| 长度 | ✅ | 16 字符 hex，适合作为 Map key |

### 5.3 ⚠️ 发现问题

#### 问题 5-1: 缺少会话隔离

**当前行为**: 缓存 key = SHA256(contentHash + query)

**问题**: 跨会话复用缓存可能导致：
1. 不同用户的相同图片返回错误的描述（如果 query 不同）
2. 敏感内容的缓存污染

**建议**: 在缓存 key 中加入 sessionId 或 userId 前缀

```typescript
private createCacheKey(image: ImageAttachment, query: string, sessionId?: string): string {
  return createHash('sha256')
    .update(sessionId || '')
    .update(image.contentHash)
    .update(query || '')
    .digest('hex')
    .slice(0, 16);
}
```

#### 问题 5-2: 缓存未考虑模式差异

auto 和 interactive 模式对同一图片可能生成不同的描述格式，但缓存 key 相同，会导致结果错误。

**建议**: 将 mode 纳入缓存 key 计算

---

## 六、异常处理安全性审查

### 6.1 失败路径分析

**vision-bridge.ts 异常处理**

```typescript
// L46-48: Promise.allSettled 处理并行失败
const results = await Promise.allSettled(
  images.map((img) => this.processSingleImage(img, query, signal)),
);

// L52-57: 跳过失败的图片
for (const result of results) {
  if (result.status === 'fulfilled') {
    descriptions.push(result.value);
  }
  // Skip failed images
}
```

✅ 单张图片失败不影响整体处理

### 6.2 熔断器保护

**circuit.ts 分析**

- AUTH/REGION/TOS 失败: 10 分钟冷却
- RATE_LIMIT/QUOTA: 60 秒冷却
- 其他: 30 秒冷却

✅ 合理的分级冷却策略

### 6.3 ⚠️ 异常场景检查

#### 场景 1: 所有 Provider 失败

**chain.ts:78-88**
```typescript
return {
  ok: false,
  meta: { provider: 'none', model: 'none', durationMs: Date.now() - startTime },
  errors: [{
    kind: 'OTHER',
    code: 'VISION_ALL_FAILED',
    message: `All ${providers.length} vision providers failed`,
    retryable: false,
  }],
};
```

✅ 返回明确错误，不会静默失败

#### 场景 2: AbortSignal 触发

**vision-bridge.ts:105-107**
```typescript
if (signal?.aborted) {
  throw new Error('Cancelled');
}
```

⚠️ 抛出异常而非返回空结果，可能中断整个处理流程

**建议**: 返回空数组或特殊标记，而非抛异常

---

## 七、安全检查清单

### 7.1 KV Cache 安全保证矩阵

| 检查项 | 状态 | 备注 |
|-------|------|------|
| 图片不进入模型请求 | ✅ | `RewrittenMessage` 类型约束 |
| 描述不泄露图片内容 | ✅ | 仅 summary/ocr 文本 |
| 缓存不含图片二进制 | ✅ | key 仅 hash |
| 失败不暴露原始图片 | ✅ | 错误信息不包含附件 |
| 工具调用不传图片 | ⚠️ | `callTool()` 中 images 为空数组 |
| session 隔离 | ❌ | 缓存 key 无会话信息 |

### 7.2 数据流追踪

```
用户输入
    ↓
[Plugin.processMessage()]
    ↓ 提取 attachments
[VisionBridge.processImages()]
    ↓ 并行处理
[Provider.execute()] → 返回 VisionDescription[]
    ↓
[rewriteMessage()] → 生成纯文本
    ↓
[DeepSeek API] ← 仅接收 content 字段
```

✅ 数据流清晰，无图片数据渗透到最终请求

---

## 八、发现总结

### 8.1 关键问题（必须修复）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 1 | `originalEventId` 硬编码为 `'original-event-id'` | mode-strategy.ts:56 | Shadow History 失效 |
| 2 | `mode` 参数未传入 Bridge | plugin/index.ts:27 | 三种模式无法区分 |
| 3 | Shadow History 未在插件入口使用 | plugin/index.ts | 架构断链 |

### 8.2 重要问题（建议修复）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 4 | interactive 模式的工具提示被 sanitize 移除 | mode-strategy.ts:90 | 功能退化 |
| 5 | 缓存 key 缺少会话隔离 | vision-bridge.ts:79 | 跨会话污染风险 |
| 6 | 缓存 key 未考虑模式差异 | vision-bridge.ts:79 | 结果错误风险 |

### 8.3 轻微问题（可选优化）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 7 | extractDescriptions 正则可以更精确 | message-rewriter.ts:56 | 边界情况解析错误 |
| 8 | AbortSignal 触发时抛异常 | vision-bridge.ts:106 | 可能中断流程 |

---

## 九、架构建议

### 9.1 立即修复项

1. **修复 Shadow History 集成**
   ```typescript
   // plugin/index.ts 应扩展返回值
   return {
     rewritten: true,
     newContent,
     imageCount: images.length,
     descriptions: descriptions.map(d => d.summary),
     shadows: createShadowReplacements(eventId, images, descriptions.map(d => d.summary)),
   };
   ```

2. **传递 mode 到 Bridge**
   ```typescript
   // 在 processImages 中使用 mode 参数
   async processImages(images, query, signal, mode) {
     if (mode === 'manual') return [];
     // ...
   }
   ```

3. **修复缓存 key**
   ```typescript
   private createCacheKey(image, query, mode, sessionId) {
     return createHash('sha256')
       .update(sessionId || 'default')
       .update(mode)
       .update(image.contentHash)
       .update(query || '')
       .digest('hex')
       .slice(0, 16);
   }
   ```

### 9.2 长期优化建议

1. **添加架构测试**
   - 验证每个请求都不包含图片数据
   - 验证 Shadow History 的 end-to-end 流程

2. **引入审计日志**
   - 记录每次图片处理的 key、mode、provider
   - 便于追踪潜在的安全问题

3. **增加 fuzzing 测试**
   - 测试异常输入下的行为
   - 验证边界条件的安全性

---

## 十、结论

dsh-omnivision 的 **Vision Pre-Step Bridge 架构设计正确**，核心理念——将所有图像处理前置到 DeepSeek 请求之前——从架构层面保证了 KV Cache 安全。

然而，当前实现在以下方面存在缺陷：
1. Shadow History 机制未正确接入主流程
2. 三种模式切换功能退化
3. 缓存策略缺少必要的隔离

这些问题不会导致 KV Cache 被图片数据污染（核心安全目标仍达成），但会影响功能的完整性和正确性。

**建议**: 修复上述关键问题后，可进行完整的端到端集成测试，验证 DSH 框架层的 shadow replacement 是否按预期工作。

---

**审查人**: Architecture Review Agent  
**下次审查**: 建议在修复关键问题后进行 Round 2 审查
