import { describe, expect, it, vi } from 'vitest';
import { buildDescribeQuery } from '../../src/bridge/message-rewriter.ts';
import type { VisionBridge } from '../../src/bridge/vision-bridge.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import type { ImageAttachment, VisionDescription } from '../../src/config/types.ts';
import { getTool, listTools, registerTool, validateToolArgs } from '../../src/tools/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';

// Snapshot before any test mutates the shared registry.
const INITIAL_TOOL_NAMES = listTools()
  .map((tool) => tool.name)
  .sort();

const image: ImageAttachment = {
  path: 'virtual://img.png',
  contentHash: 'h1',
  mime: 'image/png',
  bytes: 10,
};

const config = structuredClone(DEFAULT_CONFIG);

function bridgeReturning(description: VisionDescription): VisionBridge & {
  processImages: ReturnType<typeof vi.fn>;
} {
  const processImages = vi.fn(async () => ({ descriptions: [description], failures: [] }));
  return { processImages } as unknown as VisionBridge & { processImages: ReturnType<typeof vi.fn> };
}

function ctx(bridge: VisionBridge): ToolContext {
  return { bridge, image, config };
}

describe('registry', () => {
  it('registers the nine built-in tools', () => {
    expect(INITIAL_TOOL_NAMES).toEqual([
      'vision_bootstrap',
      'vision_crop',
      'vision_describe',
      'vision_detect',
      'vision_ground',
      'vision_ocr',
      'vision_pixel_diff',
      'vision_screenshot',
      'vision_trace',
    ]);
  });

  it('returns undefined for unknown tools', () => {
    expect(getTool('vision_nonexistent')).toBeUndefined();
  });

  it('registerTool adds new tools and overrides existing ones', () => {
    const originalTrace = getTool('vision_trace');
    registerTool({
      name: 'vision_test_echo',
      description: 'test echo',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true, data: { echo: true } }),
    });
    expect(getTool('vision_test_echo')?.description).toBe('test echo');
    registerTool({
      name: 'vision_trace',
      description: 'overridden',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    });
    expect(getTool('vision_trace')?.description).toBe('overridden');
    // restore the built-in so later tests see the pristine registry
    if (originalTrace) registerTool(originalTrace);
    expect(getTool('vision_trace')?.description).toBe(originalTrace?.description);
  });
});

describe('validateToolArgs', () => {
  it('reports missing required arguments', () => {
    const def = getTool('vision_describe');
    if (!def) throw new Error('vision_describe missing');
    expect(validateToolArgs(def, {})).toBe('Missing required argument: image');
  });

  it('reports type mismatches', () => {
    const def = getTool('vision_describe');
    if (!def) throw new Error('vision_describe missing');
    expect(validateToolArgs(def, { image: 'not-an-object' })).toBe(
      'Argument "image" must be of type object',
    );
    expect(validateToolArgs(def, { image, query: 42 })).toBe(
      'Argument "query" must be of type string',
    );
  });

  it('accepts valid args and unknown properties without a declared type', () => {
    const def = getTool('vision_describe');
    if (!def) throw new Error('vision_describe missing');
    expect(validateToolArgs(def, { image, query: 'hello', extraFlag: true })).toBeUndefined();
  });

  it('requires target for vision_ground', () => {
    const def = getTool('vision_ground');
    if (!def) throw new Error('vision_ground missing');
    expect(validateToolArgs(def, { image })).toBe('Missing required argument: target');
  });
});

