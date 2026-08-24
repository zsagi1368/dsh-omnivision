# dsh-omnivision

[English](README.md) | [中文](README.zh.md)

A Cordis plugin package for **DeepSeek Harness (DSH)** that converts images into text
descriptions **before** they reach DeepSeek — so the model only ever sees pure text and its
KV cache / prompt-prefix cache is never disturbed by multimodal content. The UI keeps
showing the original images through a "shadow history" mechanism.

> **Status: alpha, pre-integration-testing.** The plugin core, provider chain, tools and
> security layers are implemented and unit/integration tested at the library level, but it
> has **not yet been wired into a live DeepSeek Harness runtime**. The `PluginContext` /
> `processMessage` contract below is the integration surface. Treat everything as
> subject to change.

## How it works (KV-cache-safe architecture)

```
User pastes an image
        |
        v
+-----------------------------------------------+
| Pre-step bridge (this plugin, before DeepSeek) |
|  1. validate path / size / symlink             |
|  2. description cache lookup (stable key)      |
|  3. provider failover chain -> text            |
|  4. rewrite the message to pure text           |
+-----------------------------------------------+
        |
        v   text markers like [Image 1: ...] / [已识图1: ...]
   DeepSeek  <---- pure text only; KV cache untouched
        |
        v
 Shadow history: the UI keeps the original image event,
 the model-side history holds the text replacement
```

Two properties make this cache-safe:

- **Pure text in, pure text out.** DeepSeek never receives image parts; the request
  structure of the conversation is unchanged by images.
- **Stable query templates.** The vision query sent to providers is a fixed template
  derived from `language` + `visionDepth` — never the raw user message. Consequences:
  the same image hits the local description cache across different user prompts, and
  provider-side prefix caches stay warm because the prompt prefix is predictable.

Shadow history: when `processMessage` is given an `eventId`, it returns
`shadows: [{ surfaceOp: keep, modelOp: replace }]` pairs — the host UI keeps the image
for display, while the model-visible history gets the description text.

## Provider chain (failover order)

Providers are tried in order until one succeeds:

1. `extraProviders` (programmatic injection seam, mainly for tests)
2. `providers[]` config entries, in declared order
3. LM Studio (if `localLmStudio.enabled`)
4. Ollama (if `localOllama.enabled`)
5. Free cloud tail (if `freeFallback: true`):
   - `freeCloudFirst: false` (default): OVH -> Zhipu (if key) -> Zen (if key)
   - `freeCloudFirst: true`: Zhipu (if key) -> Zen (if key) -> OVH

| Provider | `providers[].name` | Default model | Auth | Notes |
|---|---|---|---|---|
| OpenAI | `openai` | `gpt-4o` | `OPENAI_API_KEY` | OpenAI-compatible `/v1` |
| Anthropic | `anthropic` | `claude-3-5-sonnet-20241022` | `ANTHROPIC_API_KEY` | Messages API |
| Google Gemini | `gemini` | `gemini-2.0-flash` | `GEMINI_API_KEY` | key via `x-goog-api-key` header |
| Zhipu | `zhipu` | `glm-4.6v-flash` | `ZAI_API_KEY` | free tier, key required |
| OVH Free | `ovh` (alias `ovh-free`) | `Qwen2.5-VL-72B-Instruct` | none | fully anonymous; the zero-config default |
| OpenCode Zen | — (via `freeZen`) | `big-pickle` (config) | `OPENCODE_API_KEY` (configurable) | free tier, sign-in key required |
| Ollama | — (via `localOllama`) | `qwen2.5-vl:7b` | none | local, SSRF check exempted |
| LM Studio | — (via `localLmStudio`) | `qwen2.5-vl-7b` | none | local, SSRF check exempted |
| Any OpenAI-compatible | any other name + `baseUrl` | required via `model` | optional via `apiKeyEnv` | generic adapter |

All defaults are overridable per entry via `providers[].model` / `baseUrl` / `apiKeyEnv`.

### Environment variables

| Env var | Used by | Required |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI provider | no |
| `ANTHROPIC_API_KEY` | Anthropic provider | no |
| `GEMINI_API_KEY` | Gemini provider | no |
| `ZAI_API_KEY` | Zhipu (auto-joins the free tail when set) | no |
| `OPENCODE_API_KEY` | OpenCode Zen free tier (auto-joins when `freeZen.enabled` and set) | no |

