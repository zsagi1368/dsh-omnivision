# Round 3 Fix Report — dsh-omnivision

**Date**: 2026-08-21
**Scope**: resolution of all round-1 review findings (code / architecture / security),
repair of the round-2 regression, round-3 feature additions, documentation alignment.
**Method**: every item below was verified against the current source tree
(`src/config/schema.ts`, `src/plugin/index.ts`, `src/vision/*`, `src/bridge/*`,
`src/security/index.ts`, `src/resilience/circuit.ts`, `src/tools/index.ts`) — not against
review prose.

---

## 1. Round-1 findings → resolution

Round 1 produced ~23 actionable issues across three review reports. Status:

| # | Round-1 finding | Resolution | Where / evidence |
|---|---|---|---|
| 1 | Vite build broken — `node:` builtins browser-externalized (`__vite-browser-external` stubs) | **Fixed** | `vite.config.ts` externalizes `builtinModules` (+ `node:` forms) and runtime/optional deps (`@deepseek-ai/*`, `sharp`, `puppeteer-core`, `potrace`); `dist/index.js` (ESM, node22 target) builds |
| 2 | Biome 2.x config crash (v1-style options) | **Fixed** | `biome.json` migrated: `files.includes`, `assist.actions.source.organizeImports`; `biome check src` exits 0 |
| 3 | Dangling `package.json` references (`bin`, release tooling, `packageManager`) | **Fixed** | Fields removed; `prepublishOnly` is plain `npm run build`; `files` matches shipped artifacts (dist, docs, patch, READMEs, LICENSE) |
| 4 | Dead modules: `modes/mode-strategy`, `cache/multi-layer`, `utils/image` | **Removed** | Never wired into the runtime; the single LRU in `VisionBridge` is the one real cache. (Empty leftover dirs `src/lib`, `src/models`, `src/modes` contain no files) |
| 5 | Decorative config (fields declared but never read) | **Fixed** | `cacheTtlSeconds` / `cacheMaxEntries` / `timeoutMs` / `visionTaskTimeoutMs` / `cache` / `mode` / `language` / `visionDepth` all drive runtime behavior; fields that would have stayed decorative were removed from the schema (`downscale`, `downscaleMaxPixels`, `artifactsDir`, `ocrTimeoutMs`, `cacheMaxBytes`) |
| 6 | `__MOCK_PROVIDER__` global backdoor in providers | **Removed** | Replaced by the `PluginContext.extraProviders` injection seam (first in the chain, test-only usage) |
| 7 | `startsWith` prefix collisions in path whitelist (`/tmp-evil` matched `/tmp`) | **Fixed** | `isPathAllowed` is segment-aware via `path.relative`; root-equal paths denied |
| 8 | `$HOME` inside the read whitelist | **Removed** | Read roots are workspace + `os.tmpdir()` (+ segment-checked `/tmp`, `/private/tmp` at the provider layer) |
| 9 | No timeout enforcement (`timeoutMs` declared, never applied) | **Fixed** | Chain composes `AbortSignal.timeout(providerTimeoutMs)` with the caller signal; per-provider budget = `min(visionTaskTimeoutMs, totalTimeoutMs − elapsed)`; total budget checked per iteration |
| 10 | Circuit breaker non-persistent (new instance per call, trips never accumulated) | **Fixed** | Breaker owned by the `OmniVisionPlugin` instance and passed into every chain execution; capacity-bounded (128 entries, evicts earliest-blocked) |
| 11 | Cache key contained the raw user message | **Fixed** | Key = `sha256(sessionId \| mode \| contentHash \| query)` where query is the stable template from `language`+`visionDepth`; full hash, no truncation |
| 12 | Error text polluting model-visible content | **Fixed** | `ProcessMessageResult.failures` API; bridge returns successes/failures separately; all-fail → `rewritten:false`, `newContent` = original; failures never rendered as markers |
| 13 | Misleading tool implementations (fake successes) | **Fixed** | `vision_crop` / `vision_pixel_diff` are real sharp implementations with graceful dependency errors; `vision_trace` / `vision_screenshot` return explicit not-implemented errors; `vision_colors` removed entirely |
| 14 | Tests platform-locked (Unix-only `/tmp` assumptions) | **Fixed** | Suite rebuilt cross-platform by the parallel TEST agent (see §2) |
| 15 | Hardcoded provider singletons; config `baseUrl` / `model` / `apiKeyEnv` ignored | **Fixed** | Provider factories (`createOpenAIProvider`, `createAnthropicProvider`, `createGeminiProvider`, `createZhipuProvider`, `createOvhProvider`, `createOpenAICompatibleProvider`) accept per-entry overrides |
| 16 | SSRF gate implemented but not wired into providers | **Fixed** | Every provider runs `assertSafeTarget` (DNS resolve + private/loopback/reserved rejection) before fetch; local backends exempted via `allowLocalNetwork` |
| 17 | Gemini API key embedded in URL query string | **Fixed** | Key sent via `x-goog-api-key` header |
| 18 | Credential redaction function existed but was applied nowhere | **Fixed** | 3-layer `redactSecrets` applied at bridge failure, chain catch-path and tool error paths |
| 19 | Cache unbounded, no TTL | **Fixed** | TTL + true LRU eviction (config-driven `cacheTtlSeconds` / `cacheMaxEntries`), recency refresh on hit |
| 20 | Rate-limit / quota handling absent | **Implemented** | Breaker cooldowns by failure kind (AUTH/REGION/TOS 10 min; RATE_LIMIT/QUOTA 60 s; other 30 s); non-retryable failures stop the chain |
| 21 | No local-backend support (Ollama / LM Studio) | **Implemented** (round 3) | `localOllama` / `localLmStudio` config blocks; OpenAI-compatible wire adapter; SSRF local exemption |
| 22 | No key-gated free cloud tier beyond OVH/Zhipu | **Implemented** (round 3) | OpenCode Zen free tier via `freeZen` (key-gated, model id configurable) |
| 23 | `callTool` was a stub (empty images array, no dispatch) | **Implemented** (round 3) | Tool registry + dispatcher: arg validation, attachment validation, `ToolContext` construction, redacted error returns |

