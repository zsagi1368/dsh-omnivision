/**
 * Provider implementations for DSH Omnivision
 *
 * All providers are created via factories so the config layer can compose
 * them with custom models, base URLs, API key env names, read roots and
 * SSRF exemptions (local network for Ollama / LM Studio).
 * The five legacy named exports (`openaiProvider` etc.) remain as
 * default-configured instances for backward compatibility.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VisionExecuteOptions, VisionFailure, VisionResult } from '../config/types.ts';
import { assertSafeRemoteTarget, DEFAULT_TEMP, isPathAllowed } from '../security/index.ts';
import type { VisionProvider } from './provider.ts';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
// Unix temp roots (segment-checked, so `/tmp-evil` does not match `/tmp`);
// DEFAULT_TEMP (os.tmpdir()) covers Windows and the current platform temp.
const ALLOWED_PATHS = ['/tmp', '/private/tmp'];

/** Options accepted by every provider factory */
export interface ProviderFactoryOptions {
  /** Override the provider's default model */
  model?: string;
  /** Override the provider's default endpoint base (keep the version prefix, e.g. `.../v1`) */
  baseUrl?: string;
  /** Override the env var name read for the API key */
  apiKeyEnv?: string;
  /** Extra roots local image files may be read from (in addition to system temp dirs) */
  allowedReadRoots?: string[];
  /** Skip private-IP rejection (for Ollama / LM Studio on 127.0.0.1) */
  allowLocalNetwork?: boolean;
}

function buildFailureResponse(
  status: number,
  message: string,
  providerName: string,
  retryable = true,
  kindOverride?: VisionFailure['kind'],
): VisionResult {
  const kind: VisionFailure['kind'] =
    kindOverride ??
    (status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'OTHER');
  // Status 0 + an explicit kind carries its own semantic code (AUTH_MISSING,
  // PATH_DENIED, FILE_TOO_LARGE) instead of the meaningless VISION_0.
  const code = kindOverride && status === 0 ? `VISION_${message}` : `VISION_${status}`;
  return {
    ok: false,
    meta: { provider: providerName, model: 'unknown', durationMs: 0 },
    errors: [{ kind, code, message, retryable }],
  };
}

/**
 * Missing API key: AUTH kind (so the breaker trips with the auth TTL, not the
 * half rate-cooldown) but still retryable — the chain should move on to the
 * next provider rather than stop.
 */
function authMissing(providerName: string): VisionResult {
  return buildFailureResponse(0, 'AUTH_MISSING', providerName, true, 'AUTH');
}

/**
 * Local-file problems (path outside the allowed roots, file over the hard
 * 25MB read cap) are request-level errors no provider can fix — surface the
 * specific code and stop the chain instead of folding into a generic error.
 */
function classifyLocalFileError(
  error: unknown,
  providerName: string,
  fallbackMessage: string,
): VisionResult {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'PATH_DENIED' || message === 'FILE_TOO_LARGE') {
    return buildFailureResponse(0, message, providerName, false, 'INVALID_REQUEST');
  }
  return buildFailureResponse(0, fallbackMessage, providerName);
}

function detectMime(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return mimeMap[ext] ?? 'image/png';
}

function readFileAsBase64(path: string, allowedReadRoots: readonly string[] = []): string {
  const resolved = resolve(path);
  const allowed = isPathAllowed(resolved, [...ALLOWED_PATHS, DEFAULT_TEMP, ...allowedReadRoots]);
  if (!allowed) {
    throw new Error('PATH_DENIED');
  }
  const buffer = readFileSync(resolved);
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error('FILE_TOO_LARGE');
  }
  return buffer.toString('base64');
}

/**
 * SSRF gate. When local network is allowed (Ollama / LM Studio) we still
 * require http/https but skip the private-IP rejection; otherwise the full
 * DNS lookup + private/reserved IP check applies.
 */
async function assertSafeTarget(url: string, allowLocalNetwork: boolean): Promise<void> {
  if (allowLocalNetwork) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`SSRF_UNSUPPORTED_PROTOCOL: ${parsed.protocol}`);
    }
    return;
  }
  await assertSafeRemoteTarget(url);
}

/**
 * Compose the caller-provided signal with the per-provider timeout budget
 * (options.timeoutMs, set by the failover chain) into a single signal.
 */
function composeSignal(options: VisionExecuteOptions): AbortSignal | undefined {
  const signals = [
    options.signal,
    options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  ].filter((s): s is AbortSignal => s !== undefined);
  if (signals.length > 1) {
    return AbortSignal.any(signals);
  }
  return signals[0];
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
    redirect: 'manual',
  });
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

