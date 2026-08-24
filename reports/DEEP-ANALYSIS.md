# DSH Omnivision — 深度代码分析报告

> **分析日期**: 2026-08-21  
> **版本**: 0.1.0-alpha  
> **状态**: ✅ 核心可用，存在若干架构级问题需修复

---

## 一、整体架构概览

### 1.1 核心设计哲学

```
用户贴图片
    ↓
Pre-Step Bridge（插件拦截）
    ├─ VisionBridge: 图片 → AI文字描述
    ├─ MessageRewriter: 纯文本改写
    └─ ShadowHistory: UI显示图片 / 模型看文字
    ↓
DeepSeek 收到纯文本 → KV Cache 零污染 ✅
```

**正确性判断**: ✅ 核心思路成立，Shadow History 分离保证了 KV Cache 安全。

### 1.2 模块依赖图

```
src/index.ts (入口)
├── src/plugin/index.ts          ← 插件主入口，协调所有组件
│   ├── src/bridge/vision-bridge.ts   ← 核心：图片处理+缓存+failover
│   │   ├── src/vision/chain.ts       ← failover链+CircuitBreaker
│   │   │   └── src/resilience/circuit.ts
│   │   └── src/security/index.ts     ← SSRF+PathPolicy+凭据脱敏
│   ├── src/bridge/message-rewriter.ts
│   ├── src/bridge/shadow-history.ts
│   └── src/vision/providers.ts       ← 5个Provider实现
├── src/config/schema.ts            ← 配置Schema+默认值
├── src/config/types.ts             ← 所有类型定义
├── src/tools/types.ts              ← 工具类型（含TOOLS数组）
├── src/utils/image.ts              ← 图片工具函数
└── [已删除] src/tools/index.ts     ← 工具实现（已清理）
```

### 1.3 数据流详解

#### processMessage 路径（核心路径）
```
1. 接收 content + attachments + eventId
2. PathPolicy 校验每个附件路径
3. VisionBridge.processImages() 处理所有图片
   ├─ 检查session缓存 → 命中则跳过
   ├─ 调用 executeWithFailover()
   │   ├─ 检查CircuitBreaker是否熔断
   │   ├─ 遍历provider列表
   │   │   ├─ 调用 provider.execute()
   │   │   └─ 成功→返回，失败→记录→下一个
   │   └─ 全部失败→返回错误结果
   └─ 结果写入缓存
4. 构造 [已识图N: ...] 标记
5. 创建 ShadowReplacement（如有eventId）
6. 返回 { rewritten, newContent, descriptions, shadows }
```

#### callTool 路径
```
1. 从 args 提取 images + query
2. 直接调用 executeWithFailover()
3. 返回 VisionResult
```

---

## 二、各模块详细审查

### 2.1 VisionBridge (`src/bridge/vision-bridge.ts`) — ⚠️ 有改进空间

**职责**: 图片处理、缓存管理、failover调用

| 项目 | 现状 | 评价 |
|------|------|------|
| 缓存key | `SHA256(sessionId + mode + contentHash + query[:32])` | ⚠️ query前缀有信息泄漏风险（虽然只取32字符） |
| 缓存上限 | 100条LRU | ✅ 合理 |
| TTL | 1小时 | ✅ 合理 |
| 失败处理 | 返回 `[Vision error: ...]` 描述 | ✅ 不中断流程 |
| Manual模式 | 直接返回空数组 | ✅ 正确 |
| AbortSignal | 抛 `Error('Cancelled')` 但被allSettled包裹 | ✅ 实际上安全 |

**问题**:
1. **缓存key中query参与哈希** — 虽然只取前32字符，但仍然把用户提问内容混入缓存key。理想情况应该用contentHash + 一个归一化的"意图token"（如第一个关键词）。
2. **缺少缓存命中率统计** — 无法监控缓存效果。
3. **processSingleImage内的for循环** — 虽然已改为调用executeWithFailover，但注释里还保留着旧逻辑的说明。

### 2.2 Failover Chain (`src/vision/chain.ts`) — ✅ 良好