**Every key is optional.** With zero configuration and zero keys, the chain still contains
the anonymous OVH endpoint, so image description works out of the box (subject to OVH's
uncontrolled rate limits). Custom env var names can be used via `providers[].apiKeyEnv`
and `freeZen.apiKeyEnv`.

### Resilience

- **Circuit breaker** (in-memory, owned by the plugin instance, shared across calls,
  max 128 provider entries): `AUTH` / `REGION` / `TOS` failures block a provider for
  10 min; `RATE_LIMIT` / `QUOTA` for 60 s; other failures for 30 s.
- **Timeouts**: `timeoutMs` is the total budget for one image across the whole chain;
  `visionTaskTimeoutMs` is the per-provider budget, enforced with a composed
  `AbortSignal`. Remaining-budget arithmetic prevents a late provider from overrunning.
- **Failure classification**: thrown errors are classified (`AUTH`, `RATE_LIMIT`,
  `TIMEOUT`, `NETWORK`, ...) and secret-redacted; non-retryable failures stop the chain
  instead of pointlessly retrying.

### Caching

Per-plugin LRU description cache with configurable TTL and entry count. The cache key is
`sha256(sessionId | mode | image contentHash | query template)` — session-scoped, and
stable across different user prompts because the query is always a template, never raw
user input.

## Modes

| `mode` | Pre-step behavior | What DeepSeek receives |
|---|---|---|
| `auto` (default) | Full description markers appended to the message | `[Image 1: ...]` / `[已识图1: ...]` per image (plus an OCR excerpt, up to 500 chars, when a provider returned structured OCR) |
| `interactive` | One-two sentence summary per image + a tool-hint line | short markers + hint to call `vision_describe` / `vision_ground` / `vision_detect` for detail |
| `manual` | No preprocessing; content returned unchanged | original content; the user/model drives analysis via tools |

With multiple images a header line (`2 images described:` / `已识图2张：`) precedes the
markers. Failed images never contribute markers (see below).

## Tools

All tools live in a registry and are dispatched via `plugin.callTool(name, args)`.
Tools taking an `image` expect an attachment object `{ path, contentHash, mime?, bytes? }`.

| Tool | Arguments | Requires | Status |
|---|---|---|---|
| `vision_describe` | `image`, `query?` | vision provider | implemented |
| `vision_ocr` | `image` | vision provider | implemented |
| `vision_detect` | `image` | vision provider | implemented; strict-JSON array, falls back to raw text |
| `vision_ground` | `image`, `target` | vision provider | implemented; strict JSON `{found, box, label}`, 0-1000 normalized coords |
| `vision_bootstrap` | `image` | vision provider | implemented; structured first-pass JSON |
| `vision_crop` | `image`, `box` | **`sharp` (optional peer dep)** | implemented; clean dependency error when `sharp` is absent |
| `vision_pixel_diff` | `image`, `reference` | **`sharp` (optional peer dep)** | implemented; clean dependency error when `sharp` is absent |
| `vision_trace` | — | — | **stub**: returns an explicit not-implemented error |
| `vision_screenshot` | `html` | `puppeteer-core` (install manually when implemented) | **stub**: returns an explicit not-implemented error |

`sharp` is the only declared (optional) peer dependency in `package.json` — it is actually
loaded at runtime by `vision_crop` / `vision_pixel_diff`. `puppeteer-core` and `potrace`
are not declared because no code references them yet; install them manually if/when the
stubs are implemented.

## Error-handling contract

Failures never leak into model-visible content. `processMessage` returns:

```ts
interface ProcessMessageResult {
  rewritten: boolean;        // at least one image described
  newContent: string;        // model-visible content; unchanged original when nothing succeeded
  imageCount: number;        // validated image attachments
  descriptions: string[];    // successful summaries, in image order
  shadows?: ShadowReplacement[]; // only when eventId was provided
  hasErrors: boolean;
  failures?: AttachmentFailure[]; // per-attachment details for the UI layer — never rendered into newContent
}

interface AttachmentFailure {
  index: number;                          // position in the original attachments array
  path: string;
  reason: 'too_large' | 'symlink' | 'provider';
  message: string;                        // secret-redacted
}
```