function buildOpenAiContents(
  options: VisionExecuteOptions,
  allowedReadRoots: readonly string[],
): OpenAiContentPart[] {
  const contents: OpenAiContentPart[] = [];
  if (options.query) contents.push({ type: 'text', text: options.query });
  for (const img of options.images) {
    if (img.kind === 'local' && img.path) {
      const mime = img.mime || detectMime(img.path);
      const base64 = readFileAsBase64(img.path, allowedReadRoots);
      contents.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
    }
  }
  return contents;
}

interface OpenAiWireSpec {
  name: string;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  allowLocalNetwork: boolean;
  allowedReadRoots: readonly string[];
  /** Message used when the request throws (network / timeout / SSRF denial) */
  catchMessage: string;
}

/**
 * Shared executor for everything speaking the OpenAI chat/completions wire
 * format (OpenAI, OVH, Zhipu, Ollama, LM Studio, ...).
 */
async function executeOpenAiWire(
  spec: OpenAiWireSpec,
  options: VisionExecuteOptions,
): Promise<VisionResult> {
  const startTime = Date.now();
  try {
    await assertSafeTarget(spec.endpoint, spec.allowLocalNetwork);
    const contents = buildOpenAiContents(options, spec.allowedReadRoots);
    const response = await postJson(
      spec.endpoint,
      spec.headers,
      { model: spec.model, messages: [{ role: 'user', content: contents }] },
      composeSignal(options),
    );
    if (!response.ok) {
      const message = response.status === 429 ? 'RATE_LIMITED' : 'API_ERROR';
      return buildFailureResponse(response.status, message, spec.name);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      ok: true,
      data: { summary: text },
      meta: { provider: spec.name, model: spec.model, durationMs: Date.now() - startTime },
    };
  } catch (error) {
    return classifyLocalFileError(error, spec.name, spec.catchMessage);
  }
}

// OpenAI
export function createOpenAIProvider(opts: ProviderFactoryOptions = {}): VisionProvider {
  const model = opts.model ?? 'gpt-4o';
  const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
  const apiKeyEnv = opts.apiKeyEnv ?? 'OPENAI_API_KEY';
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: 'openai',
    defaultModel: model,
    category: 'api',
    speedClass: 'fast',
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing('openai');
      return executeOpenAiWire(
        {
          name: 'openai',
          model,
          endpoint: joinUrl(baseUrl, '/chat/completions'),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: 'API_ERROR',
        },
        options,
      );
    },
  };
}

// Anthropic
export function createAnthropicProvider(opts: ProviderFactoryOptions = {}): VisionProvider {
  const model = opts.model ?? 'claude-3-5-sonnet-20241022';
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
  const apiKeyEnv = opts.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: 'anthropic',
    defaultModel: model,
    category: 'api',
    speedClass: 'fast',
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing('anthropic');
      const startTime = Date.now();
      try {
        const endpoint = joinUrl(baseUrl, '/v1/messages');
        await assertSafeTarget(endpoint, opts.allowLocalNetwork === true);
        const content: Array<{
          type: string;
          text?: string;
          source?: { type: string; media_type: string; data: string };
        }> = [];
        if (options.query) content.push({ type: 'text', text: options.query });
        for (const img of options.images) {
          if (img.kind === 'local' && img.path) {
            const mime = img.mime || detectMime(img.path);
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mime,
                data: readFileAsBase64(img.path, allowedReadRoots),
              },
            });
          }
        }
        const response = await postJson(
          endpoint,
          {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          { model, max_tokens: 4096, messages: [{ role: 'user', content }] },
          composeSignal(options),
        );
        if (!response.ok) return buildFailureResponse(response.status, 'API_ERROR', 'anthropic');
        const data = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };
        const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
        return {
          ok: true,
          data: { summary: text },
          meta: { provider: 'anthropic', model, durationMs: Date.now() - startTime },
        };
      } catch (error) {
        return classifyLocalFileError(error, 'anthropic', 'API_ERROR');
      }
    },
  };
}