| 项目 | 现状 | 评价 |
|------|------|------|
| CircuitBreaker | 接受可选持久实例 | ✅ 修复后正确 |
| 超时控制 | totalTimeoutMs + providerTimeoutMs | ✅ 双层超时 |
| 错误分类 | 11类FailureKind | ✅ 覆盖全面 |
| 凭据脱敏 | 调用redactSecrets | ✅ 已接入 |
| 全部失败返回 | 结构化错误+advice | ✅ 有修复建议 |

**潜在问题**:
- `classifyError` 用字符串匹配判断错误类型，比较脆弱。如果provider返回非标准错误信息可能分类错误。
- 没有尝试次数限制（仅靠CircuitBreaker间接控制）。

### 2.3 Providers (`src/vision/providers.ts`) — ⚠️ 有安全问题

**当前实现**: 5个provider（OpenAI/Anthropic/Gemini/OVH/Zhipu）

| Provider | API Key方式 | SSRF防护 | redirect |
|----------|------------|----------|----------|
| OpenAI | Bearer Header | ✅ assertSafeRemoteTarget | ✅ manual |
| Anthropic | x-api-key Header | ✅ | ✅ manual |
| Gemini | x-goog-api-key Header | ✅ | ✅ manual |
| OVH | 无Key | ✅ | ✅ manual |
| Zhipu | Bearer Header | ✅ | ✅ manual |

**问题**:
1. **路径白名单过宽**: `ALLOWED_PATHS = ['/tmp', '/private/tmp']` — 移除了/home但还不够严格。应该只允许workspace内路径。`readFileAsBase64`不接收workspace参数，无法验证图片是否在授权目录内。
2. **硬编码API端点**: 所有provider的URL都是硬编码字符串，不支持自定义baseUrl。配置中的`providers[].baseUrl`被忽略。
3. **废弃模型名**: `gpt-4-vision-preview` 已废弃，应改为 `gpt-4o` 或 `gpt-4o-mini`。
4. **文件读取不使用Policy**: `readFileAsBase64`有自己的ALLOWED_PATHS，与Plugin中的PathPolicy不一致。

### 2.4 Circuit Breaker (`src/resilience/circuit.ts`) — ✅ 良好

| 项目 | 现状 | 评价 |
|------|------|------|
| 状态管理 | Map<provider, CircuitState> | ✅ 正确 |
| TTL策略 | AUTH/REGION/TOS=10min, RATE_LIMIT=1min | ✅ 合理 |
| 成功重置 | record('success')清除状态 | ✅ |
| 跨请求持久 | 由plugin传入实例 | ✅ 修复后正确 |

### 2.5 Security (`src/security/index.ts`) — ⚠️ 部分问题

**SSRF防护**: `assertSafeRemoteTarget`
- ✅ DNS pinning（解析后立即固定IP）
- ✅ 私有IP阻断
- ❌ 未防止DNS rebinding（解析后到fetch前可能被劫持）
- ❌ 不支持自定义URL（所有URL硬编码）

**PathPolicy**:
- ✅ 改用`path.relative()`段级比较
- ⚠️ 但`allowInput`仍用`startsWith`语义的相对路径检查，`/tmp-evil`仍可能通过（`relative('/tmp', '/tmp-evil')` = `../tmp-evil`，不以`..`开头，会通过！）
- ⚠️ `rejectSymlink`有TOCTOU竞争条件

**凭据脱敏**:
- ✅ 三层过滤（精确+正则+URL）
- ✅ 已接入chain.ts和tools

### 2.6 Message Rewriter (`src/bridge/message-rewriter.ts`) — ✅ 良好

- 正确处理单图/多图格式
- OCR内容截断到500字符防止上下文膨胀
- `sanitizeForDeepSeek` 清理内部标记
- `extractDescriptions` 可从改写后的内容反向解析

### 2.7 Shadow History (`src/bridge/shadow-history.ts`) — ⚠️ 简化过度

**当前实现**:
```typescript
export function createShadowReplacements(
  originalEventId: string,
  images: ImageAttachment[],
  descriptions: string[],
): ShadowReplacement[] {
  // 返回单一replacement，所有图片共享同一个eventId
  return [{ surfaceOp: { op: 'keep' }, modelOp: { op: 'replace' } }];
}
```

**问题**: 
- 多张图片时只有1个ShadowReplacement，而不是每张图一个
- `replacement`字段是all descriptions joined，但没有区分哪张图对应哪个description
- 如果一张图失败（返回error description），UI仍然会显示原始图片，但模型看到的是错误标记 — 这不一致

