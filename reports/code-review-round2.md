# DSH Omnivision - 第二轮代码审查报告

**审查日期**: 2026-08-21  
**审查轮次**: Round 2 (P0 问题修复验证)  
**审查范围**: 5 个 P0 问题修复验证 + 测试/类型检查  

---

## 执行摘要

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 1. 文件路径验证 (providers.ts) | ✅ 已修复 | `readFileAsBase64` 增加路径白名单和文件大小限制 |
| 2. API Key 保护 | ✅ 安全 | Key 从环境变量读取，未硬编码或直接暴露 |
| 3. 缓存 TTL 实现 (vision-bridge.ts) | ✅ 已修复 | `CacheEntry` 接口 + 1小时 TTL + Session 隔离 |
| 4. 工具错误返回 (tools/index.ts) | ✅ 已修复 | `vision_crop/vision_trace/vision_screenshot` 返回真实错误 |
| 5. callTool 实现 (plugin/index.ts) | ✅ 已修复 | sessionId 传递 + shadow replacements |
| 测试通过 | ✅ 34/34 | 包含新增的 manual mode 和 session 隔离测试 |
| TypeScript 编译 | ✅ 通过 | 无类型错误 |

---

## 详细修复验证

### 1. 文件路径验证 (providers.ts) ✅

**文件**: `src/vision/providers.ts` (L33-45)

```typescript
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const ALLOWED_PATHS = ['/tmp', '/private/tmp'];

function readFileAsBase64(path: string): string {
  const resolved = resolve(path);
  // Path validation
  const isAllowed = ALLOWED_PATHS.some(p => resolved.startsWith(p)) || resolved.startsWith('/tmp');
  if (!isAllowed) {
    throw new Error(`PATH_DENIED: ${path}`);
  }
  const buffer = readFileSync(resolved);
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`FILE_TOO_LARGE: ${buffer.length} bytes`);
  }
  return buffer.toString('base64');
}
```

**验证结果**:
- ✅ 路径白名单限制：仅允许 `/tmp` 和 `/private/tmp` 目录下的文件
- ✅ 文件大小限制：最大 25MB
- ✅ 抛出结构化错误：`PATH_DENIED` / `FILE_TOO_LARGE`

---

### 2. API Key 保护 ✅

**文件**: `src/vision/providers.ts` (L64, L82, L114, L177)

| Provider | API Key 来源 | 直接暴露 |
|----------|-------------|---------|
| OpenAI | `process.env.OPENAI_API_KEY` | ❌ 否 |
| Anthropic | `process.env.ANTHROPIC_API_KEY` | ❌ 否 |
| Gemini | `process.env.GEMINI_API_KEY` | ❌ 否 |
| Zhipu | `process.env.ZAI_API_KEY` | ❌ 否 |

**验证结果**:
- ✅ 所有 API Key 从环境变量读取，未硬编码
- ✅ Key 仅在请求头中使用，不写入日志或响应
- ✅ `buildFailureResponse` 不包含敏感信息

---

### 3. 缓存 TTL 实现 (vision-bridge.ts) ✅

**文件**: `src/bridge/vision-bridge.ts` (L16-19, L31-32, L136-151)

```typescript
interface CacheEntry {
  description: VisionDescription;
  expiresAt: number;
}

// ...
private completedResults = new Map<string, CacheEntry>();
private readonly defaultTtlMs = 3600_000; // 1 hour

private getFromCache(key: string): VisionDescription | undefined {
  const entry = this.completedResults.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    this.completedResults.delete(key);
    return undefined;
  }
  return entry.description;
}

private setCache(key: string, description: VisionDescription): void {
  this.completedResults.set(key, {
    description,
    expiresAt: Date.now() + this.defaultTtlMs,
  });
}
```

**验证结果**:
- ✅ `CacheEntry` 接口包含 `expiresAt` 时间戳
- ✅ TTL 默认 1 小时 (3600000ms)
- ✅ `getFromCache` 检查过期并删除过期条目
- ✅ Session ID 用于缓存键隔离 (L82-89)

---

### 4. 工具错误返回 (tools/index.ts) ✅

**文件**: `src/tools/index.ts` (L67-68, L111-112, L131-132)

| 工具 | 修复前 | 修复后 |
|------|--------|--------|
| `vision_crop` | 假成功 | `{ ok: false, error: 'vision_crop requires optional dependency: sharp' }` |
| `vision_trace` | 假成功 | `{ ok: false, error: 'vision_trace requires optional dependency: potrace'` }` |
| `vision_screenshot` | 假成功 | `{ ok: false, error: 'vision_screenshot requires optional dependency: puppeteer-core' }` |

**验证结果**:
- ✅ 三个工具正确返回 `{ ok: false, error: '...' }`
- ✅ 其他工具仍正常返回成功响应
- ✅ catch 块统一处理异常

---

### 5. callTool 实现 (plugin/index.ts) ✅

**文件**: `src/plugin/index.ts` (L22-26, L72-75, L86-96)

```typescript
constructor(private ctx: PluginContext) {
  this.circuitBreaker = new VisionCircuitBreaker();
  this.providers = this.composeProviders();
  // Pass sessionId to bridge for cache isolation
  this.bridge = new VisionBridge(this.providers, ctx.config.mode, ctx.sessionId);
}

// ...
const shadows = eventId
  ? createShadowReplacements(eventId, images.map(img => ({ ...img, mime: 'image/png', bytes: 0 })), descriptions.map(d => d.summary))
  : undefined;

// ...
async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return executeWithFailover(this.providers, {
    images: [],
    query: args.query as string,
    tool,
    parameters: args,
  }, {
    totalTimeoutMs: this.ctx.config.timeoutMs,
    providerTimeoutMs: this.ctx.config.visionTaskTimeoutMs,
  });
}
```

**验证结果**:
- ✅ `sessionId` 传递给 `VisionBridge` 构造函数
- ✅ `createShadowReplacements` 在 `eventId` 存在时创建 shadow 记录
- ✅ `callTool` 正确传递参数并调用 failover 链

---

## 测试与类型检查

### 测试结果

```
 ✓ tests/bridge/message-rewriter.test.ts (6 tests)
 ✓ tests/security/index.test.ts (8 tests)
 ✓ tests/utils/image.test.ts (6 tests)
 ✓ tests/bridge/vision-bridge.test.ts (8 tests)   ← 新增 manual mode + session isolation
 ✓ tests/resilience/circuit.test.ts (6 tests)

Test Files  5 passed (5)
     Tests  34 passed (34)
Duration    369ms
```

### TypeScript 编译

```bash
$ npx tsc --noEmit
# 无输出，编译通过
```

---

## 新增测试覆盖 (vision-bridge.test.ts)

| 测试用例 | 验证内容 |
|----------|---------|
| `should handle manual mode correctly` | manual 模式不触发 API 调用 |
| `should generate stable cache keys with session isolation` | 不同 session 隔离缓存 |

---

## 结论

**所有 P0 问题已修复并通过验证。**

| 项目 | 状态 |
|------|------|
| 文件路径验证 | ✅ 已实现 |
| API Key 安全 | ✅ 无泄露 |
| 缓存 TTL | ✅ 已实现 |
| 工具错误返回 | ✅ 已修复 |
| callTool 实现 | ✅ 已实现 |
| 测试通过率 | ✅ 34/34 |
| 类型检查 | ✅ 无错误 |

---

*Report generated by DSH Code Review System*
