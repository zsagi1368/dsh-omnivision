# dsh-omnivision 安全专项审查报告（Round 1）

**审查日期**: 2026-08-21  
**审查范围**: `/home/z/dsh-omnivision/src` 全部源文件  
**审查结论**: 存在若干中高风险安全问题，核心防护函数未接入实际路径  

---

## 一、总体评估

| 风险维度 | 评级 | 说明 |
|---------|------|------|
| SSRF 防护 | 🔴 HIGH | 防护函数已实现但从未调用 |
| 凭据安全 | 🔴 HIGH | API Key 以明文传递至 URL Query String |
| 路径控制 | 🟡 MEDIUM | PathPolicy 存在 race condition + symlink 检查不完整 |
| 信息泄露 | 🟡 MEDIUM | 错误消息含完整 provider 名称 + HTTP 状态码 |
| 并发/资源 | 🟡 MEDIUM | 无并发控制，缓存无内存上限 |
| 注入风险 | 🟢 LOW | 主要输入走本地文件，路径参数有 policy 校验 |

---

## 二、详细问题清单

### 2.1 🔴 HIGH — SSRF 防护未接入

**位置**: `src/security/index.ts` — `assertSafeRemoteTarget()` 定义但未使用

```typescript
// 此函数在整个 src/ 目录下未被任何模块调用
export async function assertSafeRemoteTarget(url: string): Promise<{ ip: string; url: URL }>
```

**影响**: 若未来任何模块引入远程 URL 请求（如 `visionScreenshot` 从 URL 加载 HTML），将完全暴露于 SSRF 攻击。当前所有 `fetch()` 调用均为硬编码的固定域名，但代码架构留有扩展空间。

**建议**: 
1. 在 `providers.ts` 的 fetch 调用前强制调用 `assertSafeRemoteTarget()`
2. 或将 API base URL 改为白名单配置（不允许用户配置任意 URL）
3. 明确禁止用户端传入自定义 endpoint URL

---

### 2.2 🔴 HIGH — Gemini API Key 嵌入 URL Query String

**位置**: `src/vision/providers.ts:88`

```typescript
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
  ...
);
```

**影响**: API Key 出现在完整请求 URL 中，会：
- 被 CDN/代理日志记录（Google Cloud 日志、中间代理）
- 出现在 `response.url` 属性中
- 可能被错误日志捕获
- 违反 OWASP API Security Top 10（API Key in URL）

**建议**: 改用标准 Header 认证方式：
```typescript
headers: {
  'Content-Type': 'application/json',
  'x-goog-api-key': apiKey,  // Google 推荐方式
}
```

---

### 2.3 🔴 HIGH — 凭据脱敏函数未接入任何日志路径

**位置**: `src/security/index.ts` — `redactSecrets()` 和 `redactUrl()` 定义但未调用

```typescript
// 从未在 src/ 中被调用
export function redactSecrets(text: string, knownSecrets: string[]): string
export function redactUrl(url: string): string
```

**影响**: 所有错误日志、诊断输出、failover 链日志均可能包含完整 API Key：
- `chain.ts:48` — `lastError = error instanceof Error ? error.message : String(error)` 直接透传
- `providers.ts` — catch 块中的 `error.message` 可能含连接信息
- 前端控制台可见原始 error

**建议**: 在所有 `console.log/error`、错误返回、failover 记录处调用 `redactSecrets()`；建立 knownSecrets 列表（从 `process.env` 中提取当前会话有效的 key）。

---

### 2.4 🟡 MEDIUM — 错误信息泄露 provider 内部细节

**位置**: 多处

| 文件 | 行 | 泄露内容 |
|-----|-----|---------|
| `src/vision/providers.ts:63` | `buildFailureResponse` | 完整 HTTP status + statusText |
| `src/vision/providers.ts:73` | catch | `error.message` 原样返回（含 DNS/网络细节） |
| `src/tools/index.ts` | 各工具 catch | `error.message` 直接返回给调用方 |
| `src/vision/chain.ts:48` | `lastError` 透传 | 含 provider 名称的完整错误 |

