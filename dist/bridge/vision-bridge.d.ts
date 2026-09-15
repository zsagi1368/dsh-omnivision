import type { ImageAttachment, VisionDescription, VisionMode } from '../config/types.ts';
import type { VisionCircuitBreaker } from '../resilience/circuit.ts';
import type { VisionProvider } from '../vision/provider.ts';
export interface VisionBridgeOptions {
    /** Cache isolation scope (per DSH session) */
    sessionId?: string;
    /** Shared circuit breaker persisted across calls (owned by the plugin) */
    circuitBreaker?: VisionCircuitBreaker;
    /** Master cache switch (default: true) */
    cacheEnabled?: boolean;
    /** Cache TTL in milliseconds (default: 1 hour) */
    cacheTtlMs?: number;
    /** Maximum cache entries, true LRU (default: 100) */
    cacheMaxEntries?: number;
    /** Total budget for one image across the whole failover chain (default: 120s) */
    totalTimeoutMs?: number;
    /** Per-provider timeout inside the chain (default: 45s) */
    providerTimeoutMs?: number;
}
/** A single failed image. `index` is the position in the input array. */
export interface VisionBridgeFailure {
    index: number;
    message: string;
}
/**
 * Result of processing a batch of images.
 * - `descriptions`: successful results in input order (failures skipped)
 * - `failures`: per-image failures with the input index; NEVER rendered into
 *   model-visible content by this bridge.
 */
export interface VisionBatchResult {
    descriptions: VisionDescription[];
    failures: VisionBridgeFailure[];
}
export declare class VisionBridge {
    private providers;
    private mode;
    /** LRU cache: Map iteration order = least → most recently used */
    private completedResults;
    private readonly ttlMs;
    private readonly maxCacheEntries;
    private readonly cacheEnabled;
    private readonly totalTimeoutMs;
    private readonly providerTimeoutMs;
    private readonly sessionId?;
    private readonly circuitBreaker?;
    constructor(providers: VisionProvider[], mode: VisionMode, opts?: VisionBridgeOptions);
    /**
     * Process images and return successful descriptions plus per-image failures.
     * Never throws for provider errors; only aborts/cancellations propagate.
     */
    processImages(images: ImageAttachment[], query: string, signal?: AbortSignal): Promise<VisionBatchResult>;
    /**
     * Generate brief summaries joined into a single line (interactive mode).
     * Empty string when nothing succeeded.
     */
    processSummary(images: ImageAttachment[], query: string, signal?: AbortSignal): Promise<string>;
    /**
     * Stable cache key — hash(sessionId, mode, contentHash, query).
     * The FULL query is hashed (queries are stable templates, so identical
     * image + template → identical key; no slicing that could collide).
     */
    private createCacheKey;
    /**
     * Process single image through the failover chain.
     * Returns a success description or a failure message; only rethrows for
     * cancellation/abort so callers can stop the whole batch.
     */
    private processSingleImage;
    /** Cache get with TTL check + LRU refresh (delete & re-insert). */
    private getFromCache;
    private setCache;
    private extractDescription;
    clear(): void;
    stats(): {
        cached: number;
    };
}
//# sourceMappingURL=vision-bridge.d.ts.map