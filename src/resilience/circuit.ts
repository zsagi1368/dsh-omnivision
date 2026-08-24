/**
 * Circuit Breaker — Prevents cascading failures
 */
import type { VisionFailure } from '../config/types.ts';

interface CircuitState {
  blockedUntil: number;
  consecutiveFailures: number;
  lastFailure: VisionFailure | null;
}

export interface CircuitBreakerOptions {
  authTripTtlMs?: number;
  defaultRateCooldownMs?: number;
  maxEntries?: number;
}

export class VisionCircuitBreaker {
  private states = new Map<string, CircuitState>();
  private options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      authTripTtlMs: options.authTripTtlMs ?? 10 * 60 * 1000,
      defaultRateCooldownMs: options.defaultRateCooldownMs ?? 60 * 1000,
      maxEntries: options.maxEntries ?? 128,
    };
  }

  isBlocked(provider: string): boolean {
    const state = this.states.get(provider);
    if (!state) return false;
    if (state.blockedUntil > Date.now()) return true;
    this.states.delete(provider);
    return false;
  }

  record(provider: string, result: 'success' | VisionFailure): void {
    if (result === 'success') {
      this.states.delete(provider);
      return;
    }

    const ttlMs = this.getTtlForKind(result.kind);
    const blockedUntil = ttlMs > 0 ? Date.now() + ttlMs : 0;

    const existing = this.states.get(provider);
    if (existing) {
      existing.blockedUntil = blockedUntil;
      existing.consecutiveFailures += 1;
      existing.lastFailure = result;
    } else {
      this.evictToCapacity();
      this.states.set(provider, {
        blockedUntil,
        consecutiveFailures: 1,
        lastFailure: result,
      });
    }
  }

  /**
   * Enforce maxEntries before inserting a new provider state: evict the
   * entry with the earliest blockedUntil (ties broken by insertion order —
   * Map iteration is insertion-ordered, and strict `<` keeps the oldest).
   */
  private evictToCapacity(): void {
    if (this.options.maxEntries <= 0) {
      this.states.clear();
      return;
    }
    while (this.states.size >= this.options.maxEntries) {
      let evictKey: string | undefined;
      let evictBlockedUntil = Number.POSITIVE_INFINITY;
      for (const [key, state] of this.states) {
        if (state.blockedUntil < evictBlockedUntil) {
          evictBlockedUntil = state.blockedUntil;
          evictKey = key;
        }
      }
      if (evictKey === undefined) break;
      this.states.delete(evictKey);
    }
  }

  getTimeUntilReady(provider: string): number {
    const state = this.states.get(provider);
    if (!state || state.blockedUntil === 0) return 0;
    return Math.max(0, state.blockedUntil - Date.now());
  }

  private getTtlForKind(kind: string): number {
    switch (kind) {
      case 'AUTH':
      case 'REGION':
      case 'TOS':
        return this.options.authTripTtlMs;
      case 'RATE_LIMIT':
      case 'QUOTA':
        return this.options.defaultRateCooldownMs;
      default:
        return Math.floor(this.options.defaultRateCooldownMs / 2);
    }
  }

  clear(): void {
    this.states.clear();
  }

  stats(): { blocked: string[]; total: number } {
    const blocked = Array.from(this.states.entries())
      .filter(([, s]) => s.blockedUntil > Date.now())
      .map(([p]) => p);
    return { blocked, total: this.states.size };
  }
}

export function createVisionCircuitBreaker(options?: CircuitBreakerOptions): VisionCircuitBreaker {
  return new VisionCircuitBreaker(options);
}