// Google Gemini
export function createGeminiProvider(opts: ProviderFactoryOptions = {}): VisionProvider {
  const model = opts.model ?? 'gemini-2.0-flash';
  const baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com';
  const apiKeyEnv = opts.apiKeyEnv ?? 'GEMINI_API_KEY';
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: 'gemini',
    defaultModel: model,
    category: 'api',
    speedClass: 'fast',
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing('gemini');
      const startTime = Date.now();
      try {
        const endpoint = joinUrl(baseUrl, `/v1beta/models/${model}:generateContent`);
        await assertSafeTarget(endpoint, opts.allowLocalNetwork === true);
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        if (options.query) parts.push({ text: options.query });
        for (const img of options.images) {
          if (img.kind === 'local' && img.path) {
            const mime = img.mime || detectMime(img.path);
            parts.push({
              inlineData: { mimeType: mime, data: readFileAsBase64(img.path, allowedReadRoots) },
            });
          }
        }
        const response = await postJson(
          endpoint,
          { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          { contents: [{ role: 'user', parts }] },
          composeSignal(options),
        );
        if (!response.ok) return buildFailureResponse(response.status, 'API_ERROR', 'gemini');
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        return {
          ok: true,
          data: { summary: text },
          meta: { provider: 'gemini', model, durationMs: Date.now() - startTime },
        };
      } catch (error) {
        return classifyLocalFileError(error, 'gemini', 'API_ERROR');
      }
    },
  };
}

// OVHcloud free endpoint (no API key required)
export function createOvhProvider(opts: ProviderFactoryOptions = {}): VisionProvider {
  const model = opts.model ?? 'Qwen2.5-VL-72B-Instruct';
  const baseUrl = opts.baseUrl ?? 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: 'ovh-free',
    defaultModel: model,
    category: 'free',
    speedClass: 'slow',
    async execute(options) {
      return executeOpenAiWire(
        {
          name: 'ovh-free',
          model,
          endpoint: joinUrl(baseUrl, '/chat/completions'),
          headers: { 'Content-Type': 'application/json' },
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: 'NETWORK_ERROR',
        },
        options,
      );
    },
  };
}

// Zhipu (bigmodel.cn)
export function createZhipuProvider(opts: ProviderFactoryOptions = {}): VisionProvider {
  const model = opts.model ?? 'glm-4.6v-flash';
  const baseUrl = opts.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4';
  const apiKeyEnv = opts.apiKeyEnv ?? 'ZAI_API_KEY';
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: 'zhipu',
    defaultModel: model,
    category: 'free',
    speedClass: 'fast',
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing('zhipu');
      return executeOpenAiWire(
        {
          name: 'zhipu',
          model,
          endpoint: joinUrl(baseUrl, '/chat/completions'),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: 'NETWORK_ERROR',
        },
        options,
      );
    },
  };
}

/**
 * Generic OpenAI-compatible provider (Ollama at http://127.0.0.1:11434/v1,
 * LM Studio at http://localhost:1234/v1, or any other /v1 endpoint).
 *
 * `baseUrl` is REQUIRED. The caller decides about `allowLocalNetwork`
 * (the config layer passes `true` for local backends so the SSRF check
 * lets 127.0.0.1 / private hosts through). `apiKeyEnv` is optional —
 * local servers usually need no key.
 */
export function createOpenAICompatibleProvider(
  name: string,
  opts: ProviderFactoryOptions & { category?: 'api' | 'local' | 'free' } = {},
): VisionProvider {
  const baseUrl = opts.baseUrl;
  if (!baseUrl) {
    throw new Error(`Provider "${name}": baseUrl is required for OpenAI-compatible providers`);
  }
  const model = opts.model ?? 'qwen2.5-vl:7b';
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name,
    defaultModel: model,
    category: opts.category ?? 'local',
    speedClass: 'medium',
    async execute(options) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.apiKeyEnv) {
        const apiKey = process.env[opts.apiKeyEnv];
        if (!apiKey) return authMissing(name);
        headers.Authorization = `Bearer ${apiKey}`;
      }
      return executeOpenAiWire(
        {
          name,
          model,
          endpoint: joinUrl(baseUrl, '/chat/completions'),
          headers,
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: 'NETWORK_ERROR',
        },
        options,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy singletons (default-configured factory instances).
// Kept for backward compatibility — src/plugin/index.ts imports these until
// CORE-B switches it to factory-based composition.
// ---------------------------------------------------------------------------
export const openaiProvider: VisionProvider = createOpenAIProvider();
export const anthropicProvider: VisionProvider = createAnthropicProvider();
export const geminiProvider: VisionProvider = createGeminiProvider();
export const ovhProvider: VisionProvider = createOvhProvider();
export const zhipuProvider: VisionProvider = createZhipuProvider();
