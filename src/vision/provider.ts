/**
 * Provider interface and types
 */
import type { VisionExecuteOptions, VisionFailure, VisionResult } from '../config/types.ts';

export type { VisionFailure, VisionResult };

export interface VisionProvider {
  /** Unique provider name */
  name: string;
  /** Default model to use */
  defaultModel: string;
  /** Provider category */
  category: 'api' | 'local' | 'free';
  /** Speed class (affects failover ordering) */
  speedClass: 'fast' | 'medium' | 'slow';

  /** Execute vision request */
  execute(options: VisionExecuteOptions): Promise<VisionResult>;

  /** Optional: custom failure description */
  describeFailure?(context: {
    status?: number;
    error?: string;
    stdout?: string;
    stderr?: string;
  }): string | null;

  /** Optional: health check */
  healthCheck?(): Promise<boolean>;
}

/**
 * Resolve provider by name
 */
export function resolveProvider(_name: string): VisionProvider | undefined {
  // This will be populated by the plugin initialization
  return undefined;
}

/**
 * List all available providers
 */
export function listProviders(): string[] {
  return ['openai', 'anthropic', 'gemini', 'ovh-free', 'zhipu'];
}
