/**
 * Shadow History — Maintains UI consistency while protecting KV cache
 */
import type { ImageAttachment } from '../config/types.ts';
export interface ShadowReplacement {
    surfaceOp: {
        op: 'keep';
        eventId: string;
    };
    modelOp: {
        op: 'replace';
        eventId: string;
        replacement: string;
    };
}
export declare function createShadowReplacements(originalEventId: string, images: ImageAttachment[], descriptions: string[]): ShadowReplacement[];
export declare function hasImageAttachments(message: {
    attachments?: unknown[];
}): boolean;
export declare function extractImageAttachments(message: {
    attachments?: ImageAttachment[];
}): ImageAttachment[];
export declare function removeImageAttachments(message: {
    attachments?: unknown[];
    content: string;
    role: string;
}): {
    content: string;
    role: string;
};
//# sourceMappingURL=shadow-history.d.ts.map