# dsh-omnivision 深度安全验证报告（Round 3）

**审查日期**: 2026-08-21  
**审查范围**: `/home/z/dsh-omnivision/src` 全部源文件 + 测试覆盖验证 + 依赖审计  
**前置条件**: Round 1 (2026-08-21) + Round 2 (2026-08-21) 审查报告已生成  
**测试状态**: 57 测试全部通过 ✅ (8 测试文件)

---

## 一、总体评估

| 风险维度 | Round 1 | Round 2 | Round 3 | 变化 |
|---------|---------|---------|---------|------|
| SSRF 防护 | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 仅 OpenAI 接入，其余 4 个 provider 未调用 |
| 路径验证 | 🟡 MEDIUM | 🔴 HIGH | 🔴 HIGH | PathPolicy 与 readFileAsBase64 策略不一致仍存 |
| 凭据脱敏 | 🔴 HIGH | 🔴 HIGH | 🟡 MEDIUM | redactSecrets 已接入 chain.ts/tools，但 getKnownSecrets 有盲区 |
| 凭据安全 | 🔴 HIGH | 🔴 HIGH | ✅ FIXED | Gemini API Key 已改用 Header（round2 报告有误） |
| 错误信息泄露 | 🟡 MEDIUM | 🟡 MEDIUM | 🟡 MEDIUM | classifyError 仍泄露内部细节 |
| 资源/并发 | 🟡 MEDIUM | 🟡 MEDIUM | 🟡 MEDIUM | 内存缓存无上限，fetch 无 provider 级超时 |
| 附件校验 | 🟢 LOW | 🟢 LOW | 🔴 HIGH | processMessage 完全未校验附件路径 |
| 符号链接 | 🟡 MEDIUM | 🟡 MEDIUM | 🟡 MEDIUM | TOCTOU 仍然存在 |

**整体安全评分: 55/100**（较 Round 2 的 58/100 下降，因发现新的高风险问题）

---

## 二、Round 1/2 问题修复状态验证

### 2.1 ✅ 已修复 — Gemini API Key 入 URL Query String（Round 2 报告有误）

**Round 2 报告声称未修复**，但实际代码已修复：

```typescript
// src/vision/providers.ts:129-131 — 实际使用 Header 认证
const response = await fetch('https://generativelanguage.googleapis.com/...', {
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
  ...
});
```

**验证**: `grep "?key=\${apiKey}" src/vision/providers.ts` → 0 结果 ✅

---

### 2.2 ⚠️ 部分修复 — 错误信息标准化

**providers.ts**: ✅ 已修复，catch 块统一返回 `'API_ERROR'`/`'AUTH_MISSING'`

**chain.ts**: ⚠️ `classifyError()` 仍泄露内部细节：
```typescript
// src/vision/chain.ts:94-103
return { kind: 'TIMEOUT', code: 'VISION_CANCELLED', message: 'Request cancelled', ... };
return { kind: 'TIMEOUT', code: 'VISION_TIMEOUT', message: 'Provider timeout', ... };
return { kind: 'NETWORK', code: 'VISION_NETWORK_ERROR', message: 'Network error', ... };
```
虽然不直接泄露 key，但 `"Request cancelled"`、`"Provider timeout"` 等内部状态被传递给调用方（LLM）。

**tools/index.ts**: ✅ 已通过 `safeError()` 调用 `redactSecrets()`

---

### 2.3 ❌ 未修复 — SSRF 防护函数覆盖不全

**现状**: `assertSafeRemoteTarget()` 仅在 OpenAI provider 中调用：

```typescript
// src/vision/providers.ts:54
await assertSafeRemoteTarget('https://api.openai.com');
```

其余 4 个 provider（Anthropic、Gemini、OVH、Zhipu）均**未调用**该函数。

**影响**: 
- 当前所有 fetch URL 均为硬编码固定域名，暂无 SSRF 风险
- 但若未来引入用户可配置的 endpoint 或 `visionScreenshot` 支持 URL 加载，将完全暴露
- 安全函数形同虚设，违反"纵深防御"原则

---

### 2.4 ❌ 未修复 — PathPolicy 与 readFileAsBase64 路径策略不一致

**PathPolicy** (`src/security/index.ts`):
```typescript
// 允许 workspace + tempDir + allowedDirs
resolved.startsWith(this.workspace) ||
resolved.startsWith(this.tempDir) ||
[...this.allowedDirs].some(d => resolved.startsWith(d))
```

**readFileAsBase64** (`src/vision/providers.ts:11,36`):
```typescript
const ALLOWED_PATHS = ['/tmp', '/private/tmp', '/home', process.env.HOME ?? '/home'];
const isAllowed = ALLOWED_PATHS.some(p => resolved.startsWith(p));
```

**问题**: 
1. `readFileAsBase64` 不允许 workspace 路径（用户图片通常在 workspace 下）
2. 路径白名单使用硬编码列表，而非传入 PathPolicy
3. 两者逻辑不一致，导致功能 bug + 安全边界混乱

---

### 2.5 ❌ 未修复 — VisionBridge 内存缓存无上限

**位置**: `src/bridge/vision-bridge.ts:31`