describe('built-in tool handlers', () => {
  it('vision_describe uses the stable template by default', async () => {
    const bridge = bridgeReturning({ summary: 'a chart' });
    const tool = getTool('vision_describe');
    const result = await tool?.handler(ctx(bridge), { image });
    expect(result).toEqual({ ok: true, data: { summary: 'a chart' } });
    expect(bridge.processImages).toHaveBeenCalledWith(
      [image],
      buildDescribeQuery('zh', 'standard'),
    );
  });

  it('vision_describe honors an explicit query override and passes structured fields', async () => {
    const bridge = bridgeReturning({
      summary: 's',
      ocr: 'ocr-text',
      regions: [{ type: 't', text: 'x', order: 1 }],
      entities: [{ name: 'n', type: 'kind' }],
      uncertainty: ['maybe'],
    });
    const tool = getTool('vision_describe');
    const result = await tool?.handler(ctx(bridge), { image, query: 'custom query' });
    expect(result?.ok).toBe(true);
    expect(result?.data).toEqual({
      summary: 's',
      ocr: 'ocr-text',
      regions: [{ type: 't', text: 'x', order: 1 }],
      entities: [{ name: 'n', type: 'kind' }],
      uncertainty: ['maybe'],
    });
    expect(bridge.processImages).toHaveBeenCalledWith([image], 'custom query');
  });

  it('vision_describe surfaces bridge failures as ok:false', async () => {
    const processImages = vi.fn(async () => ({
      descriptions: [],
      failures: [{ index: 0, message: 'VISION_ALL_FAILED: All vision providers failed' }],
    }));
    const bridge = { processImages } as unknown as VisionBridge;
    const tool = getTool('vision_describe');
    const result = await tool?.handler(ctx(bridge), { image });
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('VISION_ALL_FAILED: All vision providers failed');
  });

  it('vision_ocr extracts the ocr field or falls back to the summary', async () => {
    const withOcr = bridgeReturning({ summary: 's', ocr: 'TEXT' });
    const tool = getTool('vision_ocr');
    expect(await tool?.handler(ctx(withOcr), { image })).toEqual({
      ok: true,
      data: { text: 'TEXT' },
    });
    const withoutOcr = bridgeReturning({ summary: 'fallback summary' });
    expect(await tool?.handler(ctx(withoutOcr), { image })).toEqual({
      ok: true,
      data: { text: 'fallback summary' },
    });
    expect(withOcr.processImages.mock.calls[0]?.[1]).toContain('提取');
  });

  it('vision_detect parses JSON arrays (fences tolerated) and falls back to text', async () => {
    const tool = getTool('vision_detect');
    const parsed = bridgeReturning({ summary: '[{"name":"cat","type":"animal"}]' });
    expect(await tool?.handler(ctx(parsed), { image })).toEqual({
      ok: true,
      data: { items: [{ name: 'cat', type: 'animal' }] },
    });
    const fenced = bridgeReturning({
      summary: '```json\n[{"name":"dog","type":"animal"}]\n```',
    });
    expect(await tool?.handler(ctx(fenced), { image })).toEqual({
      ok: true,
      data: { items: [{ name: 'dog', type: 'animal' }] },
    });
    const prose = bridgeReturning({ summary: 'sure, I see a cat' });
    expect(await tool?.handler(ctx(prose), { image })).toEqual({
      ok: true,
      data: { text: 'sure, I see a cat' },
    });
  });

  it('vision_ground parses strict JSON with the target embedded in the query', async () => {
    const bridge = bridgeReturning({
      summary: '{"found": true, "box": [10, 20, 30, 40], "label": "cat"}',
    });
    const tool = getTool('vision_ground');
    const result = await tool?.handler(ctx(bridge), { image, target: 'wallet' });
    expect(result?.ok).toBe(true);
    expect(result?.data).toEqual({ found: true, box: [10, 20, 30, 40], label: 'cat' });
    expect(String(bridge.processImages.mock.calls[0]?.[1])).toContain('wallet');
  });

  it('vision_ground returns found:false plus raw text on non-compliant output', async () => {
    const bridge = bridgeReturning({ summary: 'cannot locate that' });
    const tool = getTool('vision_ground');
    const result = await tool?.handler(ctx(bridge), { image, target: 'x' });
    expect(result).toEqual({ ok: true, data: { found: false, raw: 'cannot locate that' } });
  });

  it('vision_ground passes through {"found": false} verdicts', async () => {
    const bridge = bridgeReturning({ summary: '{"found": false}' });
    const tool = getTool('vision_ground');
    expect(await tool?.handler(ctx(bridge), { image, target: 'x' })).toEqual({
      ok: true,
      data: { found: false },
    });
  });

  it('vision_bootstrap parses structured JSON and falls back to text', async () => {
    const tool = getTool('vision_bootstrap');
    const structured = bridgeReturning({
      summary:
        '{"visual_kind":"chart","entities":[],"overview":"o","recommended_followups":["ocr"]}',
    });
    expect(await tool?.handler(ctx(structured), { image })).toEqual({
      ok: true,
      data: { visual_kind: 'chart', entities: [], overview: 'o', recommended_followups: ['ocr'] },
    });
    const prose = bridgeReturning({ summary: 'it is a photo' });
    expect(await tool?.handler(ctx(prose), { image })).toEqual({
      ok: true,
      data: { text: 'it is a photo' },
    });
  });

  it('vision_crop reports the missing sharp dependency (box never touched)', async () => {
    const bridge = bridgeReturning({ summary: 's' });
    const tool = getTool('vision_crop');
    const result = await tool?.handler(ctx(bridge), { image, box: [1, 2, 3, 4] });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('requires the optional dependency: sharp');
    expect(bridge.processImages).not.toHaveBeenCalled();
  });

  it('vision_pixel_diff reports the missing sharp dependency', async () => {
    const tool = getTool('vision_pixel_diff');
    const result = await tool?.handler(ctx(bridgeReturning({ summary: 's' })), {
      image,
      reference: { path: 'virtual://ref.png', contentHash: 'h2' },
    });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('requires the optional dependency: sharp');
  });

  it('vision_trace and vision_screenshot are honest stubs', async () => {
    const bridge = bridgeReturning({ summary: 's' });
    const trace = await getTool('vision_trace')?.handler(ctx(bridge), {});
    expect(trace?.ok).toBe(false);
    expect(trace?.error).toContain('vision_trace is not implemented yet');
    const shot = await getTool('vision_screenshot')?.handler(ctx(bridge), { html: '<b>x</b>' });
    expect(shot?.ok).toBe(false);
    expect(shot?.error).toContain('vision_screenshot is not implemented yet');
    expect(shot?.error).toContain('puppeteer-core');
    expect(bridge.processImages).not.toHaveBeenCalled();
  });
});
