/**
 * Message Rewriter — Converts image attachments to text descriptions
 *
 * Also owns the STABLE vision query templates. Queries are always built from
 * these templates (never from raw user content) so that:
 *  1. the description cache key is stable (same image + same template → hit)
 *  2. provider-side prefix caches see a repeated, predictable prompt
 */
import type { ImageAttachment, VisionDescription } from '../config/types.ts';
export interface RewrittenMessage {
    role: string;
    content: string;
    attachments?: never;
}
type Language = 'zh' | 'en';
type Depth = 'fast' | 'standard' | 'deep';
/**
 * Stable full-description template (auto mode / vision_describe tool).
 * Same image + same template → identical cache key and provider prefix.
 */
export declare function buildDescribeQuery(language: Language, depth: Depth): string;
/**
 * Short summary template for interactive mode (fast depth regardless of
 * config.visionDepth).
 */
export declare function buildSummaryQuery(language: Language): string;
/**
 * Tool hint appended in interactive mode so the model knows it can drill
 * down via tools instead of receiving a heavy description up front.
 */
export declare function buildToolHint(language: Language): string;
/**
 * Build the text markers for a list of successful descriptions.
 */
export declare function buildMarkers(descriptions: VisionDescription[], language: Language): string;
export interface RewriteOptions {
    /** Extra line appended after the markers (e.g. interactive tool hint) */
    toolHint?: string;
}
/**
 * Rewrite a message containing images into pure text.
 * `images` and `descriptions` must be the SUCCESSFUL pairs (same length,
 * same order); failed images never contribute markers.
 */
export declare function rewriteMessage(originalContent: string, images: ImageAttachment[], descriptions: VisionDescription[], language?: Language, options?: RewriteOptions): RewrittenMessage;
/**
 * Create text marker for a single image (for inline insertion)
 */
export declare function createTextMarker(description: VisionDescription, index: number, language?: Language): string;
/**
 * Extract descriptions from rewritten content (for shadow history)
 */
export declare function extractDescriptions(content: string, language?: Language): VisionDescription[];
/**
 * Sanitize content for DeepSeek (remove internal markers)
 */
export declare function sanitizeForDeepSeek(content: string): string;
export {};
//# sourceMappingURL=message-rewriter.d.ts.map