```typescript
private completedResults = new Map<string, CacheEntry>(); // 无大小限制
```

**配置中定义但未使用**:
```typescript
// src/config/schema.ts:40-41
cacheMaxEntries: number;  // 默认 200
cacheMaxBytes: number;    // 默认 512MB
```

**影响**: 单 session 处理大量图片时，内存无界增长，可能导致 OOM。

---

### 2.6 ❌ 未修复 — rejectSymlink TOCTOU 竞争条件

**位置**: `src/security/index.ts:77-88`

```typescript
rejectSymlink(path: string): void {
  try {
    const stats = lstatSync(path);  // ← TOCTOU: 检查和读取之间可能被替换
    if (stats.isSymbolicLink()) {
      throw new Error(`PATH_SYMLINK_DENIED...`);
    }
  } catch (...) { ... }
}
```

**问题**: `allowInput()` 检查后到 `readFileSync()` 之间，文件可能被替换为 symlink。

---

## 三、Round 3 新增发现

### 3.1 🔴 HIGH — processMessage 未校验附件路径

**位置**: `src/plugin/index.ts:61-63`

```typescript
const images = attachments.filter((a): a is { path: string; contentHash: string } =>
  typeof a === 'object' && a !== null && 'path' in a && 'contentHash' in a
);
```

**问题**: 
- 仅检查字段存在性，**未校验 path 是否在允许目录内**
- 恶意构造的 attachment 可指向任意路径（如 `/etc/passwd`）
- 后续 `readFileAsBase64` 的路径白名单会拒绝非 `/tmp`/`/home` 路径，但这不是安全设计

**攻击场景**:
```typescript
// 恶意构造的 attachment
{ path: '/etc/shadow', contentHash: 'abc123' }
// → readFileAsBase64 会拒绝（不在 ALLOWED_PATHS）
// → 但如果 ALLOWED_PATHS 被修改，将泄露系统文件
```

---

### 3.2 🔴 HIGH — getKnownSecrets 盲区

**位置**: `src/security/index.ts:135-145`

```typescript
export function getKnownSecrets(): string[] {
  const secrets: string[] = [];
  const keyNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ZAI_API_KEY'];
  for (const name of keyNames) {
    const value = process.env[name];
    if (value && value.length > 10) {
      secrets.push(value);
    }
  }
  return secrets;
}
```

**问题**: 
- 硬编码 4 个环境变量名
- 未检查自定义 provider 的 `apiKeyEnv` 配置
- 若用户配置了 `apiKeyEnv: 'MY_CUSTOM_KEY'`，该 key 不会被纳入脱敏范围

**影响**: 自定义 provider 的 API Key 可能在错误信息中泄露。

---

### 3.3 🟡 MEDIUM — 所有 provider 的 fetch 无超时

**位置**: `src/vision/providers.ts`

```typescript
// OpenAI: line 65
const response = await fetch('https://api.openai.com/v1/chat/completions', {
  ...
  signal: options.signal,  // ← 仅依赖外部 AbortSignal
});
```

**问题**: 
- `options.signal` 来自上层 `VisionExecuteOptions.signal`
- 若调用方未传递 signal，则 fetch 无限等待
- `providerTimeoutMs` 仅在 `executeWithFailover` 中计算，但未传递给 fetch 的 `signal`

**影响**: 单个 provider 挂起会导致整个 failover 链阻塞，直到 totalTimeout 触发。

---

### 3.4 🟡 MEDIUM — detectMime 扩展名一致性校验缺失

**位置**: `src/utils/image.ts:54-80`

```typescript
export function detectMime(buffer: Buffer, path?: string): string {
  // Try magic bytes first
  for (const sig of IMAGE_SIGNATURES) {
    if (buffer.length >= sig.magic.length && buffer.subarray(0, sig.magic.length).equals(sig.magic)) {
      return sig.mime;
    }
  }
  // Fallback to extension
  if (path) {
    const ext = path.toLowerCase().split('.').pop() ?? '';
    const mimeMap: Record<string, string> = { ... };
    return mimeMap[ext] ?? 'application/octet-stream';
  }
  return 'application/octet-stream';
}
```

**问题**: 当 magic bytes 未匹配时，fallback 到扩展名，但未校验扩展名与实际内容是否一致。

**攻击场景**: 攻击者将 SVG 恶意文件重命名为 `.png`，magic bytes 不匹配，fallback 到扩展名返回 `image/png`，某些 API 可能基于 mime 决定处理方式。

---

### 3.5 🟢 LOW — 占位工具预置路径漏洞

**位置**: `src/tools/index.ts:138-140, 118-120`

```typescript
export async function visionScreenshot(ctx: ToolContext, htmlPath: string): Promise<ToolResult> {
  return { ok: false, error: 'vision_screenshot requires optional dependency: puppeteer-core' };
}
```

**问题**: `htmlPath` 参数未通过任何路径校验。若未来实现时忘记加校验，将直接导致任意文件读取。

---

## 四、测试覆盖验证

### 4.1 安全函数调用覆盖

