# dsh-omnivision 安全专项审查报告（Round 2）

**审查日期**: 2026-08-21  
**审查范围**: `/home/z/dsh-omnivision/src` 全部源文件 + 测试覆盖验证  
**前置条件**: 第一轮审查报告 `reports/security-review-round1.md` 已生成  
**测试状态**: 34 测试全部通过 ✅  

---

## 一、总体评估

| 风险维度 | Round 1 评级 | Round 2 评级 | 变化 |
|---------|-------------|-------------|------|
| SSRF 防护 | 🔴 HIGH | 🔴 HIGH | 无变化，防护函数仍未接入 |
| 凭据安全 | 🔴 HIGH | 🔴 HIGH | Gemini Key 仍在 URL 中 |
| 路径验证 | 🟡 MEDIUM | 🔴 HIGH | 发现逻辑 Bug：workspace 路径被拒绝 |
| 凭据脱敏 | 🔴 HIGH | 🔴 HIGH | redactSecrets/redactUrl 仍未调用 |
| 错误信息泄露 | 🟡 MEDIUM | 🟡 MEDIUM | chain.ts/tools 仍透传原始错误 |
| 资源/并发 | 🟡 MEDIUM | 🟡 MEDIUM | 未修复 |

**整体安全评分: 58/100**（较 Round 1 的 62/100 下降，因发现新的路径验证 Bug）

---

## 二、Round 1 问题修复状态验证

### 2.1 ✅ 已修复 — readFileAsBase64 添加路径白名单 + 文件大小限制

**位置**: `src/vision/providers.ts:9-44`

```typescript
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB ✅
const ALLOWED_PATHS = ['/tmp', '/private/tmp']; // ⚠️ 见 2.1.1

function readFileAsBase64(path: string): string {
  const resolved = resolve(path);
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
- ✅ 路径白名单已实现
- ✅ 文件大小限制已实现（25MB）
- ❌ 但路径逻辑有严重 Bug（见 2.1.1）

#### 2.1.1 🔴 新发现 — 路径白名单逻辑错误

`ALLOWED_PATHS` 仅包含 `/tmp` 和 `/private/tmp`，但 `readLocalImage` 在 `src/utils/image.ts:30` 使用 `PathPolicy.allowInput()` 允许 workspace 路径。两者不一致：

```typescript
// src/utils/image.ts:30 — 允许 workspace 路径
export async function readLocalImage(path: string, policy: { allowInput: (p: string) => boolean })

// src/vision/providers.ts:36 — 只允许 /tmp！
const isAllowed = ALLOWED_PATHS.some(p => resolved.startsWith(p)) || resolved.startsWith('/tmp');
```

**影响**: 用户实际部署时，图片路径（通常在 workspace 下）会被 `readFileAsBase64` 拒绝，导致所有图片处理失败。这是一个**功能性 Bug**，同时造成安全边界不一致。

**建议**: 
1. `ALLOWED_PATHS` 应包含 workspace 目录
2. 统一路径验证逻辑，将 `PathPolicy` 传入 providers 或使用统一路径策略

---

### 2.2 ⚠️ 部分修复 — 错误信息标准化

**修复内容**: `providers.ts` 中的 catch 块已统一为 `'API_ERROR'`/`'AUTH_MISSING'`/`'NETWORK_ERROR'`

```typescript
// ✅ providers.ts — 已修复
catch (error) {
  return buildFailureResponse(0, 'API_ERROR');  // 不再泄露原始错误
}
```

**未修复**: `chain.ts` 和 `tools/index.ts` 仍透传原始错误消息

```typescript
// src/vision/chain.ts:95-107 — 仍泄露 error.message
return { kind: 'TIMEOUT', code: 'VISION_CANCELLED', message: error.message, ... };
return { kind: 'NETWORK', code: 'VISION_NETWORK_ERROR', message: error.message, ... };

