<div align="center">

# dsh-omnivision

**Give DeepSeek eyes — without touching its KV cache.**

A vision bridge plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
every image is converted to a faithful text description *before* it reaches the model,
so the request stays pure text and prefix caches stay warm. The chat UI keeps showing
the original images.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-232%20passing-brightgreen)](tests)
[![Coverage](https://img.shields.io/badge/coverage-97%25-brightgreen)](reports)

**English** · [简体中文](README.zh.md)

</div>

---

## Why

Pasting images into an LLM conversation normally means switching to a multimodal message
format — which invalidates the prompt prefix cache on every image, slows every subsequent
turn, and couples you to a single vendor's vision API.

**dsh-omnivision takes a different path:** images never enter the model request at all.
A pre-step bridge describes them in text first. DeepSeek receives exactly the same
pure-text message shape it would receive without any image — same structure, same
cacheability — while the user still sees their pictures in the UI via a shadow-history
layer.

## How it works

```
 user pastes image                    ┌──────────────────────────────┐
        │                             │  vision provider chain       │
        ▼                             │  LM Studio → Ollama →        │
┌──────────────────┐    describe      │  OpenAI / Anthropic /        │
│ validate         │ ───────────────► │  Gemini / Zhipu / Zen /      │
│ path · size      │   (text back)    │  OVH Free (anonymous)        │
│ symlink          │                  └──────────────────────────────┘
└──────────────────┘                            │
        │                                       ▼
        │                              [已识图1: a screenshot of …]
        ▼                                       │
┌──────────────────┐                             ▼
│ shadow history   │                     pure-text message ──►  DeepSeek
│ UI shows image,  │                     (identical shape to a
│ model sees text  │                      no-image request)
└──────────────────┘
```

Three design decisions make this robust:

| Decision | Effect |
|---|---|
| **Stable query templates** — descriptions are requested through fixed prompts derived from `language` × `visionDepth`, never from raw user input | The same image hits the local cache across different user messages, and provider-side prefix caches see a repeated, predictable prompt |
| **Failures never touch the model context** — failed images produce no marker at all; they are reported to the UI through a structured `failures[]` array | Internal errors, provider names, and network details can never leak into the conversation |
| **Everything is configuration-driven** — models, endpoints, API-key env names, timeouts, cache size/TTL are plain config fields | Swap vendors or point at a private gateway without touching code |

## Features

- 🔒 **KV-cache safe by construction** — the model request shape is byte-identical with or without images
- 🏭 **Provider factories** — OpenAI, Anthropic, Gemini, Zhipu, OVH Free, Ollama, LM Studio, plus a generic OpenAI-compatible factory for anything else
- 🆓 **Zero-config operation** — with no keys at all, the anonymous OVH endpoint still provides vision
- 🧯 **Clean failure contract** — per-image failure reasons (`too_large` / `symlink` / `provider`) surfaced out-of-band
- 🛠️ **Tool registry** — nine dispatchable vision tools with argument validation and secret redaction
- ⚡ **Real resilience** — persistent circuit breaker, failover chain with enforced timeout budgets, LRU description cache with TTL and session isolation
- 🛡️ **Defense in depth** — segment-aware path policy, symlink rejection, size limits, SSRF guards, three-layer credential redaction

## Installation

> **Status: alpha.** The npm release is upcoming; until then, install from source.

```bash
git clone https://github.com/zsagi1368/dsh-omnivision.git
cd dsh-omnivision
npm ci
npm run build        # produces dist/index.js + type declarations
npm test             # 232 tests, ~1 s
```

Requires **Node ≥ 22.19**. Optional peer dependency [`sharp`](https://www.npmjs.com/package/sharp)
enables `vision_crop` / `vision_pixel_diff`.

## Quick start

```ts
import { createOmnivisionPlugin, resolveConfig } from 'dsh-omnivision';

const plugin = createOmnivisionPlugin({
  config: resolveConfig({
    language: 'zh',              // 'zh' | 'en' — marker & prompt language
    visionDepth: 'standard',     // 'fast' | 'standard' | 'deep'
  }),
  workspace: process.cwd(),      // root allowed for reading image attachments
  sessionId: 'session-1',        // scopes the description cache
});

// Pre-step: call BEFORE handing the message to DeepSeek
const result = await plugin.processMessage(content, attachments, eventId);

if (result.rewritten) {
  sendToDeepSeek(result.newContent);      // pure text, markers appended
}
if (result.hasErrors) {
  surfaceInUi(result.failures);           // never part of newContent
}

// Tools: drill into an image on demand
const hit = await plugin.callTool('vision_ground', {
  image: attachments[0],
  target: 'login button',
});
```

What the model actually sees (auto mode, Chinese):

```
<original user text>

[已识图1: A settings dialog with two columns… 
OCR: General | Appearance | Advanced]
```

## Provider chain

Providers are tried strictly in order until one succeeds. Compose yours in `config.providers`,
then local backends, then the free fallback tail:

| Order | Provider | Default model | Auth | Notes |
|---|---|---|---|---|
| 1 | custom entries (`config.providers`) | configurable | optional | named built-ins (`openai`, `anthropic`, `gemini`, `zhipu`, `ovh`) or any OpenAI-compatible `baseUrl` |
| 2 | LM Studio *(if enabled)* | `qwen2.5-vl-7b` | none | local, `allowLocalNetwork` |
| 3 | Ollama *(if enabled)* | `qwen2.5-vl:7b` | none | local, `allowLocalNetwork` |
| 4a | OVH Free | `Qwen2.5-VL-72B-Instruct` | **none** | fully anonymous — zero-config vision |
| 4b | Zhipu | `glm-4.6v-flash` | `ZAI_API_KEY` | joins only when the key exists |
| 4c | OpenCode Zen Free | `big-pickle` *(configurable)* | `OPENCODE_API_KEY` | joins only when the key exists |

`freeCloudFirst: true` reorders the free tail to key-gated providers before OVH. If a free
model rejects image input, the chain simply moves on.

**Environment variables (all optional):**

| Variable | Enables |
|---|---|
| `OPENAI_API_KEY` | OpenAI (`gpt-4o`) |
| `ANTHROPIC_API_KEY` | Anthropic (`claude-3-5-sonnet-20241022`) |
| `GEMINI_API_KEY` | Google Gemini (`gemini-2.0-flash`) |
| `ZAI_API_KEY` | Zhipu GLM-V flash |
| `OPENCODE_API_KEY` | OpenCode Zen free tier |

With **no** environment variables set, the plugin still works end-to-end via the anonymous
OVH endpoint.

## Modes

| Mode | Behavior |
|---|---|
| `auto` *(default)* | Full description markers appended silently; user does nothing |
| `interactive` | One-line summary + a tool hint; the model drills down via tools when needed |
| `manual` | No preprocessing — tools remain available for explicit calls |

## Tools

All tools are dispatched through `plugin.callTool(name, args)` and the exported
registry (`registerTool` / `getTool` / `listTools`). Arguments are validated, and handler
errors are credential-redacted before returning.

| Tool | Arguments | Depends on | Status |
|---|---|---|---|
| `vision_describe` | `image`, `query?` | vision provider | ✅ |
| `vision_ocr` | `image` | vision provider | ✅ |
| `vision_detect` | `image`, `category?` | vision provider | ✅ strict-JSON list, raw-text fallback |
| `vision_ground` | `image`, `target` | vision provider | ✅ strict JSON `{found, box, label}`, normalized 0–1000 coords |
| `vision_bootstrap` | `image` | vision provider | ✅ structured first-pass analysis |
| `vision_crop` | `image`, `box` | sharp *(optional peer)* | ✅ crops to PNG in temp dir |
| `vision_pixel_diff` | `image`, `reference` | sharp *(optional peer)* | ✅ true pixel-space diff, similarity 0–1 |
| `vision_trace` | — | — | 🚧 stub, explicit not-implemented error |
| `vision_screenshot` | `html` | — | 🚧 stub, explicit not-implemented error |

Register your own:

```ts
import { registerTool } from 'dsh-omnivision';

registerTool({
  name: 'vision_palette',
  description: 'Extract dominant colors',
  inputSchema: { required: ['image'] },
  async handler(ctx, args) { /* ctx.bridge, ctx.image, ctx.config */ },
});
```

## Configuration

Partial configs are merged over `DEFAULT_CONFIG`; nested objects merge one level deep.
Canonical source: [`src/config/schema.ts`](src/config/schema.ts).

```ts
config: resolveConfig({
  language: 'zh',
  visionDepth: 'standard',
  freeZen: { model: 'big-pickle' },   // rotate the Zen free model here
})
```

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `'auto' \| 'interactive' \| 'manual'` | `'auto'` | Image handling strategy |
| `routing` | `'pre-step' \| 'tool-call' \| 'hybrid'` | `'pre-step'` | Declarative routing hint |
| `providers` | `Array<{name, model?, apiKeyEnv?, baseUrl?}>` | `[]` | Custom provider overrides, highest priority |
| `localLmStudio` | `{enabled, baseURL, model}` | `false`, `http://localhost:1234/v1` | Local backend |
| `localOllama` | `{enabled, baseURL, model}` | `false`, `http://127.0.0.1:11434/v1` | Local backend |
| `freeFallback` | `boolean` | `true` | Append the free provider tail |
| `freeCloudFirst` | `boolean` | `false` | Key-gated free providers before OVH |
| `freeZen` | `{enabled, model, apiKeyEnv}` | `true`, `'big-pickle'`, `'OPENCODE_API_KEY'` | OpenCode Zen free tier |
| `maxImageBytes` | `number` | `4194304` (4 MiB) | Hard per-image processing limit |
| `maxImagePixels` | `number` | `20000000` | Schema-level guard (`validateConfig` warns > 100 MP) |
| `cache` | `boolean` | `true` | Enable the description cache |
| `cacheTtlSeconds` | `number` | `3600` | Cache entry lifetime |
| `cacheMaxEntries` | `number` | `200` | LRU capacity per session |
| `timeoutMs` | `number` | `120000` | Whole-chain timeout budget |
| `visionTaskTimeoutMs` | `number` | `45000` | Per-provider timeout budget |
| `language` | `'zh' \| 'en'` | `'zh'` | Marker & prompt language |
| `visionDepth` | `'fast' \| 'standard' \| 'deep'` | `'standard'` | Describe-prompt detail level |
| `progressiveTools` | `boolean` | `false` | Declarative tool-exposure hint |

## Error-handling contract

Failures never alter the model-visible content:

```ts
interface ProcessMessageResult {
  rewritten: boolean;       // false when nothing succeeded
  newContent: string;       // original content unless ≥ 1 image succeeded
  imageCount: number;
  descriptions: string[];   // successes only
  hasErrors: boolean;
  failures?: Array<{
    index: number;
    path: string;
    reason: 'too_large' | 'symlink' | 'provider';
    message: string;        // redacted
  }>;
}
```

When every image fails, `newContent` is returned untouched and the reason trail lands in
`failures` — the UI decides what to show.

## Security

- **Path policy** — segment-aware whitelist (workspace + system temp); `/tmp-evil` does not match `/tmp`; symlinks rejected; per-image size limit enforced via `stat`
- **SSRF guards** — DNS resolution with private/loopback/reserved-range rejection before every remote call; `redirect: 'manual'` everywhere; local backends opt out explicitly
- **Credential hygiene** — three-layer redaction (exact known keys → token-shape regexes → URL userinfo) applied to every error surface; secrets are read from the environment only
- **Hard caps** — 25 MB provider read ceiling regardless of configuration

## Development

| Command | Purpose |
|---|---|
| `npm run build` | Bundle (`dist/index.js`) + emit declarations |
| `npm test` | Run the 232-test suite (~1 s, no network) |
| `npm run coverage` | V8 coverage report |
| `npm run lint` / `npm run format` | Biome check / autofix |
| `npm run dev` | Watch rebuild |

The test suite is fully offline (mocked fetch/DNS) and cross-platform — paths are built
through `os.tmpdir()` so it passes identically on Windows, Linux, and macOS.

## Status & roadmap

- ✅ Core bridge, provider factories, tool registry, security layers
- ✅ 232 tests · 97% statement coverage · clean typecheck & lint
- 🔲 Live integration against a running DeepSeek Harness host
- 🔲 First npm release
- 🔲 `vision_trace` / `vision_screenshot` implementations

## License

[MIT](LICENSE) © zsagi1368
