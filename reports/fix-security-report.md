# Security Fix Report

**Date**: 2026-08-21  
**Scope**: DSH Omnivision — path whitelist, SSRF prevention, backdoor removal, cross-platform tests

---

## Changes Summary

### 1. `src/vision/providers.ts` — Path whitelist + SSRF hardening

| Issue | Before | After |
|-------|--------|-------|
| ALLOWED_PATHS too broad | `['/tmp', '/private/tmp', '/home', process.env.HOME]` — any file in user's home could be read | Removed entirely |
| `readFileAsBase64` signature | Accepted optional `allowedPaths` param, merged with global `ALLOWED_PATHS` | Accepts `allowedRoots: string[]` — caller-controlled roots only (now `['/tmp']`) |
| SSRF on `fetch` | No redirect restriction; default `follow: 'auto'` follows 3xx redirects to arbitrary URLs | All 5 providers now include `redirect: 'manual'` — blocks automatic redirect following |
| MIME/bytes passed to providers | Always `'image/png'` and `0` | Now passes `img.mime` and `img.bytes` from caller |

### 2. `src/plugin/index.ts` — Backdoor removal + real MIME/bytes

| Issue | Before | After |
|-------|--------|-------|
| Global mock backdoor | `(globalThis as any).__MOCK_PROVIDER__` — any code could inject a provider | Removed. Mock providers now injected via `PluginContext.extraProviders` |
| Fake MIME/bytes | Always `'image/png'` and `0` — providers couldn't validate file size or type | Reads `mime` and `bytes` from attachment metadata; falls back to extension detection + `fs.statSync` |
| Error handling on all-fail | Returned empty descriptions with no indication of failure | Returns `hasErrors: true` and includes `[Vision error: ...]` markers in output |

### 3. `src/security/index.ts` — Path policy segment comparison

| Issue | Before | After |
|-------|--------|-------|
| Prefix-only check | `resolved.startsWith(this.workspace)` — `/home/user/workspace-evil` would pass | `path.relative()` comparison: exact match or subpath only; `..` segments that escape the root are rejected |
| Same for temp dir | `resolved.startsWith(this.tempDir)` | `relative(tempDir, resolved)` must not start with `..` |

The new `allowInput` logic:
```ts
const inWorkspace = resolved === this.workspace ||
  (relative(this.workspace, resolved).length > 0 &&
   !relative(this.workspace, resolved).startsWith('..') &&
   !relative(this.workspace, resolved).startsWith('~'));
```

### 4. `tests/integration/e2e-workflows.test.ts` — Cross-platform paths

| Issue | Before | After |
|-------|--------|-------|
| Hardcoded `/tmp` | Tests used `/tmp/test.png`, `/tmp/workspace` directly | Uses `join(os.tmpdir(), ...)` — works on Linux, macOS, and Windows |
| Hardcoded `/home/user/workspace` | `workspace: '/home/user/workspace'` | `workspace: join(tmpdir(), 'dsh-omnivision-test-workspace')` |
| `globalThis.__MOCK_PROVIDER__` | Mock injected via globalThis, cleaned up in `afterAll` | Mock injected via `extraProviders` in `PluginContext`; no global mutation needed |

### 5. `tests/bridge/vision-bridge.test.ts` — Updated expectations

| Change | Reason |
|--------|--------|
| "should return empty array when all providers fail" → "should return error description when all providers fail" | Bridge now returns `{ summary: '[Vision error: ...]' }` instead of throwing |
| Failover test mock error: `'Connection refused'` is now classified as retryable (NETWORK) | Chain classifier updated to also match `'refused'` in error messages |

### 6. `src/vision/chain.ts` — Error classification fix

Added `'refused'` and `'econnrefused'` to the NETWORK error classification so `Connection refused` errors are retryable (not terminal), enabling proper failover between providers.

### 7. `src/bridge/vision-bridge.ts` — Pass mime/bytes to providers

Updated `processSingleImage` to pass `mime` and `bytes` from `ImageAttachment` into the `VisionExecuteOptions.images` array.

---

## Test Results

```
Test Files  7 passed (7)
Tests       56 passed (56)
Duration    361ms
```

All 56 tests pass including the 12 e2e workflow tests, 8 bridge tests, and 10 security integration tests.

---

## Files Modified

1. `src/vision/providers.ts` — path whitelist, SSRF, MIME/bytes
2. `src/plugin/index.ts` — backdoor removal, real MIME/bytes, error handling
3. `src/security/index.ts` — segment-level path comparison
4. `src/bridge/vision-bridge.ts` — pass mime/bytes to providers
5. `src/vision/chain.ts` — classify 'Connection refused' as retryable NETWORK
6. `tests/integration/e2e-workflows.test.ts` — cross-platform paths, mock injection
7. `tests/bridge/vision-bridge.test.ts` — updated expectations
