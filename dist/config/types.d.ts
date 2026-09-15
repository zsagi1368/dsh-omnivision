export type VisionMode = 'auto' | 'interactive' | 'manual';
export type RoutingMode = 'pre-step' | 'tool-call' | 'hybrid';
export type FailureKind = 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'SERVER' | 'INVALID_REQUEST' | 'NETWORK' | 'QUOTA' | 'REGION' | 'TOS' | 'NO_ADAPTER' | 'REPETITION' | 'BUDGET' | 'OTHER';
export interface VisionProvider {
    name: string;
    defaultModel: string;
    category: 'api' | 'local' | 'free';
    speedClass: 'fast' | 'medium' | 'slow';
    execute(options: VisionExecuteOptions): Promise<VisionResult>;
    describeFailure?(context: FailureContext): string | null;
    healthCheck?(): Promise<boolean>;
}
export interface VisionExecuteOptions {
    images: ImageSource[];
    query?: string;
    tool?: string;
    parameters?: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface ImageSource {
    kind: 'local' | 'remote' | 'inline';
    path?: string;
    url?: string;
    base64?: string;
    mime?: string;
    contentHash: string;
    width?: number;
    height?: number;
}
export interface VisionResult {
    ok: boolean;
    data?: unknown;
    meta: {
        provider: string;
        model: string;
        durationMs: number;
        tokensUsed?: number;
        cacheHit?: boolean;
    };
    errors?: VisionFailure[];
}
export interface VisionFailure {
    kind: FailureKind;
    code: string;
    message: string;
    retryable: boolean;
    advice?: string;
    attempted?: AttemptRecord[];
}
export interface AttemptRecord {
    provider: string;
    ok: boolean;
    failure?: VisionFailure;
    error?: string;
}
export interface FailureContext {
    stdout: string;
    stderr: string;
    code: number | null;
    startedAt?: number;
}
export interface VisionDescription {
    summary: string;
    ocr?: string;
    regions?: Array<{
        type: string;
        text: string;
        order: number;
    }>;
    entities?: Array<{
        name: string;
        type: string;
        evidence?: string;
    }>;
    uncertainty?: string[];
    raw?: unknown;
}
export interface ImageAttachment {
    path: string;
    contentHash: string;
    mime: string;
    bytes: number;
    width?: number;
    height?: number;
}
export interface ProcessedMessages {
    messages: Array<{
        role: string;
        content: string;
        attachments?: unknown[];
    }>;
    imageCount: number;
    descriptions: VisionDescription[];
}
/**
 * Mirror of OmniVisionConfig (config/schema.ts) kept for type-layer consumers.
 * Must stay in sync with the canonical schema.
 */
export interface PluginConfig {
    mode: VisionMode;
    routing: RoutingMode;
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
//# sourceMappingURL=types.d.ts.map