### 2.8 Plugin Entry (`src/plugin/index.ts`) — ⚠️ 有几个问题

**当前问题**:

1. **composeProviders忽略配置的baseUrl/model**:
```typescript
for (const p of this.ctx.config.providers) {
  if (p.name === 'openai') providers.push(openaiProvider); // 忽略了p.model和p.baseUrl
```
自定义provider配置完全无效。

2. **附件元数据部分丢失**:
```typescript
images.map(img => ({
  path: img.path,
  contentHash: img.contentHash,
  mime: img.mime ?? 'image/png',  // 如果附件没有mime，用png替代
  bytes: img.bytes ?? 0,           // bytes为0
}))
```
`bytes: 0` 导致文件大小限制检查失效。

3. **config中visionDepth/downscale等参数被读取但未使用**:
- `config.visionDepth` — 未传入VisionBridge
- `config.downscale` — 未在provider中使用
- `config.maxImageBytes/maxImagePixels` — 仅在validateConfig中警告，未实际校验

4. **callTool的images参数类型不安全**:
```typescript
const imagesArg = args.images as Array<...> | undefined;
```
没有类型安全保障，如果args.images格式不对会静默失败。

### 2.9 Config Schema (`src/config/schema.ts`) — ✅ 良好

- DEFAULT_CONFIG定义了所有可选参数
- validateConfig有基本的合理性检查
- 类型定义完整

**但**: schema.ts定义了`PluginConfig`接口，而plugin实际使用的是展开的`OmniVisionConfig`，两者不完全一致。

### 2.10 Tools Types (`src/tools/types.ts`) — ⚠️ 有死代码

- `TOOLS`数组包含10个工具定义，handler都指向`await import('./index.ts')`
- 但`src/tools/index.ts`现在是空文件（之前删除了实现）
- 这些handler在运行时调用会失败（import空文件）
- **但是**：`callTool`根本不读TOOLS数组，直接调用executeWithFailover，所以TOOLS数组是纯粹的死代码

### 2.11 Image Utils (`src/utils/image.ts`) — ✅ 良好

- magic byte检测实现正确
- MIME类型检测覆盖主流格式
- validateImageSize有实际校验逻辑
- **但未被plugin调用** — 是死代码

---

## 三、测试覆盖分析

### 3.1 测试矩阵

| 模块 | 测试文件 | 用例数 | 覆盖度 |
|------|---------|--------|--------|
| bridge | message-rewriter.test.ts | 6 | ✅ 核心逻辑 |
| bridge | vision-bridge.test.ts | 8 | ✅ 缓存/failover/模式 |
| security | index.test.ts | 8 | ✅ 脱敏/IP检测 |
| security | security-integration.test.ts | 10 | ✅ PathPolicy/SSRF |
| utils | image.test.ts | 6 | ✅ MIME/大小校验 |
| resilience | circuit.test.ts | 6 | ✅ 熔断器状态机 |
| integration | e2e-workflows.test.ts | 12 | ✅ 端到端流程 |
| **总计** | **7 files** | **56** | **核心路径✅ 边界⚠️** |

### 3.2 缺失的测试

1. **Provider层测试**: 5个provider没有任何单元测试（mock了整个provider，没测真实实现）
2. **Chain层测试**: executeWithFailover的超时、熔断、重试逻辑没有直接测试
3. **Shadow History多图片场景**: 只测了单图
4. **Interactive模式**: 完全没有测试
5. **错误边界**: Provider部分成功部分失败的混合场景

---

## 四、构建产物分析

```
dist/index.js    26.10 kB   (ESM, SSR bundle)
dist/index.js.map 55.60 kB  (source map)
```

**模块树**: 8 modules transformed
- 包含所有src/代码
- Node内置模块被external化
- 无第三方运行时依赖（sharp/puppeteer/potrace是peerDependency）

**问题**: 
- `package.json` 的 `main`/`module`/`types` 指向 `./dist/index.js`，但vite输出文件名是`index.js`，正确。
- `bin` 字段已移除（之前指向不存在的cli.js），正确。
- 但缺少 `exports` 的 `"./package.json"` 子路径导出可能会有tree-shaking问题。

