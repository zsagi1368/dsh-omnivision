import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisionBridge } from '../../src/bridge/vision-bridge.ts';
import type { ImageAttachment, VisionDescription, VisionResult } from '../../src/config/types.ts';
import { createVisionCircuitBreaker } from '../../src/resilience/circuit.ts';
import { failureResult, makeProvider, okResult } from '../test-utils.ts';

function img(hash: string): ImageAttachment {
  return { path: `virtual-${hash}.png`, contentHash: hash, mime: 'image/png', bytes: 10 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VisionBridge.processImages', () => {
  it('manual mode performs no processing at all', async () => {
    const provider = makeProvider('mock', async () => okResult('x'));
    const bridge = new VisionBridge([provider], 'manual');
    expect(await bridge.processImages([img('h1')], 'q')).toEqual({
      descriptions: [],
      failures: [],
    });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('empty input short-circuits', async () => {
    const provider = makeProvider('mock', async () => okResult('x'));
    const bridge = new VisionBridge([provider], 'auto');
    expect(await bridge.processImages([], 'q')).toEqual({ descriptions: [], failures: [] });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('auto mode describes images through the failover chain', async () => {
    const provider = makeProvider('mock', async (options) =>
      okResult(`desc:${options.images[0]?.contentHash}`),
    );
    const bridge = new VisionBridge([provider], 'auto', {
      sessionId: 's1',
      totalTimeoutMs: 9999,
      providerTimeoutMs: 1234,
    });
    const result = await bridge.processImages([img('h1')], 'describe query');
    expect(result.failures).toEqual([]);
    expect(result.descriptions[0]?.summary).toBe('desc:h1');
    const call = provider.execute.mock.calls[0]?.[0];
    expect(call?.query).toBe('describe query');
    expect(call?.tool).toBe('vision_describe');
    expect(call?.timeoutMs).toBe(1234);
    expect(call?.images[0]).toMatchObject({
      kind: 'local',
      path: 'virtual-h1.png',
      contentHash: 'h1',
      mime: 'image/png',
    });
  });
});

describe('VisionBridge cache', () => {
  it('caches successes by (session, mode, contentHash, query)', async () => {
    const provider = makeProvider('mock', async () => okResult('same'));
    const bridge = new VisionBridge([provider], 'auto', { sessionId: 's1' });
    await bridge.processImages([img('h1')], 'q1');
    const second = await bridge.processImages([img('h1')], 'q1');
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(second.descriptions[0]?.summary).toBe('same');
    expect(bridge.stats().cached).toBe(1);
  });

  it('misses on a different query', async () => {
    const provider = makeProvider('mock', async () => okResult('same'));
    const bridge = new VisionBridge([provider], 'auto');
    await bridge.processImages([img('h1')], 'q1');
    await bridge.processImages([img('h1')], 'q2');
    expect(provider.execute).toHaveBeenCalledTimes(2);
  });

  it('misses across different sessionIds (two bridges)', async () => {
    const provider = makeProvider('mock', async () => okResult('same'));
    const b1 = new VisionBridge([provider], 'auto', { sessionId: 's1' });
    const b2 = new VisionBridge([provider], 'auto', { sessionId: 's2' });
    await b1.processImages([img('h1')], 'q');
    await b2.processImages([img('h1')], 'q');
    expect(provider.execute).toHaveBeenCalledTimes(2);
  });

  it('expires entries after cacheTtlMs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const provider = makeProvider('mock', async () => okResult('same'));
    const bridge = new VisionBridge([provider], 'auto', { cacheTtlMs: 100 });
    await bridge.processImages([img('h1')], 'q');
    vi.advanceTimersByTime(101);
    await bridge.processImages([img('h1')], 'q');
    expect(provider.execute).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used entries at cacheMaxEntries', async () => {
    const provider = makeProvider('mock', async (options) =>
      okResult(`d:${options.images[0]?.contentHash}`),
    );
    const bridge = new VisionBridge([provider], 'auto', { cacheMaxEntries: 2 });
    await bridge.processImages([img('h1')], 'q'); // cache: [h1], exec 1
    await bridge.processImages([img('h2')], 'q'); // cache: [h1, h2], exec 2
    await bridge.processImages([img('h1')], 'q'); // LRU refresh h1, still exec 2
    expect(provider.execute).toHaveBeenCalledTimes(2);
    await bridge.processImages([img('h3')], 'q'); // evicts LRU h2, exec 3
    expect(provider.execute).toHaveBeenCalledTimes(3);
    await bridge.processImages([img('h2')], 'q'); // h2 was evicted -> miss, exec 4
    expect(provider.execute).toHaveBeenCalledTimes(4);
    await bridge.processImages([img('h3')], 'q'); // h3 still cached
    expect(provider.execute).toHaveBeenCalledTimes(4);
  });

  it('cacheEnabled:false bypasses the cache entirely', async () => {
    const provider = makeProvider('mock', async () => okResult('same'));
    const bridge = new VisionBridge([provider], 'auto', { cacheEnabled: false });
    await bridge.processImages([img('h1')], 'q');
    await bridge.processImages([img('h1')], 'q');
    expect(provider.execute).toHaveBeenCalledTimes(2);
    expect(bridge.stats().cached).toBe(0);
  });

  it('clear() empties the cache', async () => {
    const provider = makeProvider('mock', async () => okResult('same'));
    const bridge = new VisionBridge([provider], 'auto');
    await bridge.processImages([img('h1')], 'q');
    expect(bridge.stats().cached).toBe(1);
    bridge.clear();
    expect(bridge.stats().cached).toBe(0);
  });
});

describe('VisionBridge failures', () => {
  it('reports per-image failures and never leaks "[Vision error" text', async () => {
    const provider = makeProvider('mock', async () => failureResult('SERVER', 'down', true));
    const bridge = new VisionBridge([provider], 'auto');
    const result = await bridge.processImages([img('h1'), img('h2')], 'q');
    expect(result.descriptions).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({
      index: 0,
      message: 'VISION_ALL_FAILED: All vision providers failed',
    });
    expect(result.failures[1]?.index).toBe(1);
    expect(JSON.stringify(result)).not.toContain('[Vision error');
  });

  it('mixed batches keep successes in order and index failures correctly', async () => {
    const provider = makeProvider('mock', async (options) => {
      const hash = options.images[0]?.contentHash;
      return hash === 'h-bad' ? failureResult('AUTH', 'no key', false) : okResult(`ok:${hash}`);
    });
    const bridge = new VisionBridge([provider], 'auto');
    const result = await bridge.processImages([img('h-a'), img('h-bad'), img('h-c')], 'q');
    expect(result.descriptions.map((d) => d.summary)).toEqual(['ok:h-a', 'ok:h-c']);
    expect(result.failures).toEqual([
      { index: 1, message: 'VISION_ALL_FAILED: All vision providers failed' },
    ]);
  });

  it('surfaces cancelled providers as structured failures (chain classifies, never rethrows)', async () => {
    // executeWithFailover catches thrown errors and classifies them; a
    // 'Cancelled' throw becomes non-retryable VISION_CANCELLED which stops the
    // chain, so the bridge reports VISION_ALL_FAILED instead of rejecting.
    const provider = makeProvider('mock', async () => {
      throw new Error('Cancelled');
    });
    const bridge = new VisionBridge([provider], 'auto');
    const result = await bridge.processImages([img('h1')], 'q');
    expect(result.descriptions).toEqual([]);
    expect(result.failures).toEqual([
      { index: 0, message: 'VISION_ALL_FAILED: All vision providers failed' },
    ]);
  });

  it('surfaces abort-style provider throws the same way', async () => {
    const provider = makeProvider('mock', async () => {
      throw new Error('This operation was aborted');
    });
    const bridge = new VisionBridge([provider], 'auto');
    const result = await bridge.processImages([img('h1')], 'q');
    expect(result.failures).toEqual([
      { index: 0, message: 'VISION_ALL_FAILED: All vision providers failed' },
    ]);
  });

  it('turns other thrown provider errors into structured failures', async () => {
    const provider = makeProvider('mock', async () => {
      throw new Error('weird provider crash');
    });
    const bridge = new VisionBridge([provider], 'auto');
    const result = await bridge.processImages([img('h1')], 'q');
    expect(result.descriptions).toEqual([]);
    // The chain classifies unknown throws as non-retryable and folds them into
    // the generic all-failed error; the original message is not surfaced.
    expect(result.failures).toEqual([
      { index: 0, message: 'VISION_ALL_FAILED: All vision providers failed' },
    ]);
  });

  it('shares the circuit breaker across processImages calls', async () => {
    const authFailer = makeProvider('auth-fail', async () =>
      failureResult('AUTH', 'no key', false),
    );
    const good = makeProvider('good', async () => okResult('fine'));
    const bridge = new VisionBridge([authFailer, good], 'auto', {
      circuitBreaker: createVisionCircuitBreaker(),
    });
    const first = await bridge.processImages([img('h1')], 'q'); // AUTH stops chain -> failure
    expect(first.descriptions).toEqual([]);
    expect(first.failures).toHaveLength(1);
    const second = await bridge.processImages([img('h2')], 'q'); // auth-fail now blocked
    expect(second.descriptions[0]?.summary).toBe('fine');
    expect(second.failures).toEqual([]);
    expect(authFailer.execute).toHaveBeenCalledTimes(1);
    expect(good.execute).toHaveBeenCalledTimes(1);
  });
});

describe('VisionBridge.processSummary', () => {
  it('joins summaries with a Chinese full stop', async () => {
    const provider = makeProvider('mock', async (options) =>
      okResult(`s:${options.images[0]?.contentHash}`),
    );
    const bridge = new VisionBridge([provider], 'interactive');
    const summary = await bridge.processSummary([img('h1'), img('h2')], 'q');
    expect(summary).toBe('s:h1。s:h2');
  });

  it('returns an empty string when nothing succeeded', async () => {
    const provider = makeProvider('mock', async () => failureResult('SERVER', 'down', true));
    const bridge = new VisionBridge([provider], 'interactive');
    expect(await bridge.processSummary([img('h1')], 'q')).toBe('');
  });
});

describe('description extraction', () => {
  async function runWithData(data: unknown): Promise<VisionDescription | undefined> {
    const provider = makeProvider('mock', async () => {
      const result: VisionResult = {
        ok: true,
        data,
        meta: { provider: 'mock', model: 'm', durationMs: 1 },
      };
      return result;
    });
    const bridge = new VisionBridge([provider], 'auto', { cacheEnabled: false });
    const { descriptions } = await bridge.processImages([img('h1')], 'q');
    return descriptions[0];
  }

  it('passes through structured fields', async () => {
    const description = await runWithData({
      summary: 'ok',
      ocr: 'text',
      regions: [{ type: 't', text: 'x', order: 1 }],
      entities: [{ name: 'n', type: 't' }],
      uncertainty: ['u'],
    });
    expect(description).toMatchObject({
      summary: 'ok',
      ocr: 'text',
      regions: [{ type: 't', text: 'x', order: 1 }],
      entities: [{ name: 'n', type: 't' }],
      uncertainty: ['u'],
    });
  });

  it('falls back when summary is empty', async () => {
    expect((await runWithData({ summary: '' }))?.summary).toBe('Image content processed');
  });

  it('falls back when data is not an object', async () => {
    expect((await runWithData('plain string'))?.summary).toBe(
      'Image processed (no structured data)',
    );
  });
});