| 函数 | 定义位置 | 调用位置 | 测试覆盖 | 状态 |
|-----|---------|---------|---------|------|
| `isPrivateOrReserved` | security/index.ts:11 | tests/security/index.test.ts | ✅ | 已测试 |
| `assertSafeRemoteTarget` | security/index.ts:31 | src/vision/providers.ts:54 (仅 OpenAI) | ⚠️ | 部分测试 |
| `PathPolicy` | security/index.ts:52 | 无直接调用 | ❌ | 无集成测试 |
| `redactSecrets` | security/index.ts:98 | chain.ts:69, tools/index.ts:23 | ✅ | 已测试 |
| `redactUrl` | security/index.ts:118 | 无调用 | ❌ | 仅单元测试 |
| `getKnownSecrets` | security/index.ts:135 | chain.ts:23, tools/index.ts:20 | ⚠️ | 无针对性测试 |

### 4.2 测试统计

```
✓ tests/bridge/message-rewriter.test.ts     (6 tests)
✓ tests/security/index.test.ts              (8 tests)
✓ tests/utils/image.test.ts                 (6 tests)
✓ tests/integration/e2e-workflows.test.ts   (8 tests)
✓ tests/integration/security-integration.test.ts (10 tests)
✓ tests/bridge/vision-bridge.test.ts        (8 tests)
✓ tests/resilience/circuit.test.ts          (6 tests)
✓ tests/integration/cache-performance.test.ts (5 tests)

总计: 57 tests passed (8 files)
```

### 4.3 缺失的安全测试

- ❌ SSRF 防护跨 provider 测试（仅测试 OpenAI）
- ❌ PathPolicy 与 readFileAsBase64 一致性测试
- ❌ processMessage 附件路径校验测试
- ❌ getKnownSecrets 自定义 apiKeyEnv 测试
- ❌ fetch 超时行为测试
- ❌ symlink TOCTOU 测试

---

## 五、安全架构优势（正面评估）

1. ✅ **KV Cache 隔离设计正确**：图片处理在 DeepSeek 之前完成，不污染模型缓存
2. ✅ **Circuit Breaker 实现规范**：按 failure kind 区分 TTL，AUTH 失败 10min，RATE_LIMIT 60s
3. ✅ **Failover Chain 有总超时控制**：`totalTimeoutMs` + `providerTimeoutMs` 双层超时
4. ✅ **isPrivateOrReserved() 覆盖全面**：IPv4/IPv6 私网段检测完整
5. ✅ **MIME magic bytes 校验**：防止伪造文件类型
6. ✅ **redactSecrets 三层脱敏**：精确匹配 + Token 形状 + URL userinfo
7. ✅ **57 测试全部通过**：基础功能稳定

---

## 六、修复优先级建议（Round 3）

| 优先级 | 问题 | Round 2 状态 | 估计工作量 |
|-------|------|-------------|-----------|
| P0 | processMessage 未校验附件路径 | ❌ 未修复 | 20 min |
| P0 | SSRF 防护覆盖所有 provider | ❌ 未修复 | 30 min |
| P1 | PathPolicy 与 readFileAsBase64 策略统一 | ❌ 未修复 | 30 min |
| P1 | getKnownSecrets 支持自定义 apiKeyEnv | ❌ 未修复 | 15 min |
| P1 | VisionBridge 内存缓存加 LRU 限制 | ❌ 未修复 | 1h |
| P2 | fetch 添加 provider 级超时 | ❌ 未修复 | 30 min |
| P2 | classifyError 错误信息标准化 | ⚠️ 部分 | 20 min |
| P2 | rejectSymlink TOCTOU 修复 | ❌ 未修复 | 30 min |
| P3 | detectMime 扩展名一致性校验 | ❌ 未修复 | 15 min |
| P3 | 占位工具预置路径校验 | ❌ 未修复 | 10 min |

---

## 七、依赖安全审计

```
npm audit --production
```

**结果**: 项目依赖极简，仅 `@deepseek-ai/schemastery` 一个生产依赖，无已知高危漏洞。

---

## 八、总结

**Round 1 提出的 11 个问题中**:
- ✅ Gemini API Key 已修复（Round 2 报告有误）
- ✅ providers.ts 错误信息标准化已修复
- ✅ redactSecrets 已接入 chain.ts 和 tools/index.ts
- ❌ 其余 8 个问题均未修复

**Round 2 提出的 5 个新问题中**:
- ❌ PathPolicy 不一致仍存
- ❌ SSRF 防护未覆盖
- ❌ 内存缓存无上限
- ❌ classifyError 泄露细节
- ❌ TOCTOU 未修复

**Round 3 新增 5 个问题**:
- 🔴 processMessage 附件路径未校验（高风险）
- 🔴 getKnownSecrets 盲区
- 🟡 fetch 无 provider 级超时
- 🟡 detectMime 一致性缺失
- 🟢 占位工具预置漏洞

**建议**: Round 4 应优先修复 P0 问题（附件校验 + SSRF 全覆盖），然后处理 P1 问题。建议补充安全测试覆盖，特别是路径校验和 SSRF 防护的集成测试。

---

*报告生成: Hermes Agent Security Review — Deep Validation Round 3*
