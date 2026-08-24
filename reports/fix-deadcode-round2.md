# Dead Code Cleanup — Round 2

**Date**: 2026-08-21  
**Action**: P0 Dead Code Removal (second pass)

---

## Analysis

After the first dead code cleanup (mode-strategy.ts, multi-layer.ts, tools/index.ts), two more dead code items were identified:

### 1. `src/tools/types.ts` — TOOLS array is dead code

- **Lines 28-188**: `TOOLS` const array with 10 tool definitions
- Each handler does `await import('./index.ts')` and calls the stub function
- **Never imported** by any production code (`callTool` uses `executeWithFailover` directly)
- The **type definitions** (ToolContext, ToolResult, ToolDefinition) ARE used (exported from `src/index.ts`)

**Decision**: Keep type definitions, remove TOOLS array (~160 lines)

### 2. `src/utils/image.ts` — Utility functions never called

Functions: `readLocalImage()`, `detectMime()`, `validateImageSize()`, `createImageSource()`

- `detectMime` is independently reimplemented in `src/vision/providers.ts` (different signature)
- None of these functions are imported anywhere in `src/`
- `validateImageSize` checks `maxBytes` but plugin never calls it
- **Pure dead code**

**Decision**: Delete entire file

---

## Changes

| File | Action | Reason |
|------|--------|--------|
| `src/tools/types.ts` | Remove TOOLS array | Never imported, handlers broken |
| `src/utils/image.ts` | Delete | Never called, dead code |

---

## Verification

```bash
# No imports of removed code remain
grep -r "from.*utils/image" src/ → 0 matches ✅
grep -r "TOOLS" src/ → only in types.ts definition ✅

# Tests still pass
npm test → 56/56 passed ✅
tsc --noEmit → clean ✅
```