- Non-images, out-of-policy paths and unreadable files are silently skipped (not errors).
- Oversized (`> maxImageBytes`) and symlinked attachments produce `failures` entries.
- If every image fails, `rewritten` is `false` and `newContent` is the original content.

## Configuration reference

Canonical source: `src/config/schema.ts` (`OmniVisionConfig` / `DEFAULT_CONFIG`).

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `'auto' \| 'interactive' \| 'manual'` | `'auto'` | Pre-step interaction mode (see Modes) |
| `routing` | `'pre-step' \| 'tool-call' \| 'hybrid'` | `'pre-step'` | **Declarative only** — accepted for forward-compatibility; current runtime always does pre-step bridging with an always-registered tool registry |
| `providers` | `Array<{ name, model?, apiKeyEnv?, baseUrl? }>` | `[]` | Explicit provider entries, tried in order. `name` maps to a built-in factory (`openai`, `anthropic`, `gemini`, `zhipu`, `ovh`); an unknown name **with** `baseUrl` becomes a generic OpenAI-compatible provider; an unknown name without `baseUrl` is ignored |
| `localOllama.enabled` | `boolean` | `false` | Add a local Ollama provider to the chain |
| `localOllama.baseURL` | `string` | `'http://127.0.0.1:11434/v1'` | Ollama OpenAI-compatible endpoint (should be local; warned otherwise) |
| `localOllama.model` | `string` | `'qwen2.5-vl:7b'` | Ollama vision model |
| `localLmStudio.enabled` | `boolean` | `false` | Add a local LM Studio provider to the chain |
| `localLmStudio.baseURL` | `string` | `'http://localhost:1234/v1'` | LM Studio endpoint |
| `localLmStudio.model` | `string` | `'qwen2.5-vl-7b'` | LM Studio vision model |
| `freeFallback` | `boolean` | `true` | Append the free cloud tail (OVH / Zhipu / Zen) to the chain |
| `freeCloudFirst` | `boolean` | `false` | `true` puts free cloud providers (Zhipu, Zen) before OVH in the tail |
| `freeZen.enabled` | `boolean` | `true` | Add OpenCode Zen free tier when its key is set |
| `freeZen.model` | `string` | `'big-pickle'` | Zen model id. **Free-tier models rotate over time** — expect to update this when the current id retires |
| `freeZen.apiKeyEnv` | `string` | `'OPENCODE_API_KEY'` | Env var holding the Zen sign-in key; Zen joins the chain only when it is set |
| `maxImageBytes` | `number` | `4194304` (4 MiB) | Hard per-image size limit, enforced via `statSync` before any provider call |
| `maxImagePixels` | `number` | `20000000` (20 MP) | **Schema-level only**: `validateConfig` warns above 100 MP, but there is no runtime pixel check (the plugin never decodes images) |
| `cache` | `boolean` | `true` | Enable the description cache |
| `cacheTtlSeconds` | `number` | `3600` | Cache TTL |
| `cacheMaxEntries` | `number` | `200` | Cache capacity (true LRU eviction) |
| `timeoutMs` | `number` | `120000` | Total budget for one image across the whole failover chain |
| `visionTaskTimeoutMs` | `number` | `45000` | Per-provider timeout inside the chain |
| `language` | `'zh' \| 'en'` | `'zh'` | Language of query templates and text markers |
| `visionDepth` | `'fast' \| 'standard' \| 'deep'` | `'standard'` | Describe-template detail level (affects the `auto`-mode / `vision_describe` prompt) |
| `progressiveTools` | `boolean` | `false` | **Declarative only** — kept `false` so the tool surface stays stable from session start (mid-conversation tool-list growth can invalidate long-context KV/prefix caches); no runtime branching is attached yet |

## Security

- **Path policy**: segment-aware whitelist — image files may only be read from the DSH
  workspace or the OS temp dir (`/tmp-evil` does not match `/tmp`); symlinks are rejected
  (`lstat`); size enforced with `statSync` before any read.
- **SSRF protection**: every remote endpoint goes through DNS resolution + private /
  loopback / reserved IP rejection; `redirect: 'manual'` on all fetches; local backends
  (Ollama, LM Studio) are explicitly exempted.
