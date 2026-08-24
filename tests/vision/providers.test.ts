import { lookup } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisionExecuteOptions, VisionResult } from '../../src/config/types.ts';
import { listProviders, resolveProvider } from '../../src/vision/provider.ts';
import {
  anthropicProvider,
  createAnthropicProvider,
  createGeminiProvider,
  createOpenAICompatibleProvider,
  createOpenAIProvider,
  createOvhProvider,
  createZhipuProvider,
  geminiProvider,
  openaiProvider,
  ovhProvider,
  zhipuProvider,
} from '../../src/vision/providers.ts';
import { captureEnv, cleanupDir, makeHomeTempDir, makeTempDir, writePng } from '../test-utils.ts';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => ({ address: '8.8.8.8', family: 4 })),
}));

const lookupMock = vi.mocked(lookup);

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'ZAI_API_KEY',
  'CUSTOM_KEY',
];

let restoreEnv: () => void;
let tempDir: string;

beforeEach(() => {
  restoreEnv = captureEnv(ENV_KEYS);
  for (const key of ENV_KEYS) delete process.env[key];
  tempDir = makeTempDir('omnivision-providers-');
});

afterEach(() => {
  restoreEnv();
  cleanupDir(tempDir);
  vi.unstubAllGlobals();
});

function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function localImage(path: string, mime?: string) {
  return { kind: 'local' as const, path, contentHash: 'hash-1', mime };
}

describe('API key pre-checks', () => {
  it('openai/anthropic/gemini/zhipu fail with AUTH_MISSING when the key env is unset', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const cases = [
      createOpenAIProvider(),
      createAnthropicProvider(),
      createGeminiProvider(),
      createZhipuProvider(),
    ];
    for (const provider of cases) {
      const result = await provider.execute({ images: [localImage(writePng(tempDir, 'i.png'))] });
      expect(result.ok).toBe(false);
      expect(result.errors?.[0]?.message).toBe('AUTH_MISSING');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ovh requires no API key', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'free tier' } }] }),
    );
    const result = await createOvhProvider().execute({ images: [] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'free tier' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('apiKeyEnv override reads a custom env var', async () => {
    process.env.CUSTOM_KEY = 'ck-my-custom-key-000000001111';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const result = await createOpenAIProvider({ apiKeyEnv: 'CUSTOM_KEY' }).execute({ images: [] });
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ck-my-custom-key-000000001111' });
  });
});

describe('wire formats', () => {
  it('openai: builds data URLs, posts with redirect:manual, parses choices', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'a red cube' } }] }),
    );
    const imagePath = writePng(tempDir, 'img.png');
    const result = await createOpenAIProvider().execute({
      images: [localImage(imagePath)],
      query: 'describe',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'a red cube' });
    expect(result.meta).toMatchObject({ provider: 'openai', model: 'gpt-4o' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test-key-1234567890abcdef' });
    expect(init.signal).toBeUndefined(); // no signal, no timeoutMs
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{
        content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
      }>;
    };
    expect(body.model).toBe('gpt-4o');
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'describe' });
    expect(body.messages[0].content[1]?.image_url?.url.startsWith('data:image/png;base64,')).toBe(
      true,
    );
  });

  it('anthropic: posts base64 sources and parses text content blocks', async () => {
    process.env.ANTHROPIC_API_KEY = 'ak-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'claude says' }] }),
    );
    const imagePath = writePng(tempDir, 'img.png');
    const result = await createAnthropicProvider().execute({ images: [localImage(imagePath)] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'claude says' });
    expect(result.meta.model).toBe('claude-3-5-sonnet-20241022');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({
      'x-api-key': 'ak-test-key-1234567890abcdef',
      'anthropic-version': '2023-06-01',
    });
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      messages: Array<{
        content: Array<{ type: string; source?: { type: string; media_type: string } }>;
      }>;
    };
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
  });

  it('gemini: posts inlineData parts and parses candidates', async () => {
    process.env.GEMINI_API_KEY = 'gk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'gemini says' }] } }] }),
    );
    const imagePath = writePng(tempDir, 'img.png');
    const result = await createGeminiProvider().execute({ images: [localImage(imagePath)] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'gemini says' });
    expect(result.meta.model).toBe('gemini-2.0-flash');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    );
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'gk-test-key-1234567890abcdef' });
  });

  it('zhipu: targets the paas v4 endpoint with glm-4.6v-flash', async () => {
    process.env.ZAI_API_KEY = 'zk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'zhipu says' } }] }),
    );
    const result = await createZhipuProvider().execute({ images: [] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'zhipu says' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });

  it('baseUrl override changes the endpoint and tolerates trailing slashes', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: '' } }] }),
    );
    await createOpenAIProvider({ baseUrl: 'https://my-proxy.example/v1/' }).execute({ images: [] });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://my-proxy.example/v1/chat/completions');
  });
});