---

## 五、与参考项目的对比

| 维度 | dsh-omnivision | modlens | toolkit | router |
|------|---------------|---------|---------|--------|
| KV Cache安全 | ✅ 保证 | ✅ 保证 | ⚠️ Skill驱动 | ❌ 整轮路由有影响 |
| 工具数量 | 0（inline调用） | 1 | 10 | 14 |
| 免费通道 | ✅ OVH+智谱 | ✅ antigravity-cli | ✅ anionex.me | ✅ OVH |
| 本地Ollama | ❌ 未实现 | ❌ | ❌ | ✅ |
| 预识别/bootstrap | ❌ 未实现 | ❌ | ❌ | ✅ |
| 混合内容路由 | ❌ 未实现 | ❌ | ❌ | ✅ |
| 像素级工具(crop/diff/trace) | ❌ 未实现 | ❌ | ✅ | ❌ |
| 并发控制 | ❌ 无 | ❌ | Semaphore | Governor |
| 长截图OCR | ❌ 未实现 | ❌ | ✅ | ✅ |

---

## 六、问题分级汇总

### 🔴 P0 — 阻断生产发布

| # | 问题 | 影响 | 修复建议 |
|---|------|------|---------|
| 1 | `TOOLS`数组handler指向不存在的实现 | 如果未来启用工具模式会崩溃 | 删除TOOLS或补全实现 |
| 2 | `utils/image.ts`工具函数未被调用 | 死代码，magic byte检测浪费代码空间 | 接入plugin或删除 |
| 3 | Provider忽略配置的`baseUrl`/`model` | 自定义provider完全无效 | 修改composeProviders支持动态创建 |
| 4 | `maxImageBytes/maxImagePixels`配置不生效 | 大图片可能超出provider限制 | 在readFileAsBase64或plugin中校验 |
| 5 | `visionDepth`/`downscale`配置被忽略 | 质量/性能调优无法生效 | 传入VisionBridge或providers |

### 🟡 P1 — 重要但可绕过的缺陷

| # | 问题 | 影响 | 修复建议 |
|---|------|------|---------|
| 6 | PathPolicy相对路径检查不够严格 | `/tmp-evil`可能绕过 | 改用`normalize`后精确比较路径段 |
| 7 | ShadowHistory多图时只有一个replacement | 多图片场景UI/模型视图可能不一致 | 每个图片单独生成replacement |
| 8 | callTool无参数类型校验 | 错误参数静默失败 | 添加参数schema验证 |
| 9 | `bytes: 0`当附件无元数据 | 文件大小限制失效 | 实际读取文件获取大小 |
| 10 | 缓存key混入query内容 | 隐私顾虑+缓存命中率低 | 用query的第一个关键词代替完整query |

### 🟢 P2 — 改进建议

| # | 问题 | 建议 |
|---|------|------|
| 11 | 无Provider单元测试 | 为5个provider各写1-2个测试 |
| 12 | 无Interactive模式测试 | 添加interactive模式集成测试 |
| 13 | 无chain层直接测试 | 单独测试executeWithFailover的超时/熔断逻辑 |
| 14 | README功能表与代码不完全匹配 | 同步更新 |
| 15 | 缺少healthCheck调用 | 定期健康检查provider可用性 |

---

## 七、总结评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **核心架构** | 8.5/10 | Pre-Step Bridge设计正确，KV Cache安全保证成立 |
| **代码质量** | 7/10 | TS类型安全，但有死代码和未接线功能 |
| **安全性** | 7.5/10 | 三层防护已实现，但部分检查不够严格 |
| **测试覆盖** | 7/10 | 核心路径56个测试通过，但provider/chain层缺失 |
| **文档可信度** | 6/10 | README功能表超出实际实现 |
| **构建可用性** | 8/10 | 构建成功，但缺少CLI和完整工具集 |

**综合评分: 7.2/10**

**结论**: 作为alpha原型合格，核心架构正确且安全。但需要修复P0问题后才能进入正式生产使用阶段。主要短板是工具集不完整（只有describe/ground/detect的远程调用，无本地像素工具）和配置灵活性不足（自定义provider无效）。

---

*报告生成: Hermes Agent*
*基于4轮代码审查 + 3轮安全审查 + 架构验证*
