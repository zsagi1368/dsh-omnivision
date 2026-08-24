/**
 * Plugin configuration schema
 */
import { isPrivateOrReserved } from '../security/index.ts';

export interface OmniVisionConfig {
  // Mode: how the plugin interacts with DeepSeek
  mode: 'auto' | 'interactive' | 'manual';
  // Routing: how images are processed
  routing: 'pre-step' | 'tool-call' | 'hybrid';
  // Custom providers (highest priority)
  providers: Array<{
    name: string;
    model?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
  }>;
  // Local Ollama backend
  localOllama: {
    enabled: boolean;
    baseURL: string;
    model: string;
  };
  // Local LM Studio backend
  localLmStudio: {
    enabled: boolean;
    baseURL: string;
    model: string;
  };
  // Free fallback chain
  freeFallback: boolean;
  // Prefer free cloud providers before paid API keys (provider ordering)
  freeCloudFirst: boolean;
  // OpenCode Zen free-tier fallback (https://opencode.ai/zen/v1, OpenAI-compatible).
  // Joins the chain only when the referenced API key env var is set. Free models
  // rotate over time, so the model id is configuration-driven.
  freeZen: {
    enabled: boolean;
    model: string;
    apiKeyEnv: string;
  };
  // Image processing limits
  maxImageBytes: number;
  maxImagePixels: number;
  // Cache
  cache: boolean;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  // Timeouts
  timeoutMs: number;
  visionTaskTimeoutMs: number;
  // Output
  language: 'zh' | 'en';
  // Vision depth
  visionDepth: 'fast' | 'standard' | 'deep';
  // Progressive tool exposure
  progressiveTools: boolean;
}

/**
 * Default configuration — safe for production use
 */
export const DEFAULT_CONFIG: OmniVisionConfig = {
  mode: 'auto',
  routing: 'pre-step',
  providers: [],
  localOllama: { enabled: false, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-vl:7b' },
  localLmStudio: { enabled: false, baseURL: 'http://localhost:1234/v1', model: 'qwen2.5-vl-7b' },
  freeFallback: true,
  freeCloudFirst: false,
  freeZen: { enabled: true, model: 'big-pickle', apiKeyEnv: 'OPENCODE_API_KEY' },
  maxImageBytes: 4 * 1024 * 1024,
  maxImagePixels: 20_000_000,
  cache: true,
  cacheTtlSeconds: 3600,
  cacheMaxEntries: 200,
  timeoutMs: 120_000,
  visionTaskTimeoutMs: 45_000,
  language: 'zh',
  visionDepth: 'standard',
  progressiveTools: false,
};

/**
 * Merge a (possibly partial) user config over DEFAULT_CONFIG. Nested objects
 * are merged one level deep so callers may pass only the fields they want to
 * change. Arrays (providers) are replaced, not concatenated.
 */
export function resolveConfig(config: Partial<OmniVisionConfig>): OmniVisionConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    localOllama: { ...DEFAULT_CONFIG.localOllama, ...config.localOllama },
    localLmStudio: { ...DEFAULT_CONFIG.localLmStudio, ...config.localLmStudio },
    freeZen: { ...DEFAULT_CONFIG.freeZen, ...config.freeZen },
  };
}

/**
 * A baseURL is considered "local" when its hostname is localhost-like,
 * loopback, or any private/reserved range (LAN boxes included).
 */
function isLocalBaseUrl(baseURL: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return true;
  }
  // WHATWG URLs keep brackets on IPv6 literals — strip before the IP checks
  return isPrivateOrReserved(hostname.replace(/^\[|\]$/g, ''));
}

/**
 * Validate config and return warnings for problematic settings
 */
export function validateConfig(config: OmniVisionConfig): string[] {
  const warnings: string[] = [];

  // Check provider configs
  for (const p of config.providers) {
    if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) {
      warnings.push(`Warning: ${p.apiKeyEnv} not set in environment`);
    }
  }

  // Local backends should point at local hosts
  if (config.localOllama.enabled && !isLocalBaseUrl(config.localOllama.baseURL)) {
    warnings.push(
      `Warning: localOllama.baseURL (${config.localOllama.baseURL}) points at a non-local host`,
    );
  }
  if (config.localLmStudio.enabled && !isLocalBaseUrl(config.localLmStudio.baseURL)) {
    warnings.push(
      `Warning: localLmStudio.baseURL (${config.localLmStudio.baseURL}) points at a non-local host`,
    );
  }

  // Check image limits
  if (config.maxImageBytes > 25 * 1024 * 1024) {
    warnings.push('Warning: maxImageBytes > 25MB may cause memory issues');
  }

  if (config.maxImagePixels > 100_000_000) {
    warnings.push('Warning: maxImagePixels > 100MP may cause OOM');
  }

  return warnings;
}
