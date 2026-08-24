import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisionFailure } from '../../src/config/types.ts';
import { VisionCircuitBreaker } from '../../src/resilience/circuit.ts';

function fail(kind: VisionFailure['kind']): VisionFailure {
  return { kind, code: 'VISION_TEST', message: 'x', retryable: false };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VisionCircuitBreaker', () => {
  it('does not block unknown providers', () => {
    const breaker = new VisionCircuitBreaker();
    expect(breaker.isBlocked('unknown')).toBe(false);
    expect(breaker.getTimeUntilReady('unknown')).toBe(0);
    expect(breaker.stats()).toEqual({ blocked: [], total: 0 });
  });

  it('success clears any state for the provider', () => {
    const breaker = new VisionCircuitBreaker();
    breaker.record('p', fail('AUTH'));
    expect(breaker.isBlocked('p')).toBe(true);
    breaker.record('p', 'success');
    expect(breaker.isBlocked('p')).toBe(false);
    expect(breaker.stats().total).toBe(0);
  });

  it('AUTH trips for authTripTtlMs and expires afterwards', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({ authTripTtlMs: 1000, defaultRateCooldownMs: 500 });
    breaker.record('p', fail('AUTH'));
    expect(breaker.isBlocked('p')).toBe(true);
    expect(breaker.getTimeUntilReady('p')).toBe(1000);
    vi.advanceTimersByTime(999);
    expect(breaker.isBlocked('p')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(breaker.isBlocked('p')).toBe(false);
    expect(breaker.stats().total).toBe(0); // expired entry pruned on check
  });

  it('REGION and TOS behave like AUTH', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({ authTripTtlMs: 2000, defaultRateCooldownMs: 100 });
    breaker.record('region-p', fail('REGION'));
    breaker.record('tos-p', fail('TOS'));
    expect(breaker.getTimeUntilReady('region-p')).toBe(2000);
    expect(breaker.getTimeUntilReady('tos-p')).toBe(2000);
  });

  it('RATE_LIMIT and QUOTA use defaultRateCooldownMs', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({ authTripTtlMs: 5000, defaultRateCooldownMs: 500 });
    breaker.record('rate-p', fail('RATE_LIMIT'));
    breaker.record('quota-p', fail('QUOTA'));
    expect(breaker.getTimeUntilReady('rate-p')).toBe(500);
    expect(breaker.getTimeUntilReady('quota-p')).toBe(500);
  });

  it('other kinds cool down for half the rate cooldown', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({ defaultRateCooldownMs: 500 });
    breaker.record('server-p', fail('SERVER'));
    expect(breaker.getTimeUntilReady('server-p')).toBe(250);
  });

  it('increments consecutive failures on repeated records', () => {
    const breaker = new VisionCircuitBreaker({ defaultRateCooldownMs: 60_000 });
    breaker.record('p', fail('RATE_LIMIT'));
    breaker.record('p', fail('RATE_LIMIT'));
    breaker.record('p', fail('RATE_LIMIT'));
    expect(breaker.isBlocked('p')).toBe(true);
    expect(breaker.stats().total).toBe(1); // same entry updated, not duplicated
  });

  it('stats lists only currently blocked providers', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({ authTripTtlMs: 1000, defaultRateCooldownMs: 100 });
    breaker.record('long-p', fail('AUTH'));
    breaker.record('short-p', fail('RATE_LIMIT'));
    vi.advanceTimersByTime(150); // short-p expired, long-p still blocked
    const stats = breaker.stats();
    expect(stats.blocked).toEqual(['long-p']);
    expect(stats.total).toBe(2); // entries pruned lazily
  });

  it('enforces maxEntries by evicting the entry with the earliest blockedUntil', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({
      authTripTtlMs: 10_000,
      defaultRateCooldownMs: 50,
      maxEntries: 2,
    });
    breaker.record('a', fail('AUTH')); // blockedUntil = 10_000
    vi.advanceTimersByTime(60);
    breaker.record('b', fail('RATE_LIMIT')); // blockedUntil = 110 (earlier than a's)
    breaker.record('c', fail('AUTH')); // exceeds capacity -> evict earliest (b), not oldest (a)
    expect(breaker.stats().total).toBe(2);
    expect(breaker.isBlocked('a')).toBe(true);
    expect(breaker.isBlocked('b')).toBe(false); // evicted
    expect(breaker.isBlocked('c')).toBe(true);
  });

  it('breaks blockedUntil ties by evicting the oldest inserted entry', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({ defaultRateCooldownMs: 1000, maxEntries: 2 });
    breaker.record('x', fail('RATE_LIMIT'));
    breaker.record('y', fail('RATE_LIMIT'));
    breaker.record('z', fail('RATE_LIMIT')); // tie between x and y -> x (oldest) evicted
    expect(breaker.stats().total).toBe(2);
    expect(breaker.isBlocked('x')).toBe(false);
    expect(breaker.stats().blocked).toEqual(['y', 'z']);
  });

  it('maxEntries <= 0 clears prior state before each insert (capacity of one)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const breaker = new VisionCircuitBreaker({ defaultRateCooldownMs: 1000, maxEntries: 0 });
    breaker.record('a', fail('RATE_LIMIT'));
    breaker.record('b', fail('RATE_LIMIT')); // clears a, then inserts b
    expect(breaker.stats().total).toBe(1);
    expect(breaker.isBlocked('a')).toBe(false);
    expect(breaker.isBlocked('b')).toBe(true);
  });

  it('clear() resets everything', () => {
    const breaker = new VisionCircuitBreaker();
    breaker.record('p', fail('AUTH'));
    breaker.clear();
    expect(breaker.isBlocked('p')).toBe(false);
    expect(breaker.stats()).toEqual({ blocked: [], total: 0 });
  });
});