Security-review items folded into the rows above: symlink rejection (row 7/8 layer),
25 MB hard read cap (`MAX_FILE_SIZE` in providers), `redirect: 'manual'` on all fetches,
MIME handling now extension-based with a safe default.

## 2. Round-2 regression → resolution

The round-2 pass fixed ~9 code items but **deleted the entire test suite (58 tests)** as
a side effect — leaving the codebase apparently green with zero verification.

**Resolution**: a full cross-platform test suite has been rebuilt under
`tests/bridge`, `tests/integration`, `tests/resilience`, `tests/security` by a parallel
TEST agent (runs on Windows and Unix; temp paths via `os.tmpdir()`; provider behavior
exercised through the `extraProviders` seam, no live network). Final counts and coverage
are recorded in §4 once that work merges.

## 3. Round-3 additions (beyond fixes)

- **Provider factories**: all five built-ins plus a generic OpenAI-compatible factory;
  config-driven models / endpoints / key env names.
- **OpenCode Zen free fallback** (`freeZen`): joins the chain only when the referenced
  env key is set; model id is configuration-driven because free models rotate.
- **Tool registry**: `registerTool` / `getTool` / `listTools` / `toolRegistry` +
  `plugin.callTool` dispatcher with schema-lite validation and secret-redacted errors.
- **Stable describe templates** keyed by `language` + `visionDepth` (cache stability +
  provider prefix-cache warmth; interactive mode uses a fixed summary template).
- **Clean failure API**: `ProcessMessageResult` / `AttachmentFailure` (see README).
- **Local Ollama / LM Studio** support with SSRF local-network exemption.
- **LRU cache** with config-driven TTL/entries; persistent (per-instance) breaker.
- **Packaging hygiene**: MIT `LICENSE`, npm-based scripts, honest `files` list,
  `engines: node >= 22.19`.
- **Documentation alignment** (this round): `README.md` rewritten and `README.zh.md`
  added with a field-by-field config reference matched to `src/config/schema.ts`;
  `cordis.patch.yml` aligned with the final schema and annotated with the
  ingest-limit vs processing-limit distinction.

## 3b. Round-4 QA pass (orchestrator)

Fixes applied by the QA pass after TEST flagged spec contradictions:

