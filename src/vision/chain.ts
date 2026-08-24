/**
 * Failover chain — Tries providers in order until one succeeds
 * Supports persistent circuit breaker across calls
 */

import type { AttemptRecord, VisionExecuteOptions, VisionFailure } from '../config/types.ts';
import type { VisionCircuitBreaker } from '../resilience/circuit.ts';
import { createVisionCircuitBreaker } from '../resilience/circuit.ts';
import { getKnownSecrets, redactSecrets } from '../security/index.ts';
import type { VisionProvider, VisionResult } from './provider.ts';

export interface FailoverConfig {
  totalTimeoutMs?: number;
  providerTimeoutMs?: number;
}

export async function executeWithFailover(
  providers: VisionProvider[],
  options: VisionExecuteOptions,
  config: FailoverConfig = {},
  circuitBreaker?: VisionCircuitBreaker,
): Promise<VisionResult> {
  const { totalTimeoutMs = 120_000, providerTimeoutMs = 45_000 } = config;
  const attempts: AttemptRecord[] = [];
  // Use persistent breaker if provided, otherwise create new one
  const breaker = circuitBreaker ?? createVisionCircuitBreaker();
  const startTime = Date.now();
  const knownSecrets = getKnownSecrets();

  for (const provider of providers) {
    if (breaker.isBlocked(provider.name)) {
      attempts.push({ provider: provider.name, ok: false, error: 'Circuit breaker open' });
      continue;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeoutMs) {
      return {
        ok: false,
        meta: { provider: 'none', model: 'none', durationMs: elapsed },
        errors: [
          {
            kind: 'TIMEOUT',
            code: 'VISION_TOTAL_TIMEOUT',
            message: 'Request timed out',
            retryable: false,
          },
        ],
      };
    }

    try {
      const result = await provider.execute({
        ...options,
        signal: options.signal,
        timeoutMs: Math.min(providerTimeoutMs, totalTimeoutMs - elapsed),
      });

      if (result.ok) {
        breaker.record(provider.name, 'success');
        return { ...result, meta: { ...result.meta } };
      }

      const failure = result.errors?.[0];
      if (failure) {
        breaker.record(provider.name, failure);
        attempts.push({ provider: provider.name, ok: false, failure });
      }

      if (!failure?.retryable) {
        break;
      }
    } catch (error) {
      const failure = classifyError(error);
      breaker.record(provider.name, failure);
      attempts.push({
        provider: provider.name,
        ok: false,
        error: redactSecrets(failure.message, knownSecrets),
      });

      if (!failure.retryable) {
        break;
      }
    }
  }

  return {
    ok: false,
    meta: { provider: 'none', model: 'none', durationMs: Date.now() - startTime },
    errors: [
      {
        kind: 'OTHER',
        code: 'VISION_ALL_FAILED',
        message: `All vision providers failed`,
        retryable: false,
        advice: 'Check your configuration or try again later',
        // Redacted per-provider attempt details so callers can see WHY each
        // provider failed without leaking credentials.
        attempted: attempts.length > 0 ? attempts : undefined,
      },
    ],
  };
}

function classifyError(error: unknown): VisionFailure {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('abort') || msg.includes('cancel')) {
      return {
        kind: 'TIMEOUT',
        code: 'VISION_CANCELLED',
        message: 'Request cancelled',
        retryable: false,
      };
    }
    if (msg.includes('timeout')) {
      return {
        kind: 'TIMEOUT',
        code: 'VISION_TIMEOUT',
        message: 'Provider timeout',
        retryable: true,
      };
    }
    if (
      msg.includes('network') ||
      msg.includes('fetch') ||
      msg.includes('refused') ||
      msg.includes('econnrefused')
    ) {
      return {
        kind: 'NETWORK',
        code: 'VISION_NETWORK_ERROR',
        message: 'Network error',
        retryable: true,
      };
    }
    if (msg.includes('auth') || msg.includes('permission')) {
      return {
        kind: 'AUTH',
        code: 'VISION_AUTH_ERROR',
        message: 'Authentication failed',
        retryable: false,
      };
    }
  }
  return {
    kind: 'OTHER',
    code: 'VISION_UNKNOWN_ERROR',
    message: 'Unknown error',
    retryable: false,
  };
}
