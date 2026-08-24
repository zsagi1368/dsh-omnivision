# Dead Code Fix Report — DSH Omnivision

**Date**: 2026-08-21  
**Action**: P0 Dead Code Cleanup

---

## Summary

Analyzed three suspected dead-code modules and took action based on import analysis and architectural review.

---

## Files Deleted

| File | Reason | Lines Removed |
|------|--------|---------------|
| `src/bridge/mode-strategy.ts` | Never imported anywhere in src/ or tests. Plugin has its own `processMessage()` in `plugin/index.ts` | 139 |
| `src/cache/multi-layer.ts` | Never imported by production code. Only referenced by a single integration test (`cache-performance.test.ts`) which was also deleted. `VisionBridge` uses simple in-memory Map, not these classes. | 265 |
| `src/tools/index.ts` | Never imported. `callTool()` routes through `executeWithFailover()` directly; the tool dispatch table in `types.ts` referenced this file's exports but they were never called at runtime. | 153 |
| `tests/integration/cache-performance.test.ts` | Dependent on deleted `multi-layer.ts`; no replacement coverage needed. | 76 |

**Total**: ~633 lines of dead code removed

---

## Files Modified

### `src/tools/types.ts`
- Removed the `TOOLS` array (169 lines) which contained lazy-import handlers pointing to the deleted `tools/index.ts`
- Kept interface definitions (`ToolContext`, `ToolResult`, `ToolDefinition`) — still re-exported from `src/index.ts`
- Replaced inline `import()` type for `VisionBridge` with a proper top-level import

### `README.md`
- Updated project tree to remove `mode-strategy.ts` and `tools/index.ts` entries
- Added missing `config/`, `plugin/`, `resilience/` sections that were collapsed

### `README.zh-CN.md`
- Same tree fix as README.md, in Chinese

### `reports/PROJECT-COMPLETE.md`
- Marked **Mode Strategy** as ❌ 已删除（死代码）
- Updated file tree to reflect current structure

---

## Verification

```
✓ 7 test files passed (53 tests)
✗ TypeScript typecheck: 1 unrelated error (missing detect-mime types — pre-existing)
```

No new failures introduced by this cleanup.

---

## Architecture Notes

The project already implements its functional alternatives:

| Dead Module | Active Alternative |
|-------------|-------------------|
| `mode-strategy.ts` | `plugin/index.ts::processMessage()` — handles auto mode inline |
| `cache/multi-layer.ts` | `VisionBridge` internal `Map` cache (session-scoped, no disk layer) |
| `tools/index.ts` | `plugin/index.ts::callTool()` delegates to `executeWithFailover()` + providers |

The `ToolContext`/`ToolResult`/`ToolDefinition` types in `src/tools/types.ts` are kept as public exports for downstream consumers.

---

## Decision Rationale

**All deletion (no wiring)** was chosen because:
1. Zero production code imports any of these files
2. The plugin's own implementation in `plugin/index.ts` provides equivalent functionality
3. Wiring would require architectural changes (exposing `callTool` handlers, adding a real cache layer) that go beyond dead-code cleanup scope
4. The project is in a release-ready state; adding unused infrastructure increases maintenance burden

If these features are needed in the future, they should be implemented through the existing plugin entry point rather than resurrecting old disconnected modules.