describe('HTTP status mapping', () => {
  it.each([
    [401, 'AUTH', 'API_ERROR'],
    [403, 'AUTH', 'API_ERROR'],
    [429, 'RATE_LIMIT', 'RATE_LIMITED'],
    [500, 'SERVER', 'API_ERROR'],
    [503, 'SERVER', 'API_ERROR'],
  ])('maps status %d to kind %s', async (status, kind, message) => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    stubFetch(async () => jsonResponse({}, status));
    const result = await createOpenAIProvider().execute({ images: [] });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.kind).toBe(kind);
    expect(result.errors?.[0]?.code).toBe(`VISION_${status}`);
    expect(result.errors?.[0]?.message).toBe(message);
    expect(result.errors?.[0]?.retryable).toBe(true);
  });

  it('surfaces fetch rejections as catch-message failures for every family', async () => {
    process.env.ANTHROPIC_API_KEY = 'ak-test-key-1234567890abcdef';
    process.env.GEMINI_API_KEY = 'gk-test-key-1234567890abcdef';
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const anthropic = await createAnthropicProvider().execute({ images: [] });
    expect(anthropic.ok).toBe(false);
    expect(anthropic.errors?.[0]?.message).toBe('API_ERROR');
    const gemini = await createGeminiProvider().execute({ images: [] });
    expect(gemini.ok).toBe(false);
    expect(gemini.errors?.[0]?.message).toBe('API_ERROR');
    const openai = await createOpenAIProvider().execute({ images: [] });
    expect(openai.ok).toBe(false);
    expect(openai.errors?.[0]?.message).toBe('API_ERROR'); // openai family catch message
    const ovh = await createOvhProvider().execute({ images: [] });
    expect(ovh.errors?.[0]?.message).toBe('NETWORK_ERROR'); // ovh/zhipu catch message
  });

  it('anthropic/gemini/zhipu map HTTP errors through the same kind matrix', async () => {
    process.env.ANTHROPIC_API_KEY = 'ak-test-key-1234567890abcdef';
    stubFetch(async () => jsonResponse({}, 401));
    const anthropic = await createAnthropicProvider().execute({ images: [] });
    expect(anthropic.errors?.[0]).toMatchObject({ kind: 'AUTH', code: 'VISION_401' });

    process.env.GEMINI_API_KEY = 'gk-test-key-1234567890abcdef';
    stubFetch(async () => jsonResponse({}, 429));
    const gemini = await createGeminiProvider().execute({ images: [] });
    expect(gemini.errors?.[0]).toMatchObject({ kind: 'RATE_LIMIT', code: 'VISION_429' });

    process.env.ZAI_API_KEY = 'zk-test-key-1234567890abcdef';
    stubFetch(async () => jsonResponse({}, 500));
    const zhipu = await createZhipuProvider().execute({ images: [] });
    expect(zhipu.errors?.[0]).toMatchObject({ kind: 'SERVER', code: 'VISION_500' });
  });
});

