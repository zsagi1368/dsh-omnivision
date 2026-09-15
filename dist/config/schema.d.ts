export interface OmniVisionConfig {
    mode: 'auto' | 'interactive' | 'manual';
    routing: 'pre-step' | 'tool-call' | 'hybrid';
    providers: Array<{
        name: string;
        model?: string;
        apiKeyEnv?: string;
        baseUrl?: string;
    }>;
    localOllama: {
        enabled: boolean;
        baseURL: string;
        model: string;
    };
    localLmStudio: {
        enabled: boolean;
        baseURL: string;
        model: string;
    };
    freeFallback: boolean;
    freeCloudFirst: boolean;
    freeZen: {
        enabled: boolean;
        model: string;
        apiKeyEnv: string;
    };
    maxImageBytes: number;
    maxImagePixels: number;
    cache: boolean;
    cacheTtlSeconds: number;
    cacheMaxEntries: number;
    timeoutMs: number;
    visionTaskTimeoutMs: number;
    language: 'zh' | 'en';
    visionDepth: 'fast' | 'standard' | 'deep';
    progressiveTools: boolean;
}
/**
 * Default configuration — safe for production use
 */
export declare const DEFAULT_CONFIG: OmniVisionConfig;
/**
 * Merge a (possibly partial) user config over DEFAULT_CONFIG. Nested objects
 * are merged one level deep so callers may pass only the fields they want to
 * change. Arrays (providers) are replaced, not concatenated.
 */
export declare function resolveConfig(config: Partial<OmniVisionConfig>): OmniVisionConfig;
/**
 * Validate config and return warnings for problematic settings
 */
export declare function validateConfig(config: OmniVisionConfig): string[];
//# sourceMappingURL=schema.d.ts.map