// src/tools/index.ts:29 — 仍返回原始错误
return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
```

**影响**: 错误信息通过工具返回给调用方（LLM），可能泄露 DNS 记录、网络连接细节等。

---

### 2.3 ❌ 未修复 — SSRF 防护函数仍未接入

**检查**: `grep -rn "assertSafeRemoteTarget" src/` → 仅在 `security/index.ts` 定义，**无任何调用**

```typescript
// src/security/index.ts:43 — 函数存在但未使用
export async function assertSafeRemoteTarget(url: string): Promise<{ ip: string; url: URL }>
```

**影响**: 当前所有 `fetch()` 调用均为硬编码固定域名（`api.openai.com`、`api.anthropic.com` 等），暂无 SSRF 风险。但若未来引入用户可配置的 endpoint 或 `visionScreenshot` 实现 URL 加载，将完全暴露。

**优先级**: 应将 API base URL 改为硬编码白名单，禁止用户配置任意 endpoint。

---

### 2.4 ❌ 未修复 — 凭据脱敏函数未接入

**检查**: `grep -rn "redactSecrets\|redactUrl" src/` → 仅在 `security/index.ts` 定义，**无任何调用**

```typescript
// src/security/index.ts:122,146 — 函数存在但未使用
export function redactSecrets(text: string, knownSecrets: string[]): string
export function redactUrl(url: string): string
```

**影响**: 
- `chain.ts:95` 将 `error.message` 直接返回，若错误消息包含 API Key（如连接字符串），会泄露
- `tools/index.ts` 将原始错误返回给 LLM，可能泄露内部网络信息
- 无日志脱敏机制

---

## 三、Round 2 新增发现

### 3.1 🔴 HIGH — Gemini API Key 仍在 URL Query String 中

**位置**: `src/vision/providers.ts:126`

```typescript
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
  ...
);
```

**Round 1 建议**: 改用 `x-goog-api-key` Header

```typescript
headers: {
  'Content-Type': 'application/json',
  'x-goog-api-key': apiKey,  // Google 推荐方式
}
```

**实际状态**: 未修改，仍使用 `?key=${apiKey}` 方式

**影响**: 
- API Key 出现在请求 URL 中
- 可能被 CDN/代理日志记录（Google Cloud 日志、中间代理）
- 违反 OWASP API Security Top 10

---

### 3.2 🟡 MEDIUM — PathPolicy symlink TOCTOU 未修复

**位置**: `src/security/index.ts:99-112`

```typescript
rejectSymlink(path: string): void {
  const stats = fs.lstatSync(path);      // ← 仍存在 TOCTOU
  if (stats.isSymbolicLink()) {
    throw new Error(`PATH_SYMLINK_DENIED...`);
  }
}
```

**问题**: `allowInput()` 检查 path 是否在允许目录内，然后 `readFile` 读取 — 中间可能被替换为 symlink

**建议**: 使用 `fs.open()` + `O_NOFOLLOW` flag 或在读取前统一做一次 symlink 检查

---

### 3.3 🟡 MEDIUM — VisionBridge 内存缓存无上限

**位置**: `src/bridge/vision-bridge.ts:31`

```typescript
private completedResults = new Map<string, CacheEntry>();  // 无大小限制
```

**配置中的限制未被使用**: schema 中定义 `cacheMaxEntries: 200`、`cacheMaxBytes: 512MB`，但 `VisionBridge` 不使用这些配置。

---

### 3.4 🟢 LOW — processMessage attachments 未校验路径

**位置**: `src/plugin/index.ts:54-56`

```typescript
const images = attachments.filter((a): a is { path: string; contentHash: string } =>
  typeof a === 'object' && a !== null && 'path' in a && 'contentHash' in a
);
```

**影响**: 仅检查字段存在，未校验 path 是否在允许目录内。恶意构造的 attachment 可能指向 workspace 外路径。

---

## 四、代码覆盖率验证

### 4.1 安全函数调用覆盖

| 函数 | 定义位置 | 调用位置 | 状态 |
|-----|---------|---------|------|
| `isPrivateOrReserved` | security/index.ts:10 | tests/security/index.test.ts | ✅ 已测试 |
| `assertSafeRemoteTarget` | security/index.ts:43 | 无 | ❌ 未调用 |
| `PathPolicy` | security/index.ts:71 | 无 | ❌ 未使用 |
| `redactSecrets` | security/index.ts:122 | 无 | ❌ 未调用 |
| `redactUrl` | security/index.ts:146 | 无 | ❌ 未调用 |

### 4.2 测试覆盖

```
✓ tests/bridge/message-rewriter.test.ts (6 tests)
✓ tests/security/index.test.ts (8 tests)  — 仅测试 security/index.ts 导出函数
✓ tests/utils/image.test.ts (6 tests)
✓ tests/bridge/vision-bridge.test.ts (8 tests)
✓ tests/resilience/circuit.test.ts (6 tests)

总计: 34 tests passed
```

**缺失测试**:
- `readFileAsBase64` 路径白名单验证（无 provider 测试）
- Gemini API Key header 方式测试
- 错误信息脱敏测试

---

## 五、修复优先级建议（Round 2）

| 优先级 | 问题 | 状态 | 估计工作量 |
|-------|------|------|-----------|
| P0 | Gemini API Key 入 URL Query String | ❌ 未修复 | 10 min |
| P0 | PathPolicy 与 readFileAsBase64 不一致（workspace 被拒绝） | ❌ 未修复 | 20 min |
| P1 | SSRF 防护函数接入 fetch 调用前 | ❌ 未修复 | 30 min |
| P1 | redactSecrets 接入 error.message 处理链 | ❌ 未修复 | 1h |
| P1 | chain.ts/tools 错误信息标准化 | ⚠️ 部分修复 | 30 min |
| P2 | PathPolicy symlink TOCTOU 修复 | ❌ 未修复 | 30 min |
| P2 | VisionBridge 内存缓存加 LRU 限制 | ❌ 未修复 | 1h |
| P3 | processMessage attachments 来源校验 | ❌ 未修复 | 20 min |

---

## 六、总结

**Round 1 提出的 11 个问题中，仅有 2 个得到部分修复**：
1. ✅ `readFileAsBase64` 添加了文件大小限制（但路径白名单有 Bug）
2. ✅ `providers.ts` 错误信息标准化为 API_ERROR/AUTH_MISSING

**Round 1 其余 9 个问题均未修复**，包括两个 P0 问题：
- 🔴 Gemini API Key 仍在 URL 中
- 🔴 SSRF 防护和凭据脱敏函数均未接入实际代码路径

**新增发现**:
- 🔴 `readFileAsBase64` 的路径白名单只允许 `/tmp`，会导致所有 workspace 图片被拒绝
- 🟡 `chain.ts` 和 `tools/index.ts` 仍透传原始错误消息

**建议**: Round 3 应优先修复 P0 问题，并补充 provider 层面的安全测试。

---

*报告生成: Hermes Agent Security Review*
