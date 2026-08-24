import { symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDescribeQuery,
  buildSummaryQuery,
  buildToolHint,
} from '../../src/bridge/message-rewriter.ts';
import type { OmniVisionConfig } from '../../src/config/schema.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import * as publicApi from '../../src/index.ts';
import { OmniVisionPlugin } from '../../src/plugin/index.ts';
import { registerTool } from '../../src/tools/index.ts';
import {
  captureEnv,
  cleanupDir,
  failureResult,
  makeProvider,
  makeTempDir,
  okResult,
  writePng,
} from '../test-utils.ts';

// Hermetic: no DNS, no HTTP. Real providers (ovh fallback) are disabled via
// freeFallback:false in every config, and fetch is stubbed defensively.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => ({ address: '8.8.8.8', family: 4 })),
}));

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let workspace: string;
let restoreEnv: () => void;

function makeConfig(overrides: Partial<OmniVisionConfig> = {}): OmniVisionConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.freeFallback = false; // isolate the chain to extraProviders
  Object.assign(config, overrides);
  return config;
}

function goodProvider() {
  return makeProvider('mock-good', async () => okResult('a test image', 'mock-good'));
}

function buildPlugin(
  providers: ReturnType<typeof goodProvider>[],
  config: OmniVisionConfig = makeConfig(),
  sessionId?: string,
): OmniVisionPlugin {
  return new OmniVisionPlugin({ config, workspace, sessionId, extraProviders: providers });
}

function attach(name: string, hash: string) {
  return { path: join(workspace, name), contentHash: hash, mime: 'image/png' };
}

beforeAll(() => {
  workspace = makeTempDir('omnivision-e2e-');
});

afterAll(() => {
  cleanupDir(workspace);
});

beforeEach(() => {
  restoreEnv = captureEnv(['ZAI_API_KEY', 'OPENCODE_API_KEY', 'OPENAI_API_KEY']);
  delete process.env.ZAI_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  );
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
});

