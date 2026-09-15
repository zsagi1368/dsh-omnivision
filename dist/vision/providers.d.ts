import type { VisionProvider } from './provider.ts';
/** Options accepted by every provider factory */
export interface ProviderFactoryOptions {
    /** Override the provider's default model */
    model?: string;
    /** Override the provider's default endpoint base (keep the version prefix, e.g. `.../v1`) */
    baseUrl?: string;
    /** Override the env var name read for the API key */
    apiKeyEnv?: string;
    /** Extra roots local image files may be read from (in addition to system temp dirs) */
    allowedReadRoots?: string[];
    /** Skip private-IP rejection (for Ollama / LM Studio on 127.0.0.1) */
    allowLocalNetwork?: boolean;
}
export declare function createOpenAIProvider(opts?: ProviderFactoryOptions): VisionProvider;
export declare function createAnthropicProvider(opts?: ProviderFactoryOptions): VisionProvider;
export declare function createGeminiProvider(opts?: ProviderFactoryOptions): VisionProvider;
export declare function createOvhProvider(opts?: ProviderFactoryOptions): VisionProvider;
export declare function createZhipuProvider(opts?: ProviderFactoryOptions): VisionProvider;
/**
 * Generic OpenAI-compatible provider (Ollama at http://127.0.0.1:11434/v1,
 * LM Studio at http://localhost:1234/v1, or any other /v1 endpoint).
 *
 * `baseUrl` is REQUIRED. The caller decides about `allowLocalNetwork`
 * (the config layer passes `true` for local backends so the SSRF check
 * lets 127.0.0.1 / private hosts through). `apiKeyEnv` is optional —
 * local servers usually need no key.
 */
export declare function createOpenAICompatibleProvider(name: string, opts?: ProviderFactoryOptions & {
    category?: 'api' | 'local' | 'free';
}): VisionProvider;
export declare const openaiProvider: VisionProvider;
export declare const anthropicProvider: VisionProvider;
export declare const geminiProvider: VisionProvider;
export declare const ovhProvider: VisionProvider;
export declare const zhipuProvider: VisionProvider;
//# sourceMappingURL=providers.d.ts.map