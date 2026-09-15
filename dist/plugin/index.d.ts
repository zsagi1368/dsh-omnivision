import type { OmniVisionConfig } from '../config/schema.ts';
import type { ToolResult } from '../tools/types.ts';
import type { VisionProvider } from '../vision/provider.ts';
export interface PluginContext {
    config: OmniVisionConfig;
    workspace: string;
    sessionId?: string;
    /** Optional additional providers (e.g. mock providers for testing) — first in the chain */
    extraProviders?: VisionProvider[];
}
/** Why a single attachment did not contribute a description. */
export type AttachmentFailureReason = 'too_large' | 'symlink' | 'provider';
export interface AttachmentFailure {
    /** Position of the attachment in the original `attachments` array */
    index: number;
    path: string;
    reason: AttachmentFailureReason;
    message: string;
}
export interface ProcessMessageResult {
    /** true when at least one image produced a description marker */
    rewritten: boolean;
    /** Model-visible content. Unchanged original when nothing succeeded. */
    newContent: string;
    /** Number of validated image attachments (never the raw attachment count) */
    imageCount: number;
    /** Successful description summaries, in image order (successes only) */
    descriptions: string[];
    /** Shadow-history replacements (only when eventId was provided) */
    shadows?: Array<{
        surfaceOp: unknown;
        modelOp: unknown;
    }>;
    /** true when any attachment failed (too large / symlink / all providers failed) */
    hasErrors: boolean;
    /** Per-attachment failure details — NEVER rendered into newContent */
    failures?: AttachmentFailure[];
}
export declare class OmniVisionPlugin {
    private ctx;
    private readonly bridge;
    private readonly circuitBreaker;
    private readonly providers;
    private readonly policy;
    /** Effective config: user values merged over DEFAULT_CONFIG */
    private readonly config;
    constructor(ctx: PluginContext);
    /**
     * Compose the provider chain (failover order):
     *  1. extraProviders (test seam)
     *  2. config.providers custom entries
     *  3. local LM Studio, then local Ollama
     *  4. free cloud fallback (ordering driven by freeCloudFirst)
     */
    private composeProviders;
    /**
     * Validate one attachment against the path policy, symlink rule and
     * maxImageBytes. Returns null for shapes that are simply not processable
     * image attachments (silently skipped), or a structured failure.
     */
    private validateAttachment;
    /**
     * Pre-step message processing: describe images BEFORE DeepSeek sees the
     * request and rewrite the content to pure text. Failed images never inject
     * error text into `newContent`; they are reported via `failures`.
     * When ALL images fail, `rewritten` is false and `newContent` is the
     * original content.
     */
    processMessage(content: string, attachments?: unknown[], eventId?: string): Promise<ProcessMessageResult>;
    /**
     * Dispatch a tool call through the registry: validate args, resolve the
     * image attachment, build the ToolContext and invoke the handler.
     * Handler exceptions are caught and returned as redacted errors.
     */
    callTool(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
    stats(): {
        cache: {
            cached: number;
        };
        circuit: {
            blocked: string[];
            total: number;
        };
        providers: number;
    };
    dispose(): void;
}
export declare function createOmnivisionPlugin(ctx: PluginContext): OmniVisionPlugin;
//# sourceMappingURL=index.d.ts.map