/**
 * Vision Bridge — Core innovation of DSH Omnivision
 *
 * All image processing happens BEFORE DeepSeek sees the request.
 * DeepSeek always receives pure text → KV cache never affected.
 *
 * Batch results separate successes from failures: a failed image NEVER
 * injects error text into the model-visible content. Callers decide how to
 * surface `failures` (logs, UI, tool responses) — never as content markers.
 */
import { createHash } from 'node:crypto';
import type {
  ImageAttachment,
  VisionDescription,
  VisionExecuteOptions,
  VisionMode,
} from '../config/types.ts';
import type { VisionCircuitBreaker } from '../resilience/circuit.ts';
import { getKnownSecrets, redactSecrets } from '../security/index.ts';
import { executeWithFailover } from '../vision/chain.ts';
import type { VisionProvider } from '../vision/provider.ts';

interface CacheEntry {
  description: VisionDescription;
  expiresAt: number;
}

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

const DEFAULT_TTL_MS = 3600_000;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 45_000;

type SingleImageResult =
  | { ok: true; description: VisionDescription }
  | { ok: false; message: string };

export class VisionBridge {
  /** LRU cache: Map iteration order = least → most recently used */
  private completedResults = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxCacheEntries: number;
  private readonly cacheEnabled: boolean;
  private readonly totalTimeoutMs: number;
  private readonly providerTimeoutMs: number;
  private readonly sessionId?: string;
  private readonly circuitBreaker?: VisionCircuitBreaker;

  constructor(
    private providers: VisionProvider[],
    private mode: VisionMode,
    opts: VisionBridgeOptions = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.maxCacheEntries = opts.cacheMaxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.cacheEnabled = opts.cacheEnabled ?? true;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.providerTimeoutMs = opts.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.sessionId = opts.sessionId;
    this.circuitBreaker = opts.circuitBreaker;
  }

  /**
   * Process images and return successful descriptions plus per-image failures.
   * Never throws for provider errors; only aborts/cancellations propagate.
   */
  async processImages(
    images: ImageAttachment[],
    query: string,
    signal?: AbortSignal,
  ): Promise<VisionBatchResult> {
    if (images.length === 0 || this.mode === 'manual') {
      return { descriptions: [], failures: [] };
    }

    const settled = await Promise.allSettled(
      images.map((image) => this.processSingleImage(image, query, signal)),
    );

    const descriptions: VisionDescription[] = [];
    const failures: VisionBridgeFailure[] = [];
    const knownSecrets = getKnownSecrets();
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === 'fulfilled') {
        if (result.value.ok) descriptions.push(result.value.description);
        else failures.push({ index, message: redactSecrets(result.value.message, knownSecrets) });
        continue;
      }
      // processSingleImage only rejects on cancellation — let it propagate.
      throw result.reason;
    }
    return { descriptions, failures };
  }

  /**
   * Generate brief summaries joined into a single line (interactive mode).
   * Empty string when nothing succeeded.
   */
  async processSummary(
    images: ImageAttachment[],
    query: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { descriptions } = await this.processImages(images, query, signal);
    if (descriptions.length === 0) return '';
    return descriptions.map((d) => d.summary).join('。');
  }

  /**
   * Stable cache key — hash(sessionId, mode, contentHash, query).
   * The FULL query is hashed (queries are stable templates, so identical
   * image + template → identical key; no slicing that could collide).
   */
  private createCacheKey(image: ImageAttachment, query: string): string {
    return createHash('sha256')
      .update(this.sessionId ?? 'default')
      .update(this.mode)
      .update(image.contentHash)
      .update(query)
      .digest('hex');
  }

  /**
   * Process single image through the failover chain.
   * Returns a success description or a failure message; only rethrows for
   * cancellation/abort so callers can stop the whole batch.
   */
  private async processSingleImage(
    image: ImageAttachment,
    query: string,
    signal?: AbortSignal,
  ): Promise<SingleImageResult> {
    const cacheKey = this.createCacheKey(image, query);

    const cached = this.getFromCache(cacheKey);
    if (cached) return { ok: true, description: cached };

    try {
      const options: VisionExecuteOptions = {
        images: [
          {
            kind: 'local' as const,
            path: image.path,
            contentHash: image.contentHash,
            mime: image.mime,
          },
        ],
        query,
        tool: 'vision_describe',
        signal,
        timeoutMs: this.providerTimeoutMs,
      };

      const result = await executeWithFailover(
        this.providers,
        options,
        { totalTimeoutMs: this.totalTimeoutMs, providerTimeoutMs: this.providerTimeoutMs },
        this.circuitBreaker,
      );

      if (result.ok && result.data) {
        const description = this.extractDescription(result.data);
        this.setCache(cacheKey, description);
        return { ok: true, description };
      }

      // All providers failed — report as a structured failure (no error text
      // ever reaches model-visible content).
      const failure = result.errors?.[0];
      const message = failure ? `${failure.code}: ${failure.message}` : 'Unknown error';
      return { ok: false, message };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'Cancelled' || msg.toLowerCase().includes('abort')) throw error;
      return { ok: false, message: msg };
    }
  }

  /** Cache get with TTL check + LRU refresh (delete & re-insert). */
  private getFromCache(key: string): VisionDescription | undefined {
    const entry = this.completedResults.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.completedResults.delete(key);
      return undefined;
    }
    // True LRU: refresh recency on hit.
    this.completedResults.delete(key);
    this.completedResults.set(key, entry);
    return entry.description;
  }

  private setCache(key: string, description: VisionDescription): void {
    if (!this.cacheEnabled) return;
    if (this.maxCacheEntries <= 0) return;
    if (this.completedResults.size >= this.maxCacheEntries && !this.completedResults.has(key)) {
      // First key in iteration order = least recently used.
      const oldestKey = this.completedResults.keys().next().value;
      if (oldestKey) this.completedResults.delete(oldestKey);
    }
    this.completedResults.set(key, {
      description,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  private extractDescription(data: unknown): VisionDescription {
    if (!data || typeof data !== 'object') {
      return { summary: 'Image processed (no structured data)' };
    }
    const d = data as Record<string, unknown>;
    const summary = typeof d.summary === 'string' ? d.summary : '';
    return {
      summary: summary || 'Image content processed',
      ocr: typeof d.ocr === 'string' ? d.ocr : undefined,
      regions: (d.regions as Array<{ type: string; text: string; order: number }>) ?? undefined,
      entities:
        (d.entities as Array<{ name: string; type: string; evidence?: string }>) ?? undefined,
      uncertainty: (d.uncertainty as string[]) ?? undefined,
      raw: d,
    };
  }

  clear(): void {
    this.completedResults.clear();
  }

  stats(): { cached: number } {
    return { cached: this.completedResults.size };
  }
}