**示例**:
```typescript
// providers.ts:73 — 暴露内部网络信息
return buildFailureResponse(0, error instanceof Error ? error.message : 'Unknown error');
// 可能输出: "Error: getaddrinfo ENOTFOUND api.openai.com" (DNS 泄露)
// 可能输出: "TypeError: fetch failed (connection reset)" (网络拓扑泄露)
```

**建议**: 构建统一错误映射，仅返回抽象错误码（`NETWORK_ERROR`、`AUTH_FAILED`），不传递底层异常消息。

---

### 2.5 🟡 MEDIUM — PathPolicy 缺少 symlink 安全检查（race condition）

**位置**: `src/security/index.ts:82-99`

```typescript
rejectSymlink(path: string): void {
    const fs = require('node:fs');
    try {
      const stats = fs.lstatSync(path);      // ← 存在 TOCTOU
      if (stats.isSymbolicLink()) {
        throw new Error(`PATH_SYMLINK_DENIED...`);
      }
    } catch (...) { ... }
}
```

**问题**:
1. `allowInput()` 检查 path 是否在允许目录内，然后 `readFile` 读取 — 中间可能被替换为 symlink
2. `rejectSymlink()` 仅在输出路径（`allowOutput`）时应该调用，但 input 路径未检查
3. `require('node:fs')` 是动态 require，而非顶层 import

**建议**: 使用 `fs.open()` + `O_NOFOLLOW` flag 或在读取前统一做一次 symlink 检查。

---

### 2.6 🟡 MEDIUM — 并发图像处理无速率限制

**位置**: `src/bridge/vision-bridge.ts:46-52`

```typescript
const results = await Promise.allSettled(
  images.map((img) => this.processSingleImage(img, query, signal)),
);
```

**影响**: 同时发送 N 张图片，每个 provider 并发 N 个请求。若用户通过 `vision_describe` 批量处理大量图片，会在短时间内对单一 provider（如 OVH free tier，限 2 req/min）造成严重超限，触发熔断器误判。

**建议**: 添加每 provider 的并发限流（ semaphore 或队列），或至少在文档中明确约束。

---

### 2.7 🟡 MEDIUM — 内存缓存无上限保护

**位置**: `src/bridge/vision-bridge.ts:22`

```typescript
private completedResults = new Map<string, VisionDescription>();
```

**影响**: `Map` 无限增长。若单次 session 处理大量图片，内存无界增长。配置中的 `cacheMaxEntries: 200`、`cacheMaxBytes: 512MB` 仅在 schema 中定义，但 `VisionBridge` 不使用这些配置。

**建议**: 将 `maxEntries` 限制写入 `VisionBridge`，或使用 LRU 淘汰策略。

---

### 2.8 🟡 MEDIUM — `readFileAsBase64` 无大小限制

**位置**: `src/vision/providers.ts:23`

```typescript
function readFileAsBase64(path: string): string {
  const fs = require('node:fs');
  return fs.readFileSync(path).toString('base64');
}
```

**影响**: 直接 `readFileSync` 整个文件到内存，转换为 base64 后体积膨胀 ~33%。对于 4MB 图片，内存中同时存在原始 buffer + base64 string ≈ 9.3MB。若 `maxImageBytes` 绕过限制（如通过直接构造 `ImageAttachment`），可能 OOM。

**建议**: 在 `readLocalImage()` 中已做大小校验，但需确保 `processSingleImage` 路径前强制调用校验函数。

---

### 2.9 🟢 LOW — MIME 类型仅依赖 Magic Bytes，未做扩展名一致性校验

**位置**: `src/utils/image.ts:43-64`

