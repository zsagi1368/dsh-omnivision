/**
 * Shadow History — Maintains UI consistency while protecting KV cache
 */
import type { ImageAttachment } from '../config/types.ts';

export interface ShadowReplacement {
  surfaceOp: { op: 'keep'; eventId: string };
  modelOp: { op: 'replace'; eventId: string; replacement: string };
}

export function createShadowReplacements(
  originalEventId: string,
  images: ImageAttachment[],
  descriptions: string[],
): ShadowReplacement[] {
  if (images.length === 0) return [];
  const replacement = descriptions.join('\n\n');
  return [
    {
      surfaceOp: { op: 'keep', eventId: originalEventId },
      modelOp: { op: 'replace', eventId: originalEventId, replacement },
    },
  ];
}

export function hasImageAttachments(message: { attachments?: unknown[] }): boolean {
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

export function extractImageAttachments(message: {
  attachments?: ImageAttachment[];
}): ImageAttachment[] {
  return Array.isArray(message.attachments) ? message.attachments : [];
}

export function removeImageAttachments(message: {
  attachments?: unknown[];
  content: string;
  role: string;
}): { content: string; role: string } {
  return { role: message.role, content: message.content };
}
