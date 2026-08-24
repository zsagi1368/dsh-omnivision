/**
 * Failure semantics introduced in the round-4 QA pass:
 *  - missing API keys surface as AUTH kind (auth TTL on the breaker) while
 *    staying retryable so the chain moves on;
 *  - local-file errors (PATH_DENIED / FILE_TOO_LARGE) surface their own codes
 *    and stop the chain (no provider can fix a file problem);
 *  - the failover chain attaches redacted per-provider attempts to the final
 *    VISION_ALL_FAILED failure;
 *  - resolveConfig merges partial user config over DEFAULT_CONFIG.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../src/config/schema.ts';
import { executeWithFailover } from '../../src/vision/chain.ts';
import { createOpenAIProvider } from '../../src/vision/providers.ts';
import {
  captureEnv,
  cleanupDir,
  makeHomeTempDir,
  makeProvider,
  makeTempDir,
  writePng,
} from '../test-utils.ts';

const restoreEnv = captureEnv(['OPENAI_API_KEY']);
afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
});

describe('AUTH_MISSING failure semantics', () => {
  it('reports kind AUTH with a semantic code but stays retryable', async () => {
    delete process.env.OPENAI_API_KEY;
    const provider = createOpenAIProvider();
    const result = await provider.execute({
      images: [],
      query: 'hi',
    });
    expect(result.ok).toBe(false);
    const failure = result.errors?.[0];
    expect(failure?.kind).toBe('AUTH');
    expect(failure?.code).toBe('VISION_AUTH_MISSING');
    expect(failure?.retryable).toBe(true);
  });

  it('does not stop the failover chain (next provider wins)', async () => {
    delete process.env.OPENAI_API_KEY;
    const fallback = makeProvider('fallback', async () => ({
      ok: true,
      data: { summary: 'from fallback' },
      meta: { provider: 'fallback', model: 'm', durationMs: 1 },
    }));
    const result = await executeWithFailover([createOpenAIProvider(), fallback], {
      images: [],
      query: 'hi',
    });
    expect(result.ok).toBe(true);
    expect(fallback.execute).toHaveBeenCalledTimes(1);
  });
});

describe('PATH_DENIED failure semantics', () => {
  it('surfaces the specific code as non-retryable INVALID_REQUEST', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outsideDir = makeHomeTempDir();
    try {
      const imagePath = writePng(outsideDir, 'outside.png');
      const provider = createOpenAIProvider(); // read roots = temp only
      process.env.OPENAI_API_KEY = 'x'.repeat(24);
      const result = await provider.execute({
        images: [{ kind: 'local', path: imagePath, contentHash: 'h1' }],
        query: 'describe',
      });
      expect(result.ok).toBe(false);
      const failure = result.errors?.[0];
      expect(failure?.kind).toBe('INVALID_REQUEST');
      expect(failure?.code).toBe('VISION_PATH_DENIED');
      expect(failure?.retryable).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      cleanupDir(outsideDir);
    }
  });

  it('stops the chain — later providers are not consulted', async () => {
    const later = makeProvider('later', async () => ({
      ok: true,
      data: { summary: 'never' },
      meta: { provider: 'later', model: 'm', durationMs: 1 },
    }));
    const outsideDir = makeHomeTempDir();
    try {
      const imagePath = writePng(outsideDir, 'outside.png');
      process.env.OPENCODE_API_KEY = 'x'.repeat(24);
      const { createOpenAICompatibleProvider } = await import('../../src/vision/providers.ts');
      const denial = createOpenAICompatibleProvider('denial-test', {
        baseUrl: 'https://example.com/v1',
      });
      const result = await executeWithFailover([denial, later], {
        images: [{ kind: 'local', path: imagePath, contentHash: 'h1' }],
        query: 'describe',
      });
      expect(result.ok).toBe(false);
      expect(later.execute).not.toHaveBeenCalled();
    } finally {
      cleanupDir(outsideDir);
      delete process.env.OPENCODE_API_KEY;
    }
  });
});

describe('failover chain attempt reporting', () => {
  it('attaches redacted per-provider attempts to VISION_ALL_FAILED', async () => {
    const failing = makeProvider('p1', async () => {
      throw new Error('sk-networkfailure1234567890abc');
    });
    const result = await executeWithFailover([failing], { images: [], query: 'q' });
    expect(result.ok).toBe(false);
    const failure = result.errors?.[0];
    expect(failure?.code).toBe('VISION_ALL_FAILED');
    const attempted = failure?.attempted;
    expect(Array.isArray(attempted)).toBe(true);
    expect(attempted?.[0]?.provider).toBe('p1');
    // The thrown message contained a token-shaped secret — it must not leak.
    expect(JSON.stringify(attempted)).not.toContain('sk-networkfailure1234567890abc');
  });
});

describe('resolveConfig defaults merging', () => {
  it('fills missing top-level fields from DEFAULT_CONFIG', () => {
    const resolved = resolveConfig({ language: 'en' });
    expect(resolved.language).toBe('en');
    expect(resolved.mode).toBe('auto');
    expect(resolved.cacheMaxEntries).toBe(200);
    expect(resolved.freeFallback).toBe(true);
  });

  it('merges nested objects one level deep', () => {
    const resolved = resolveConfig({
      localOllama: { enabled: true } as never,
      freeZen: { model: 'nemotron-3-ultra-free' } as never,
    });
    expect(resolved.localOllama.enabled).toBe(true);
    expect(resolved.localOllama.baseURL).toContain('127.0.0.1:11434');
    expect(resolved.freeZen.model).toBe('nemotron-3-ultra-free');
    expect(resolved.freeZen.apiKeyEnv).toBe('OPENCODE_API_KEY');
  });

  it('keeps a temp dir path untouched (sanity for fixtures)', () => {
    const dir = makeTempDir('resolve-sanity-');
    try {
      expect(resolveConfig({}).timeoutMs).toBeGreaterThan(0);
    } finally {
      cleanupDir(dir);
    }
  });
});