```typescript
const ext = path.toLowerCase().split('.').pop() ?? '';
// fallback to extension-based mime
return mimeMap[ext] ?? 'application/octet-stream';
```

**影响**: 若攻击者将 PNG 改名为 `.jpg`，`detectMime` 会返回 `image/jpeg`，但实际数据是 PNG。部分 API（OpenAI）不严格校验 mime，但某些 endpoint 可能基于 mime 决定处理方式。

**建议**: Magic Bytes 与扩展名不一致时发出警告或拒绝。

---

### 2.10 🟢 LOW — `visionScreenshot` / `visionTrace` 接受任意路径

**位置**: `src/tools/index.ts:183, 211`

```typescript
export async function visionScreenshot(ctx: ToolContext, htmlPath: string): Promise<ToolResult>
export async function visionTrace(ctx: ToolContext): Promise<ToolResult>
```

**影响**: `htmlPath` 参数未通过 `PathPolicy` 校验。虽然后续需要 puppeteer 支持所以目前是占位符，但若未来实现时忘记加校验，会导致任意文件读取。

**建议**: 在当前阶段即加入 `pathPolicy.allowInput(htmlPath)` 校验并返回明确错误。

---

### 2.11 🟢 LOW — `processMessage` 未验证 attachments 来源

**位置**: `src/plugin/index.ts:65-72`

```typescript
const images = attachments.filter((a): a is { path: string; contentHash: string } =>
  typeof a === 'object' && a !== null && 'path' in a && 'contentHash' in a
);
```

**影响**: 仅检查 `path` 和 `contentHash` 字段存在，未校验 path 是否在允许目录内、未校验 `contentHash` 格式。恶意构造的 attachment 可能指向 workspace 外路径。

**建议**: 在 filter 中加入 `policy.allowInput(resolve(a.path))` 校验。

---

## 三、安全架构优势（正面评估）

1. **KV Cache 隔离设计合理**：图片处理在 DeepSeek 之前完成，不污染模型缓存，这是安全架构上的正确决策
2. **Circuit Breaker 实现规范**：按 failure kind 区分 TTL，AUTH 失败 10min，RATE_LIMIT 60s，设计合理
3. **Failover Chain 有超时控制**：`totalTimeoutMs` + `providerTimeoutMs` 双层超时，防止 hung request
4. **`isPrivateOrReserved()` 覆盖全面**：IPv4/IPv6 私网段检测完整，包含 multicast 和 reserved 段
5. **MIME magic bytes 校验**：防止伪造文件类型
6. **Schema 验证有边界检查**：`maxImageBytes > 25MB` 和 `maxImagePixels > 100MP` 有 warning

---

## 四、修复优先级建议

| 优先级 | 问题 | 估计工作量 |
|-------|------|-----------|
| P0 | Gemini API Key 入 URL Query String | 10 min |
| P0 | SSRF 防护函数接入 fetch 调用前 | 30 min |
| P1 | 错误信息脱敏（redactSecrets 接入） | 1h |
| P1 | PathPolicy symlink TOCTOU 修复 | 30 min |
| P1 | VisionBridge 内存缓存加 LRU 限制 | 1h |
| P2 | 并发图像处理限流 | 2h |
| P2 | `processMessage` attachments 来源校验 | 30 min |
| P3 | MIME 扩展名一致性校验 | 20 min |
| P3 | 占位工具预置路径校验 | 20 min |

---

## 五、总结

dsh-omnivision 的安全设计方向正确（KV Cache 隔离、Circuit Breaker、PathPolicy），但存在**防护代码未接入**的关键问题：`assertSafeRemoteTarget` 和 `redactSecrets` 两个重要安全函数定义后从未被调用，导致它们形同虚设。此外 Gemini API Key 直接出现在 URL 中是一个明确的 OWASP 违规项，需立即修复。

**整体安全评分: 62/100**（设计意图良好，但执行层有显著缺口）

---

*报告生成: Hermes Agent Security Review*