describe('signal composition', () => {
  function hangingFetch() {
    let captured: AbortSignal | undefined;
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          captured = init?.signal;
          captured?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    return { fetchMock, getSignal: () => captured };
  }

  it('timeoutMs aborts the fetch via a composed signal', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const { fetchMock, getSignal } = hangingFetch();
    const result = await createOpenAIProvider().execute({
      images: [localImage(writePng(tempDir, 'img.png'))],
      timeoutMs: 40,
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSignal()?.aborted).toBe(true);
  });

  it('propagates a caller-provided signal through AbortSignal.any', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const { fetchMock, getSignal } = hangingFetch();
    const controller = new AbortController();
    const pending = createOpenAIProvider().execute({
      images: [localImage(writePng(tempDir, 'img.png'))],
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(getSignal()?.aborted).toBe(true);
  });
});

describe('local file reads', () => {
  it('refuses paths outside allowed roots (fetch never called)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const outside = join(dirname(tmpdir()), 'omnivision-denied', 'nope.png');
    const result = await createOpenAIProvider().execute({ images: [localImage(outside)] });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors allowedReadRoots for reads outside the system temp dir', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const homeRoot = makeHomeTempDir();
    try {
      const imagePath = writePng(homeRoot, 'extra.png');
      const denied = stubFetch(async () => jsonResponse({}));
      const withoutRoots = await createOpenAIProvider().execute({
        images: [localImage(imagePath)],
      });
      expect(withoutRoots.ok).toBe(false);
      expect(denied).not.toHaveBeenCalled();

      stubFetch(async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
      const withRoots = await createOpenAIProvider({ allowedReadRoots: [homeRoot] }).execute({
        images: [localImage(imagePath)],
      });
      expect(withRoots.ok).toBe(true);
      expect(withRoots.data).toEqual({ summary: 'ok' });
    } finally {
      cleanupDir(homeRoot);
    }
  });

  it('rejects files over the 25MB cap before fetching (FILE_TOO_LARGE)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const bigPath = join(tempDir, 'big.png');
    writeFileSync(bigPath, Buffer.alloc(25 * 1024 * 1024 + 1));
    const result = await createOpenAIProvider().execute({ images: [localImage(bigPath)] });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('detects mime from extension and honors explicit mime overrides', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const bodies: string[] = [];
    stubFetch(async (_url, init) => {
      bodies.push(String(init?.body));
      return jsonResponse({ choices: [{ message: { content: '' } }] });
    });
    const jpg = join(tempDir, 'photo.jpg');
    writeFileSync(jpg, Buffer.from('jpg-bytes'));
    const weird = join(tempDir, 'file.xyz');
    writeFileSync(weird, Buffer.from('weird'));
    const provider = createOpenAIProvider();
    await provider.execute({ images: [localImage(jpg)] });
    await provider.execute({ images: [localImage(jpg, 'image/webp')] });
    await provider.execute({ images: [localImage(weird)] });
    expect(bodies[0]).toContain('data:image/jpeg;base64,');
    expect(bodies[1]).toContain('data:image/webp;base64,');
    expect(bodies[2]).toContain('data:image/png;base64,'); // unknown ext fallback
  });

  it('skips remote image sources without touching the filesystem', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: '' } }] }),
    );
    await createOpenAIProvider().execute({
      images: [{ kind: 'remote', url: 'https://cdn.example.com/x.png', contentHash: 'h' }],
      query: 'q',
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: unknown[] }>;
    };
    expect(body.messages[0].content).toHaveLength(1); // text only
  });
});

