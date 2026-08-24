import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisionBridge } from '../../src/bridge/vision-bridge.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { DEFAULT_TEMP } from '../../src/security/index.ts';
import { getTool } from '../../src/tools/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';

/**
 * The optional `sharp` peer dependency is NOT installed in this repo. These
 * tests mock it so the pixel math in vision_crop / vision_pixel_diff stays
 * covered; tests/tools/registry.test.ts covers the "sharp missing" path.
 */
const sharpState = vi.hoisted(() => ({
  width: 100,
  height: 50,
  channels: 3,
  rawA: Buffer.from([10, 20, 30]),
  rawB: Buffer.from([20, 30, 40]),
  written: [] as string[],
  failAsync: false,
}));

vi.mock('sharp', () => {
  interface Chain {
    metadata(): Promise<{ width?: number; height?: number }>;
    extract(region: { left: number; top: number; width: number; height: number }): Chain;
    resize(width?: number, height?: number): Chain;
    png(): Chain;
    raw(): Chain;
    toFile(path: string): Promise<{ path: string }>;
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer;
      info: { width: number; height: number; channels: number };
    }>;
  }
  const makeChain = (input: string): Chain => {
    const chain = {} as Chain;
    chain.metadata = async () => ({ width: sharpState.width, height: sharpState.height });
    chain.extract = () => chain;
    chain.resize = () => chain;
    chain.png = () => chain;
    chain.raw = () => chain;
    chain.toFile = async (path: string) => {
      if (sharpState.failAsync) throw new Error('sharp write failed');
      sharpState.written.push(path);
      return { path };
    };
    chain.toBuffer = async () => {
      if (sharpState.failAsync) throw new Error('sharp read failed');
      return {
        data: input.includes('ref') ? sharpState.rawB : sharpState.rawA,
        info: {
          width: sharpState.width,
          height: sharpState.height,
          channels: sharpState.channels,
        },
      };
    };
    return chain;
  };
  return { default: (input: string) => makeChain(input) };
});

const config = structuredClone(DEFAULT_CONFIG);

function ctx(path: string): ToolContext {
  const bridge = { processImages: vi.fn() } as unknown as VisionBridge;
  return {
    bridge,
    image: { path, contentHash: 'hash-1', mime: 'image/png', bytes: 10 },
    config,
  };
}

beforeEach(() => {
  sharpState.width = 100;
  sharpState.height = 50;
  sharpState.channels = 3;
  sharpState.rawA = Buffer.from([10, 20, 30]);
  sharpState.rawB = Buffer.from([20, 30, 40]);
  sharpState.written = [];
  sharpState.failAsync = false;
});

describe('vision_crop (sharp mocked)', () => {
  const run = (box: unknown, path = 'a.png') =>
    getTool('vision_crop')?.handler(ctx(path), { image: ctx(path).image, box });

  it('clamps the box and writes a deterministic PNG into the temp dir', async () => {
    const result = await run([10, 10, 40, 30]);
    expect(result?.ok).toBe(true);
    const data = result?.data as { path: string; width: number; height: number };
    expect(data.width).toBe(30); // min(100, 40) - 10
    expect(data.height).toBe(20); // min(50, 30) - 10
    expect(data.path.startsWith(join(DEFAULT_TEMP, 'omnivision-crop-'))).toBe(true);
    expect(data.path.endsWith('.png')).toBe(true);
    expect(sharpState.written).toEqual([data.path]);
  });

  it('clamps negative coordinates to zero', async () => {
    const result = await run([-20, -10, 30, 25]);
    expect(result?.ok).toBe(true);
    const data = result?.data as { width: number; height: number };
    expect(data.width).toBe(30); // min(100,30) - max(0,-20)
    expect(data.height).toBe(25);
  });

  it('rejects malformed boxes', async () => {
    expect((await run([1, 2, 3]))?.error).toBe('box must be [x1, y1, x2, y2] with finite numbers');
    expect((await run(['a', 'b', 'c', 'd']))?.error).toBe(
      'box must be [x1, y1, x2, y2] with finite numbers',
    );
  });

  it('rejects images whose dimensions cannot be read', async () => {
    sharpState.width = 0;
    expect((await run([0, 0, 10, 10]))?.error).toBe('Unable to read image dimensions');
  });

  it('rejects boxes that clamp to an empty region', async () => {
    expect((await run([150, 10, 200, 50]))?.error).toBe(
      'Invalid crop box (empty region after clamping)',
    );
  });

  it('returns a redacted failure when sharp throws', async () => {
    sharpState.failAsync = true;
    const result = await run([0, 0, 10, 10]);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('sharp write failed');
  });
});

describe('vision_pixel_diff (sharp mocked)', () => {
  const run = (reference: unknown, path = 'a.png') =>
    getTool('vision_pixel_diff')?.handler(ctx(path), {
      image: ctx(path).image,
      reference,
    });

  it('computes per-channel mean absolute difference and similarity', async () => {
    const result = await run({ path: 'ref.png', contentHash: 'h2' });
    expect(result?.ok).toBe(true);
    expect(result?.data).toEqual({
      similarity: 1 - 10 / 255,
      meanAbsDiff: 10,
      perChannel: [10, 10, 10],
      width: 100,
      height: 50,
      channels: 3,
    });
  });

  it('rejects malformed reference attachments', async () => {
    expect((await run({ nope: true }))?.error).toBe(
      'reference must be an image attachment { path, contentHash }',
    );
  });

  it('rejects unreadable dimensions', async () => {
    sharpState.height = 0;
    expect((await run({ path: 'ref.png', contentHash: 'h2' }))?.error).toBe(
      'Unable to read image dimensions',
    );
  });

  it('rejects empty pixel data', async () => {
    sharpState.rawA = Buffer.alloc(0);
    expect((await run({ path: 'ref.png', contentHash: 'h2' }))?.error).toBe('Empty pixel data');
  });

  it('returns a redacted failure when sharp throws mid-comparison', async () => {
    sharpState.failAsync = true;
    const result = await run({ path: 'ref.png', contentHash: 'h2' });
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('sharp read failed');
  });
});
