/**
 * Circuit Breaker — Prevents cascading failures
 */
import type { VisionFailure } from '../config/types.ts';
export interface CircuitBreakerOptions {
    authTripTtlMs?: number;
    defaultRateCooldownMs?: number;
    maxEntries?: number;
}
export declare class VisionCircuitBreaker {
    private states;
    private options;
    constructor(options?: CircuitBreakerOptions);
    isBlocked(provider: string): boolean;
    record(provider: string, result: 'success' | VisionFailure): void;
    /**
     * Enforce maxEntries before inserting a new provider state: evict the
     * entry with the earliest blockedUntil (ties broken by insertion order —
     * Map iteration is insertion-ordered, and strict `<` keeps the oldest).
     */
    private evictToCapacity;
    getTimeUntilReady(provider: string): number;
    private getTtlForKind;
    clear(): void;
    stats(): {
        blocked: string[];
        total: number;
    };
}
export declare function createVisionCircuitBreaker(options?: CircuitBreakerOptions): VisionCircuitBreaker;
//# sourceMappingURL=circuit.d.ts.map