/**
 * Failover chain — Tries providers in order until one succeeds
 * Supports persistent circuit breaker across calls
 */
import type { VisionExecuteOptions } from '../config/types.ts';
import type { VisionCircuitBreaker } from '../resilience/circuit.ts';
import type { VisionProvider, VisionResult } from './provider.ts';
export interface FailoverConfig {
    totalTimeoutMs?: number;
    providerTimeoutMs?: number;
}
export declare function executeWithFailover(providers: VisionProvider[], options: VisionExecuteOptions, config?: FailoverConfig, circuitBreaker?: VisionCircuitBreaker): Promise<VisionResult>;
//# sourceMappingURL=chain.d.ts.map