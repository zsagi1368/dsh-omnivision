import { describe, expect, it } from 'vitest';
import {
  buildDescribeQuery,
  buildSummaryQuery,
  buildToolHint,
  createTextMarker,
  extractDescriptions,
  rewriteMessage,
  sanitizeForDeepSeek,
} from '../../src/bridge/message-rewriter.ts';
import type { ImageAttachment } from '../../src/config/types.ts';

const oneImage: ImageAttachment[] = [
  { path: 'a.png', contentHash: 'h1', mime: 'image/png', bytes: 1 },
];
const twoImages: ImageAttachment[] = [
  { path: 'a.png', contentHash: 'h1', mime: 'image/png', bytes: 1 },
  { path: 'b.png', contentHash: 'h2', mime: 'image/png', bytes: 1 },
];

describe('query templates', () => {
  it('builds six distinct describe templates (zh/en x fast/standard/deep)', () => {
    const templates = [
      buildDescribeQuery('zh', 'fast'),
      buildDescribeQuery('zh', 'standard'),
      buildDescribeQuery('zh', 'deep'),
      buildDescribeQuery('en', 'fast'),
      buildDescribeQuery('en', 'standard'),
      buildDescribeQuery('en', 'deep'),
    ];
    expect(new Set(templates).size).toBe(6);
    expect(templates[0]).toBe('请简要描述这张图片的主要内容。');
    expect(templates[1]).toContain('请详细描述这张图片');
    expect(templates[2]).toContain('不确定');
    expect(templates[3]).toBe('Briefly describe the main content of this image.');
    expect(templates[4]).toContain('Describe this image in detail');
    expect(templates[5]).toContain('uncertain');
  });

  it('builds language-specific summary templates', () => {
    const zh = buildSummaryQuery('zh');
    const en = buildSummaryQuery('en');
    expect(zh).toBe('请用一两句话简要概括这张图片。');
    expect(en).toBe('Summarize this image in one or two sentences.');
    expect(zh).not.toBe(en);
  });

  it('builds tool hints naming the drill-down tools', () => {
    expect(buildToolHint('zh')).toContain('vision_describe');
    expect(buildToolHint('zh')).toContain('vision_ground');
    expect(buildToolHint('en')).toContain('vision_describe');
    expect(buildToolHint('en')).toContain('vision_detect');
  });
});

describe('rewriteMessage', () => {
  it('appends a single zh marker after the user text', () => {
    const message = rewriteMessage('看下这张图', oneImage, [{ summary: '一只猫' }], 'zh');
    expect(message.role).toBe('user');
    expect(message.content).toBe('看下这张图\n\n[已识图1: 一只猫]');
  });

  it('appends a single en marker after the user text', () => {
    const message = rewriteMessage('check this', oneImage, [{ summary: 'a cat' }], 'en');
    expect(message.content).toBe('check this\n\n[Image 1: a cat]');
  });

  it('numbers multiple images and prefixes a header line', () => {
    const zh = rewriteMessage('看下', twoImages, [{ summary: 'a' }, { summary: 'b' }], 'zh');
    expect(zh.content).toBe('看下\n\n已识图2张：\n\n[已识图1: a]\n\n[已识图2: b]');
    const en = rewriteMessage('look', twoImages, [{ summary: 'a' }, { summary: 'b' }], 'en');
    expect(en.content).toBe('look\n\n2 images described:\n\n[Image 1: a]\n\n[Image 2: b]');
  });

  it('appends the tool hint when provided', () => {
    const hint = buildToolHint('zh');
    const message = rewriteMessage('q', oneImage, [{ summary: 's' }], 'zh', { toolHint: hint });
    expect(message.content).toBe(`q\n\n[已识图1: s]\n\n${hint}`);
  });

  it('returns the original content when there is nothing to describe', () => {
    expect(rewriteMessage('plain', [], [], 'zh')).toEqual({ role: 'user', content: 'plain' });
    expect(rewriteMessage('plain', oneImage, [], 'zh')).toEqual({ role: 'user', content: 'plain' });
  });

  it('truncates long OCR text with an ellipsis', () => {
    const longOcr = 'x'.repeat(600);
    const message = rewriteMessage('q', oneImage, [{ summary: 's', ocr: longOcr }], 'en');
    expect(message.content).toContain('OCR: ');
    expect(message.content).toContain(`${'x'.repeat(500)}...`);
    expect(message.content).not.toContain('x'.repeat(501));
  });

  it('substitutes a default summary for empty descriptions', () => {
    const message = rewriteMessage('q', oneImage, [{ summary: '' }], 'en');
    expect(message.content).toBe('q\n\n[Image 1: Image content]');
  });
});

describe('createTextMarker', () => {
  it('builds indexed markers in both languages', () => {
    expect(createTextMarker({ summary: 'cat' }, 2, 'en')).toBe('[Image 2: cat]');
    expect(createTextMarker({ summary: '猫' }, 3, 'zh')).toBe('[已识图3: 猫]');
    expect(createTextMarker({ summary: 's', ocr: 't' }, 1, 'en')).toBe('[Image 1: s\nOCR: t]');
  });
});

describe('extractDescriptions', () => {
  it('round-trips markers from rewriteMessage (zh)', () => {
    const content = rewriteMessage(
      '看下',
      twoImages,
      [{ summary: 'a' }, { summary: 'b' }],
      'zh',
    ).content;
    const extracted = extractDescriptions(content, 'zh');
    expect(extracted.map((d) => d.summary)).toEqual(['a', 'b']);
    expect(extracted[0]?.raw).toEqual({ _index: 1 });
    expect(extracted[1]?.raw).toEqual({ _index: 2 });
  });

  it('round-trips markers from rewriteMessage (en)', () => {
    const content = rewriteMessage(
      'look',
      twoImages,
      [{ summary: 'a' }, { summary: 'b' }],
      'en',
    ).content;
    expect(extractDescriptions(content, 'en').map((d) => d.summary)).toEqual(['a', 'b']);
  });

  it('returns an empty array for marker-free content', () => {
    expect(extractDescriptions('no markers here', 'zh')).toEqual([]);
  });
});

describe('sanitizeForDeepSeek', () => {
  it('strips internal [__vision__:...] markers', () => {
    expect(sanitizeForDeepSeek('a [__vision__:ctx-123] b')).toBe('a  b');
    expect(sanitizeForDeepSeek('[__vision__:x]only')).toBe('only');
    expect(sanitizeForDeepSeek('clean')).toBe('clean');
  });
});