- **AUTH_MISSING now reports `kind: AUTH`** (breaker trips with the auth TTL instead of
  half the rate cooldown) with semantic code `VISION_AUTH_MISSING`, and remains retryable
  so the chain moves to the next provider.
- **`PATH_DENIED` / `FILE_TOO_LARGE` surface their own codes** as non-retryable
  `INVALID_REQUEST` failures (no provider can fix a file problem — the chain stops
  instead of folding into a generic `API_ERROR`).
- **`executeWithFailover` attaches redacted per-provider `attempted` details** to the
  final `VISION_ALL_FAILED` failure (uses the existing `VisionFailure.attempted` field;
  secrets verified redacted by test).
- **`resolveConfig()`** merges partial configs over `DEFAULT_CONFIG` (one-level nested
  merge for `localOllama` / `localLmStudio` / `freeZen`); the plugin constructor now
  applies it, and it is exported from the package entry alongside `DEFAULT_CONFIG` /
  `validateConfig`.
- **Redaction coverage**: `OPENCODE_API_KEY` added to the exact-match layer; Bearer-shape
  regex made case-insensitive.
- **Packaging**: `potrace` / `puppeteer-core` removed from `peerDependencies` (zero code
  references); `sharp` remains the only (optional, actually used) peer.
- Empty leftover dirs (`src/lib`, `src/models`, `src/modes`) removed.
- Tests updated where they had encoded the old buggy behavior (Bearer case-sensitivity,
  export-surface gap); new `tests/vision/failure-semantics.test.ts` (8 tests) covers all
  of the above.

## 4. Verification gates

| Gate | Command | Status |
|---|---|---|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **PASS** — exit 0 (final verification, R4) |
| Lint | `npm run lint` (`biome check src`) | **PASS** — 14 src files, no findings (final verification, R4) |
| Build | `npm run build` (vite + `tsc --emitDeclarationOnly`) | **PASS** — `dist/index.js` 56.57 kB + map + d.ts; import smoke OK |
| Tests | `npm test` (`vitest run`) | **PASS** — 15 files, 232 tests, all green, ~1.2 s (final verification, R4) |
| Coverage | `npm run coverage` | **PASS** — 97.31% statements / 90.08% branches / 100% functions / 97.31% lines (target was ≥85%) |

## 5. Remaining known limitations (honest list)

1. **`maxImagePixels` is schema-level only.** `validateConfig` warns above 100 MP, but
   there is no runtime pixel check — the plugin never decodes images, so pixel counts
   cannot be verified cheaply.
2. **`routing` and `progressiveTools` are declarative placeholders.** They are accepted
   by the schema (and pinned in `cordis.patch.yml`) but no runtime branching reads them;
   the shipped behavior is always pre-step bridging with a fully registered tool surface.
3. **Zen free-tier model rotation.** `big-pickle` (default) may retire; vision capability
   of rotating free models is not guaranteed. The failover chain treats rejection as a
   normal failure and moves on — but the free tail can silently degrade to OVH-only.
4. **Real-DSH integration untested.** The `PluginContext` / `processMessage` /
   shadow-history ops contract is library-level; no live DeepSeek Harness runtime has
   consumed it yet.
5. ~~**Exact-match redaction covers the four standard keys**~~ **FIXED in R4**: the
   exact-match layer now also covers `OPENCODE_API_KEY` (all five standard keys), and
   the Bearer-shape regex is case-insensitive.
6. ~~**`DEFAULT_CONFIG` / `validateConfig` are not exported from the package entry**~~
   **FIXED in R4**: `DEFAULT_CONFIG`, `validateConfig` and a new `resolveConfig`
   (partial-config merge over defaults) are exported from `src/index.ts`, and the
   plugin constructor now merges partial configs automatically.
7. ~~**`potrace` is declared as an optional peer dependency but referenced by no code**~~
   **FIXED in R4**: `potrace` and `puppeteer-core` removed from `peerDependencies`
   (zero code references); `sharp` remains the only declared optional peer (really used).
8. **DNS-rebinding TOCTOU**: the SSRF check resolves DNS before `fetch`, which
   re-resolves independently; the window is residual and accepted.
9. **Breaker / cache are in-memory per plugin instance** — no cross-process persistence
   (acceptable for a per-session plugin; documented for clarity).