- **Hard read cap**: providers refuse to read files larger than 25 MB regardless of config.
- **Credential redaction** (3 layers, applied to all error surfaces): exact match of
  currently-set known secrets (`OPENAI` / `ANTHROPIC` / `GEMINI` / `ZAI` keys), token-shape
  regexes (`sk-...`, `Bearer ...`, `api_key=...`), and URL userinfo masking. Other keys
  (e.g. `OPENCODE_API_KEY`) are covered by the shape-based layers.
- Residual, accepted risk: the SSRF check resolves DNS before `fetch`, which re-resolves —
  a classic DNS-rebinding TOCTOU window remains.

## Install / build / test

Requires Node.js `>= 22.19`. `npm` and `pnpm` both work (scripts are plain npm scripts).

```bash
npm install          # or: pnpm install
npm run build        # vite build (ESM, node22 target) + tsc declaration emit -> dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:watch   # vitest watch mode
npm run coverage     # vitest run --coverage
npm run lint         # biome check src
npm run format       # biome check --write src
```

Optional peer deps (only if you use the corresponding tools):

```bash
npm i sharp             # vision_crop, vision_pixel_diff
npm i puppeteer-core    # future vision_screenshot
```

### Using as a library

```ts
import { createOmnivisionPlugin, resolveConfig } from 'dsh-omnivision';

const plugin = createOmnivisionPlugin({
  // Partial configs are fine — the plugin merges them over DEFAULT_CONFIG.
  // Use resolveConfig() yourself when you need the effective config up front.
  config: resolveConfig({ language: 'en', freeZen: { model: 'big-pickle' } }),
  workspace: process.cwd(),
  sessionId: 'session-1',
});

const result = await plugin.processMessage(content, attachments, eventId);
if (result.rewritten) sendToDeepSeek(result.newContent);
if (result.hasErrors) surfaceInUi(result.failures);

const toolResult = await plugin.callTool('vision_ground', {
  image: attachments[0],
  target: 'login button',
});
```

Public API (from `src/index.ts`): `OmniVisionPlugin`, `createOmnivisionPlugin`,
`PluginContext`, `ProcessMessageResult`, `AttachmentFailure`, `AttachmentFailureReason`,
`OmniVisionConfig` (type), `DEFAULT_CONFIG`, `resolveConfig`, `validateConfig`,
config type aliases (`VisionMode`, `RoutingMode`,
`ImageAttachment`, `VisionDescription`, `FailureKind`), `registerTool` / `getTool` /
`listTools` / `toolRegistry`, `ToolContext` / `ToolDefinition` / `ToolResult` (types),
`VisionProvider` / `VisionResult` / `VisionFailure` (types).

`plugin.stats()` exposes cache size, blocked providers and chain length; `plugin.dispose()`
clears cache and breaker state.

## cordis.patch.yml

The bundled patch mounts the plugin with a minimal config (restating schema defaults for
explicitness) and sets a DSH-side attachment ingest policy (20 MiB / 100 MP / 10000 px).
Note the two layers are different: the patch's `attachment-local` limits govern what the
DSH harness accepts when a user attaches an image; the plugin's `maxImageBytes` (4 MiB
default) governs what the plugin will send to vision providers. Images between the two
limits stay in the UI but are reported through the `failures` API instead of being
described.

## Development status

Done (library level):

- KV-cache-safe pre-step bridge, three modes, stable describe templates
- Provider chain with factories, free fallback (OVH / Zhipu / Zen), Ollama & LM Studio
- LRU cache, timeouts, persistent (per-instance) circuit breaker, failure classification
- Tool registry with 9 tools (7 implemented, 2 explicit stubs)
- Path policy, SSRF gate, symlink rejection, credential redaction
- Cross-platform test suite under `tests/` (bridge / integration / resilience / security)
- Build (vite EM + tsc `.d.ts`), biome lint, typecheck all green

Remaining / not done:

- **Real-DSH integration testing** — the plugin has not been run inside an actual
  DeepSeek Harness runtime; the shadow-history ops are produced but no host consumes
  them yet.
- `routing` and `progressiveTools` have no runtime effect (declarative placeholders).
- `maxImagePixels` is not enforced at runtime.
- `vision_trace` and `vision_screenshot` are stubs.
- Zen free-tier model rotation and the vision capability of its rotating free models are
  outside this plugin's control (the failover chain absorbs rejections).

## License

[MIT](LICENSE)
