import { describe, expect, it } from 'vitest';
import {
  createShadowReplacements,
  extractImageAttachments,
  hasImageAttachments,
  removeImageAttachments,
} from '../../src/bridge/shadow-history.ts';
import type { ImageAttachment } from '../../src/config/types.ts';

const images: ImageAttachment[] = [
  { path: 'a.png', contentHash: 'h1', mime: 'image/png', bytes: 1 },
  { path: 'b.png', contentHash: 'h2', mime: 'image/png', bytes: 1 },
];

describe('createShadowReplacements', () => {
  it('keeps the surface event and replaces the model-visible content', () => {
    const replacements = createShadowReplacements('event-1', images, ['desc a', 'desc b']);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.surfaceOp).toEqual({ op: 'keep', eventId: 'event-1' });
    expect(replacements[0]?.modelOp).toEqual({
      op: 'replace',
      eventId: 'event-1',
      replacement: 'desc a\n\ndesc b',
    });
  });

  it('returns an empty array without images', () => {
    expect(createShadowReplacements('event-1', [], [])).toEqual([]);
  });
});

describe('attachment helpers', () => {
  it('hasImageAttachments detects non-empty attachment arrays', () => {
    expect(hasImageAttachments({ attachments: images })).toBe(true);
    expect(hasImageAttachments({ attachments: [] })).toBe(false);
    expect(hasImageAttachments({})).toBe(false);
  });

  it('extractImageAttachments passes through arrays and defaults to empty', () => {
    expect(extractImageAttachments({ attachments: images })).toEqual(images);
    expect(extractImageAttachments({})).toEqual([]);
  });

  it('removeImageAttachments drops the attachments field', () => {
    expect(removeImageAttachments({ attachments: images, content: 'hi', role: 'user' })).toEqual({
      role: 'user',
      content: 'hi',
    });
    expect(removeImageAttachments({ content: 'hi', role: 'assistant' })).toEqual({
      role: 'assistant',
      content: 'hi',
    });
  });
});
