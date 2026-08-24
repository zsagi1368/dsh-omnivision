import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisionExecuteOptions } from '../../src/config/types.ts';
import { createVisionCircuitBreaker } from '../../src/resilience/circuit.ts';
import { executeWithFailover } from '../../src/vision/chain.ts';
import { authFailure, failureResult, makeProvider, okResult } from '../test-utils.ts';

const options: VisionExecuteOptions = { images: [], query: 'q' };

afterEach(() => {
  vi.useRealTimers();
});

describe('executeWithFailover', () => {
  it('returns the first success without trying later providers', async () => {
    const breaker = createVisionCircuitBreaker();
    const p1 = makeProvider('p1', async () => okResult('first'));
    const p2 = makeProvider('p2', async () => okResult('second'));
    const result = await executeWithFailover([p1, p2], options, {}, breaker);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'first' });
    expect(p2.execute).not.toHaveBeenCalled();
    expect(breaker.stats().total).toBe(0); // success cleared the state
  });

  it('falls through retryable failures to the next provider', async () => {
    const p1 = makeProvider('p1', async () => failureResult('SERVER', 'down', true));
    const p2 = makeProvider('p2', async () => okResult('second'));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'second' });
    expect(p1.execute).toHaveBeenCalledTimes(1);
    expect(p2.execute).toHaveBeenCalledTimes(1);
  });

  it('stops the chain on a non-retryable failure even if providers remain', async () => {
    const p1 = makeProvider('p1', async () => ({
      ok: false,
      meta: { provider: 'p1', model: 'm', durationMs: 1 },
      errors: [authFailure()],
    }));
    const p2 = makeProvider('p2', async () => okResult('never'));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.code).toBe('VISION_ALL_FAILED');
    expect(result.errors?.[0]?.retryable).toBe(false);
    expect(p2.execute).not.toHaveBeenCalled();
  });

  it('skips providers blocked by the circuit breaker', async () => {
    const breaker = createVisionCircuitBreaker();
    breaker.record('p1', authFailure());
    const p1 = makeProvider('p1', async () => okResult('blocked'));
    const p2 = makeProvider('p2', async () => okResult('second'));
    const result = await executeWithFailover([p1, p2], options, {}, breaker);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'second' });
    expect(p1.execute).not.toHaveBeenCalled();
    expect(breaker.isBlocked('p1')).toBe(true);
  });

  it('classifies thrown network errors as retryable and continues', async () => {
    const p1 = makeProvider('p1', async () => {
      throw new Error('fetch failed');
    });
    const p2 = makeProvider('p2', async () => okResult('second'));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ summary: 'second' });
    expect(p1.execute).toHaveBeenCalledTimes(1);
  });

  it('classifies ECONNREFUSED-style errors as network/retryable', async () => {
    const p1 = makeProvider('p1', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });
    const p2 = makeProvider('p2', async () => okResult('second'));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(true);
    expect(p2.execute).toHaveBeenCalledTimes(1);
  });

  it('classifies thrown auth errors as non-retryable and stops the chain', async () => {
    const p1 = makeProvider('p1', async () => {
      throw new Error('401 Unauthorized: bad auth');
    });
    const p2 = makeProvider('p2', async () => okResult('never'));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.code).toBe('VISION_ALL_FAILED');
    expect(p2.execute).not.toHaveBeenCalled();
  });

  it('classifies thrown abort errors as non-retryable cancellations', async () => {
    const p1 = makeProvider('p1', async () => {
      throw new Error('Request aborted by user');
    });
    const p2 = makeProvider('p2', async () => okResult('never'));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(false);
    expect(p2.execute).not.toHaveBeenCalled();
  });

  it('classifies thrown timeout errors as retryable', async () => {
    const p1 = makeProvider('p1', async () => {
      throw new Error('Request timeout after 30s');
    });
    const p2 = makeProvider('p2', async () => okResult('second'));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(true);
    expect(p2.execute).toHaveBeenCalledTimes(1);
  });

  it('returns VISION_TOTAL_TIMEOUT once the budget is exhausted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p1 = makeProvider('p1', async () => {
      vi.advanceTimersByTime(5000);
      return failureResult('SERVER', 'slow', true);
    });
    const p2 = makeProvider('p2', async () => okResult('never'));
    const result = await executeWithFailover([p1, p2], options, {
      totalTimeoutMs: 1000,
      providerTimeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.code).toBe('VISION_TOTAL_TIMEOUT');
    expect(result.errors?.[0]?.kind).toBe('TIMEOUT');
    expect(result.errors?.[0]?.retryable).toBe(false);
    expect(p2.execute).not.toHaveBeenCalled();
  });

  it('passes the smaller of providerTimeoutMs and the remaining budget', async () => {
    const p1 = makeProvider('p1', async () => okResult('fast'));
    await executeWithFailover([p1], options, { totalTimeoutMs: 100_000, providerTimeoutMs: 5000 });
    expect(p1.execute.mock.calls[0]?.[0]?.timeoutMs).toBe(5000);
  });

  it('reports VISION_ALL_FAILED with advice when every provider fails', async () => {
    const p1 = makeProvider('p1', async () => failureResult('RATE_LIMIT', 'lim', true));
    const p2 = makeProvider('p2', async () => failureResult('SERVER', 'boom', true));
    const result = await executeWithFailover([p1, p2], options);
    expect(result.ok).toBe(false);
    expect(result.meta.provider).toBe('none');
    expect(result.errors?.[0]).toMatchObject({
      code: 'VISION_ALL_FAILED',
      message: 'All vision providers failed',
      advice: 'Check your configuration or try again later',
    });
  });

  it('fails immediately with an empty provider list', async () => {
    const result = await executeWithFailover([], options);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.code).toBe('VISION_ALL_FAILED');
  });

  it('shares one breaker across calls: a tripped provider is skipped next time', async () => {
    const breaker = createVisionCircuitBreaker();
    const p1 = makeProvider('p1', async () => ({
      ok: false,
      meta: { provider: 'p1', model: 'm', durationMs: 1 },
      errors: [authFailure()],
    }));
    const p2 = makeProvider('p2', async () => okResult('second'));
    const first = await executeWithFailover([p1, p2], options, {}, breaker);
    expect(first.ok).toBe(false); // AUTH stopped the chain before p2
    const second = await executeWithFailover([p1, p2], options, {}, breaker);
    expect(second.ok).toBe(true);
    expect(second.data).toEqual({ summary: 'second' });
    expect(p1.execute).toHaveBeenCalledTimes(1); // skipped on the second call
    expect(p2.execute).toHaveBeenCalledTimes(1);
  });
});