describe('OmniVisionPlugin.processMessage', () => {
  it('rewrites a single image into a text marker and records shadows', async () => {
    writePng(workspace, 'a.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider], makeConfig(), 'session-1');
    const result = await plugin.processMessage('这张图是什么', [attach('a.png', 'h-a')], 'event-1');
    expect(result.rewritten).toBe(true);
    expect(result.imageCount).toBe(1);
    expect(result.descriptions).toEqual(['a test image']);
    expect(result.newContent).toBe('这张图是什么\n\n[已识图1: a test image]');
    expect(result.hasErrors).toBe(false);
    expect(result.failures).toBeUndefined();
    expect(result.shadows).toHaveLength(1);
    expect(result.shadows?.[0]?.surfaceOp).toEqual({ op: 'keep', eventId: 'event-1' });
    expect(result.shadows?.[0]?.modelOp).toMatchObject({ op: 'replace', eventId: 'event-1' });
    // The provider query is ALWAYS the stable template, never raw user content.
    expect(provider.execute.mock.calls[0]?.[0]?.query).toBe(buildDescribeQuery('zh', 'standard'));
  });

  it('describes multiple images in order', async () => {
    writePng(workspace, 'a.png');
    writePng(workspace, 'b.png');
    const provider = makeProvider('mock-multi', async (options) =>
      okResult(`desc:${options.images[0]?.contentHash}`, 'mock-multi'),
    );
    const plugin = buildPlugin([provider]);
    const result = await plugin.processMessage('看下', [
      attach('a.png', 'h-a'),
      attach('b.png', 'h-b'),
    ]);
    expect(result.rewritten).toBe(true);
    expect(result.imageCount).toBe(2);
    expect(result.descriptions).toEqual(['desc:h-a', 'desc:h-b']);
    expect(result.newContent).toBe(
      '看下\n\n已识图2张：\n\n[已识图1: desc:h-a]\n\n[已识图2: desc:h-b]',
    );
  });

  it('HEADLINE: user text changes but the cache still hits (stable query template)', async () => {
    writePng(workspace, 'stable.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    const first = await plugin.processMessage('what is this image', [attach('stable.png', 'h-s')]);
    const second = await plugin.processMessage(
      'completely different question, tell me everything',
      [attach('stable.png', 'h-s')],
    );
    expect(first.rewritten).toBe(true);
    expect(second.rewritten).toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(1); // cache hit on second message
    expect(second.newContent).toContain('[已识图1: a test image]');
    expect(plugin.stats().cache.cached).toBe(1);
  });

  it('a different contentHash misses the cache', async () => {
    writePng(workspace, 'stable.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    await plugin.processMessage('same words', [attach('stable.png', 'h-s')]);
    await plugin.processMessage('same words', [attach('stable.png', 'h-other')]);
    expect(provider.execute).toHaveBeenCalledTimes(2);
  });

  it('manual mode leaves the message untouched', async () => {
    writePng(workspace, 'm.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider], makeConfig({ mode: 'manual' }));
    const result = await plugin.processMessage('untouched text', [attach('m.png', 'h-m')]);
    expect(result.rewritten).toBe(false);
    expect(result.newContent).toBe('untouched text');
    expect(result.imageCount).toBe(1);
    expect(result.descriptions).toEqual([]);
    expect(result.shadows).toBeUndefined();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('messages without attachments pass through', async () => {
    const plugin = buildPlugin([goodProvider()]);
    const result = await plugin.processMessage('plain question');
    expect(result).toEqual({
      rewritten: false,
      newContent: 'plain question',
      imageCount: 0,
      descriptions: [],
      hasErrors: false,
      failures: undefined,
    });
  });

  it('all-fail returns the ORIGINAL content with structured provider failures', async () => {
    writePng(workspace, 'fail.png');
    const bad = makeProvider('mock-bad', async () => failureResult('SERVER', 'down', true));
    const plugin = buildPlugin([bad]);
    const original = 'original text stays byte-for-byte';
    const result = await plugin.processMessage(original, [attach('fail.png', 'h-f')]);
    expect(result.rewritten).toBe(false);
    expect(result.newContent).toBe(original);
    expect(result.hasErrors).toBe(true);
    expect(result.descriptions).toEqual([]);
    expect(result.failures?.[0]).toMatchObject({ index: 0, reason: 'provider' });
    expect(result.failures?.[0]?.message).toContain('VISION_ALL_FAILED');
  });

  it('oversized files fail with reason "too_large"', async () => {
    const big = join(workspace, 'big.png');
    writeFileSync(big, Buffer.alloc(10));
    const provider = goodProvider();
    const plugin = buildPlugin([provider], makeConfig({ maxImageBytes: 4 }));
    const result = await plugin.processMessage('x', [attach('big.png', 'h-big')]);
    expect(result.rewritten).toBe(false);
    expect(result.newContent).toBe('x');
    expect(result.failures?.[0]?.reason).toBe('too_large');
    expect(result.failures?.[0]?.message).toContain('maxImageBytes');
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('paths outside workspace and temp are silently skipped (not failures)', async () => {
    const outside = join(PROJECT_ROOT, 'package.json'); // exists, outside both roots
    writePng(workspace, 'in.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    const result = await plugin.processMessage('hello', [
      { path: outside, contentHash: 'h-out' },
      attach('in.png', 'h-in'),
    ]);
    expect(result.imageCount).toBe(1);
    expect(result.failures).toBeUndefined();
    expect(result.rewritten).toBe(true);
  });

  it('invalid attachment shapes and missing files are skipped silently', async () => {
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    const result = await plugin.processMessage('x', [
      null,
      42,
      { noPath: true },
      { path: join(workspace, 'missing.png'), contentHash: 'h-missing' },
    ]);
    expect(result.imageCount).toBe(0);
    expect(result.failures).toBeUndefined();
    expect(result.rewritten).toBe(false);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('symlinks fail with reason "symlink" (skipped where the platform denies)', async () => {
    const target = writePng(workspace, 'target.png');
    const link = join(workspace, 'link.png');
    let created = true;
    try {
      symlinkSync(target, link);
    } catch {
      created = false; // Windows without symlink privilege — soft skip
    }
    if (!created) return;
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    const result = await plugin.processMessage('x', [{ path: link, contentHash: 'h-link' }]);
    expect(result.rewritten).toBe(false);
    expect(result.failures?.[0]).toMatchObject({ reason: 'symlink' });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('interactive mode uses the summary template and appends the tool hint', async () => {
    writePng(workspace, 'i.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider], makeConfig({ mode: 'interactive' }));
    const result = await plugin.processMessage('瞅一眼', [attach('i.png', 'h-i')]);
    expect(result.rewritten).toBe(true);
    expect(result.newContent).toBe(`瞅一眼\n\n[已识图1: a test image]\n\n${buildToolHint('zh')}`);
    expect(provider.execute.mock.calls[0]?.[0]?.query).toBe(buildSummaryQuery('zh'));
  });

  it('english output uses [Image N: ...] markers and the en template', async () => {
    writePng(workspace, 'en.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider], makeConfig({ language: 'en' }));
    const result = await plugin.processMessage('look at this', [attach('en.png', 'h-en')]);
    expect(result.newContent).toBe('look at this\n\n[Image 1: a test image]');
    expect(provider.execute.mock.calls[0]?.[0]?.query).toBe(buildDescribeQuery('en', 'standard'));
  });

  it('cancelled providers surface as provider failures, not content corruption', async () => {
    writePng(workspace, 'c.png');
    const canceling = makeProvider('mock-cancel', async () => {
      throw new Error('Cancelled');
    });
    const plugin = buildPlugin([canceling]);
    const original = 'text must survive';
    const result = await plugin.processMessage(original, [attach('c.png', 'h-c')]);
    expect(result.rewritten).toBe(false);
    expect(result.newContent).toBe(original);
    expect(result.failures?.[0]).toMatchObject({ index: 0, reason: 'provider' });
  });
});

describe('OmniVisionPlugin.callTool', () => {
  it('dispatches vision_describe with a validated image and query override', async () => {
    writePng(workspace, 'tool.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    const result = await plugin.callTool('vision_describe', {
      image: attach('tool.png', 'h-tool'),
      query: 'focus on colors',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'a test image' });
    expect(provider.execute.mock.calls[0]?.[0]?.query).toBe('focus on colors');
  });

  it('falls back to the stable template without a query', async () => {
    writePng(workspace, 'tool2.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    const result = await plugin.callTool('vision_describe', {
      image: attach('tool2.png', 'h-tool2'),
    });
    expect(result.ok).toBe(true);
    expect(provider.execute.mock.calls[0]?.[0]?.query).toBe(buildDescribeQuery('zh', 'standard'));
  });

  it('unknown tools list the available ones', async () => {
    const plugin = buildPlugin([goodProvider()]);
    const result = await plugin.callTool('vision_nope');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown tool: vision_nope');
    expect(result.error).toContain('vision_describe');
  });

  it('missing required arguments are rejected', async () => {
    const plugin = buildPlugin([goodProvider()]);
    const result = await plugin.callTool('vision_describe', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Missing required argument: image');
  });

  it('invalid image attachments are rejected', async () => {
    const plugin = buildPlugin([goodProvider()]);
    const outside = { path: join(PROJECT_ROOT, 'package.json'), contentHash: 'h-out' };
    const result = await plugin.callTool('vision_describe', { image: outside });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid image attachment');
  });

  it('thrown provider errors fold into the generic all-failed error', async () => {
    writePng(workspace, 'boom.png');
    const boomer = makeProvider('mock-boom', async () => {
      throw new Error('provider exploded with secret sk-aaaaaaaaaaaaaaaaaaaa');
    });
    const plugin = buildPlugin([boomer]);
    const result = await plugin.callTool('vision_describe', {
      image: attach('boom.png', 'h-boom'),
    });
    expect(result.ok).toBe(false);
    // The chain classifies and swallows the throw; only VISION_ALL_FAILED and
    // its fixed message surface (the secret never leaks either way).
    expect(result.error).toBe('VISION_ALL_FAILED: All vision providers failed');
  });

  it('non-image tools run without an image', async () => {
    const plugin = buildPlugin([goodProvider()]);
    const result = await plugin.callTool('vision_trace', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not implemented yet');
  });

  it('handler exceptions are caught and returned as redacted errors', async () => {
    process.env.OPENAI_API_KEY = 'sk-known-secret-abcdefghijklmn'; // restored in afterEach
    registerTool({
      name: 'vision_test_throw',
      description: 'always throws',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('handler blew up with sk-known-secret-abcdefghijklmn');
      },
    });
    const plugin = buildPlugin([goodProvider()]);
    const result = await plugin.callTool('vision_test_throw', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('handler blew up');
    expect(result.error).not.toContain('sk-known-secret-abcdefghijklmn'); // redacted
    expect(result.error).toContain('[REDACTED');
  });
});

describe('OmniVisionPlugin lifecycle', () => {
  it('stats() reports cache, circuit and provider counts; dispose() clears them', async () => {
    writePng(workspace, 's.png');
    const provider = goodProvider();
    const plugin = buildPlugin([provider]);
    await plugin.processMessage('x', [attach('s.png', 'h-s')]);
    const stats = plugin.stats();
    expect(stats).toEqual({
      cache: { cached: 1 },
      circuit: { blocked: [], total: 0 },
      providers: 1,
    });
    plugin.dispose();
    expect(plugin.stats()).toEqual({
      cache: { cached: 0 },
      circuit: { blocked: [], total: 0 },
      providers: 1,
    });
  });

  it('createOmnivisionPlugin builds an equivalent plugin', async () => {
    writePng(workspace, 'factory.png');
    const provider = goodProvider();
    const plugin = publicApi.createOmnivisionPlugin({
      config: makeConfig(),
      workspace,
      extraProviders: [provider],
    });
    const result = await plugin.processMessage('x', [attach('factory.png', 'h-fac')]);
    expect(result.rewritten).toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });
});

describe('public exports', () => {
  it('exposes the documented plugin surface', () => {
    expect(typeof publicApi.OmniVisionPlugin).toBe('function');
    expect(typeof publicApi.createOmnivisionPlugin).toBe('function');
    expect(typeof publicApi.registerTool).toBe('function');
    expect(typeof publicApi.getTool).toBe('function');
    expect(typeof publicApi.listTools).toBe('function');
    expect(publicApi.toolRegistry).toBeInstanceOf(Map);
    // Config helpers are part of the public surface for partial-config users.
    expect((publicApi as Record<string, unknown>).DEFAULT_CONFIG).toBeTypeOf('object');
    expect((publicApi as Record<string, unknown>).validateConfig).toBeTypeOf('function');
    expect((publicApi as Record<string, unknown>).resolveConfig).toBeTypeOf('function');
  });
});