describe('SSRF gating', () => {
  it('allowLocalNetwork lets loopback endpoints through', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'local ok' } }] }),
    );
    const provider = createOpenAICompatibleProvider('lmstudio', {
      baseUrl: 'http://127.0.0.1:1234/v1',
      allowLocalNetwork: true,
    });
    const result = await provider.execute({ images: [] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'local ok' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('blocks loopback endpoints without allowLocalNetwork', async () => {
    lookupMock.mockResolvedValueOnce({ address: '127.0.0.1', family: 4 });
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const provider = createOpenAICompatibleProvider('evil-local', {
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    const result = await provider.execute({ images: [] });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.message).toBe('NETWORK_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allowLocalNetwork still rejects non-http protocols', async () => {
    expect(() =>
      createOpenAICompatibleProvider('bad', {
        baseUrl: 'ftp://127.0.0.1/x',
        allowLocalNetwork: true,
      }),
    ).not.toThrow();
    const provider = createOpenAICompatibleProvider('bad', {
      baseUrl: 'ftp://127.0.0.1/x',
      allowLocalNetwork: true,
    });
    const result = await provider.execute({ images: [] });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.message).toBe('NETWORK_ERROR');
  });
});

describe('OpenAI-compatible factory', () => {
  it('throws without baseUrl', () => {
    expect(() => createOpenAICompatibleProvider('custom')).toThrow(
      'Provider "custom": baseUrl is required for OpenAI-compatible providers',
    );
  });

  it('uses defaults for model and category', () => {
    const provider = createOpenAICompatibleProvider('relay', {
      baseUrl: 'https://relay.example/v1',
    });
    expect(provider.defaultModel).toBe('qwen2.5-vl:7b');
    expect(provider.category).toBe('local');
    expect(provider.speedClass).toBe('medium');
  });

  it('proceeds without any key when apiKeyEnv is absent', async () => {
    stubFetch(async () => jsonResponse({ choices: [{ message: { content: 'relay ok' } }] }));
    const provider = createOpenAICompatibleProvider('relay', {
      baseUrl: 'https://relay.example/v1',
    });
    const result = await provider.execute({ images: [] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'relay ok' });
  });

  it('requires the key when apiKeyEnv is set', async () => {
    const provider = createOpenAICompatibleProvider('relay', {
      baseUrl: 'https://relay.example/v1',
      apiKeyEnv: 'CUSTOM_KEY',
    });
    const result = await provider.execute({ images: [] });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.message).toBe('AUTH_MISSING');
  });

  it('sends the Bearer header when apiKeyEnv and key are both present', async () => {
    process.env.CUSTOM_KEY = 'ck-relay-key-000000009999';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'keyed relay' } }] }),
    );
    const provider = createOpenAICompatibleProvider('relay', {
      baseUrl: 'https://relay.example/v1',
      apiKeyEnv: 'CUSTOM_KEY',
    });
    const result = await provider.execute({ images: [] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'keyed relay' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ck-relay-key-000000009999' });
  });

  it('category override is honored', () => {
    const provider = createOpenAICompatibleProvider('zen-free', {
      baseUrl: 'https://opencode.ai/zen/v1',
      category: 'free',
    });
    expect(provider.category).toBe('free');
  });
});

describe('legacy singletons and provider helpers', () => {
  it('exports default-configured singletons', () => {
    expect(openaiProvider.name).toBe('openai');
    expect(openaiProvider.defaultModel).toBe('gpt-4o');
    expect(anthropicProvider.defaultModel).toBe('claude-3-5-sonnet-20241022');
    expect(geminiProvider.defaultModel).toBe('gemini-2.0-flash');
    expect(ovhProvider.name).toBe('ovh-free');
    expect(ovhProvider.category).toBe('free');
    expect(zhipuProvider.defaultModel).toBe('glm-4.6v-flash');
  });

  it('provider helpers list names and resolve nothing', () => {
    expect(listProviders()).toEqual(['openai', 'anthropic', 'gemini', 'ovh-free', 'zhipu']);
    expect(resolveProvider('openai')).toBeUndefined();
  });

  it('legacy singleton executes like the factory', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-1234567890abcdef';
    const fetchMock = stubFetch(async () =>
      jsonResponse({ choices: [{ message: { content: 'legacy' } }] }),
    );
    const options: VisionExecuteOptions = { images: [] };
    const result: VisionResult = await openaiProvider.execute(options);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'legacy' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
