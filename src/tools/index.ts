/**
 * Tool registry — vision tools dispatched through VisionBridge
 *
 * Built-in tools are registered at module load. Optional sharp-dependent
 * tools (vision_crop, vision_pixel_diff) resolve their peer dependency at
 * runtime and return a clear dependency error when it is not installed.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildDescribeQuery } from '../bridge/message-rewriter.ts';
import type { ImageAttachment, VisionDescription } from '../config/types.ts';
import { DEFAULT_TEMP, getKnownSecrets, redactSecrets } from '../security/index.ts';
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts';

export type { ToolContext, ToolDefinition, ToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const toolRegistry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  toolRegistry.set(def.name, def);
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

export function listTools(): ToolDefinition[] {
  return Array.from(toolRegistry.values());
}

// ---------------------------------------------------------------------------
// Argument validation (light, JSON-schema-ish)
// ---------------------------------------------------------------------------

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Validate args against a tool's `inputSchema` ({ type, properties, required }).
 * Returns an error message, or undefined when valid.
 */
export function validateToolArgs(
  def: ToolDefinition,
  args: Record<string, unknown>,
): string | undefined {
  const schema = def.inputSchema as {
    required?: string[];
    properties?: Record<string, { type?: string }>;
  };
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `Missing required argument: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const type = schema.properties?.[key]?.type;
    if (type && !matchesType(value, type)) {
      return `Argument "${key}" must be of type ${type}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Redacted error message for tool failures (secrets resolved at call time). */
function failureFrom(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: redactSecrets(message, getKnownSecrets()) };
}

type QueryOutcome = { ok: true; description: VisionDescription } | { ok: false; error: string };

/** Run one bridge query against the context image. */
async function runQuery(ctx: ToolContext, query: string): Promise<QueryOutcome> {
  const { descriptions, failures } = await ctx.bridge.processImages([ctx.image], query);
  if (descriptions.length > 0) return { ok: true, description: descriptions[0] };
  const message = failures[0]?.message ?? 'No vision provider produced a description';
  return { ok: false, error: message };
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/** Parse a JSON payload from a model response (code fences + prose tolerated). */
function parseJsonPayload<T>(text: string): T | undefined {
  const cleaned = stripCodeFences(text);
  const candidates = [cleaned];
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate slice
    }
  }
  return undefined;
}

function toAttachment(value: unknown): ImageAttachment | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as { path?: unknown; contentHash?: unknown; mime?: unknown; bytes?: unknown };
  if (typeof v.path !== 'string' || typeof v.contentHash !== 'string') return undefined;
  return {
    path: v.path,
    contentHash: v.contentHash,
    mime: typeof v.mime === 'string' ? v.mime : 'image/png',
    bytes: typeof v.bytes === 'number' ? v.bytes : 0,
  };
}

// ---------------------------------------------------------------------------
// Optional peer dependency: sharp (structural types, runtime resolution)
// ---------------------------------------------------------------------------

interface SharpMetadata {
  width?: number;
  height?: number;
}

interface SharpRawResult {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}

interface SharpInstance {
  metadata(): Promise<SharpMetadata>;
  extract(region: { left: number; top: number; width: number; height: number }): SharpInstance;
  resize(width?: number, height?: number): SharpInstance;
  png(): SharpInstance;
  raw(): SharpInstance;
  toFile(path: string): Promise<unknown>;
  toBuffer(options: { resolveWithObject: true }): Promise<SharpRawResult>;
}

type SharpFactory = (input: string) => SharpInstance;

const SHARP_DEPENDENCY_ERROR = 'vision_crop requires the optional dependency: sharp (npm i sharp)';

let sharpFactory: SharpFactory | undefined;

/** Load the optional `sharp` peer dependency; undefined when not installed. */
async function loadSharp(): Promise<SharpFactory | undefined> {
  if (sharpFactory) return sharpFactory;
  try {
    // Non-literal specifier: TypeScript and the bundler must not resolve this
    // statically — sharp is a peer-optional dependency resolved at runtime.
    const specifier: string = 'sharp';
    const mod = (await import(/* @vite-ignore */ specifier)) as { default?: unknown };
    const candidate: unknown = mod.default ?? mod;
    if (typeof candidate === 'function') sharpFactory = candidate as SharpFactory;
  } catch {
    return undefined;
  }
  return sharpFactory;
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

registerTool({
  name: 'vision_describe',
  description: 'Describe an image: main content, visible text, key elements and layout.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'object', description: '{ path, contentHash, mime?, bytes? }' },
      query: { type: 'string', description: 'Optional query override' },
    },
    required: ['image'],
  },
  async handler(ctx, args): Promise<ToolResult> {
    try {
      const query =
        typeof args.query === 'string' && args.query.length > 0
          ? args.query
          : buildDescribeQuery(ctx.config.language, ctx.config.visionDepth);
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const { description } = outcome;
      const data: Record<string, unknown> = { summary: description.summary };
      if (description.ocr) data.ocr = description.ocr;
      if (description.regions) data.regions = description.regions;
      if (description.entities) data.entities = description.entities;
      if (description.uncertainty) data.uncertainty = description.uncertainty;
      return { ok: true, data };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

registerTool({
  name: 'vision_ocr',
  description: 'Extract all visible text from an image.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'object', description: '{ path, contentHash, mime?, bytes? }' },
    },
    required: ['image'],
  },
  async handler(ctx): Promise<ToolResult> {
    try {
      const query =
        ctx.config.language === 'zh'
          ? '请提取图片中所有可见文字，逐条列出；如无文字，请回答“无可见文字”。'
          : 'Extract all visible text in this image, one item per line; if there is none, answer "No visible text".';
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      return { ok: true, data: { text: outcome.description.ocr ?? outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

registerTool({
  name: 'vision_detect',
  description: 'Enumerate the elements in an image as a JSON array of { name, type }.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'object', description: '{ path, contentHash, mime?, bytes? }' },
    },
    required: ['image'],
  },
  async handler(ctx): Promise<ToolResult> {
    try {
      const query =
        ctx.config.language === 'zh'
          ? '请以严格 JSON 数组格式列出图中所有可见元素，每个元素形如 {"name": "string", "type": "string"}，只输出 JSON，不要输出其他内容。'
          : 'List every visible element in this image as a strict JSON array, each item shaped like {"name": "string", "type": "string"}. Output only JSON, nothing else.';
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const items = parseJsonPayload<Array<{ name?: unknown; type?: unknown }>>(
        outcome.description.summary,
      );
      if (Array.isArray(items)) return { ok: true, data: { items } };
      return { ok: true, data: { text: outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

registerTool({
  name: 'vision_ground',
  description: 'Locate a target in an image; returns strict JSON { found, box, label }.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'object', description: '{ path, contentHash, mime?, bytes? }' },
      target: { type: 'string', description: 'What to locate in the image' },
    },
    required: ['image', 'target'],
  },
  async handler(ctx, args): Promise<ToolResult> {
    try {
      const target = String(args.target);
      const query =
        ctx.config.language === 'zh'
          ? `请在图中定位目标“${target}”。仅输出严格 JSON：{"found": boolean, "box": [x1, y1, x2, y2], "label": "string"}，坐标使用 0-1000 的归一化像素坐标；若未找到目标，输出 {"found": false}。`
          : `Locate the target "${target}" in this image. Output only strict JSON: {"found": boolean, "box": [x1, y1, x2, y2], "label": "string"} using normalized 0-1000 pixel coordinates; if the target is not found, output {"found": false}.`;
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const grounded = parseJsonPayload<{ found?: unknown; box?: unknown; label?: unknown }>(
        outcome.description.summary,
      );
      if (grounded && typeof grounded === 'object' && 'found' in grounded) {
        return { ok: true, data: grounded };
      }
      // Model did not comply with the JSON contract — surface the raw text.
      return { ok: true, data: { found: false, raw: outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

registerTool({
  name: 'vision_bootstrap',
  description:
    'First-pass structured analysis of an image: { visual_kind, entities, overview, recommended_followups }.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'object', description: '{ path, contentHash, mime?, bytes? }' },
    },
    required: ['image'],
  },
  async handler(ctx): Promise<ToolResult> {
    try {
      const query =
        ctx.config.language === 'zh'
          ? '请分析这张图片，并仅输出严格 JSON：{"visual_kind": "string", "entities": [{"name": "string", "type": "string"}], "overview": "string", "recommended_followups": ["string"]}。'
          : 'Analyze this image and output only strict JSON: {"visual_kind": "string", "entities": [{"name": "string", "type": "string"}], "overview": "string", "recommended_followups": ["string"]}.';
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const parsed = parseJsonPayload<{
        visual_kind?: unknown;
        entities?: unknown;
        overview?: unknown;
        recommended_followups?: unknown;
      }>(outcome.description.summary);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, data: parsed };
      }
      return { ok: true, data: { text: outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

registerTool({
  name: 'vision_crop',
  description: 'Crop an image to a box [x1, y1, x2, y2] (pixel coordinates) and save as PNG.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'object', description: '{ path, contentHash, mime?, bytes? }' },
      box: { type: 'array', description: '[x1, y1, x2, y2] in pixels' },
    },
    required: ['image', 'box'],
  },
  async handler(ctx, args): Promise<ToolResult> {
    try {
      const sharp = await loadSharp();
      if (!sharp) return { ok: false, error: SHARP_DEPENDENCY_ERROR };
      const box = args.box;
      if (
        !Array.isArray(box) ||
        box.length < 4 ||
        box.some((v) => typeof v !== 'number' || !Number.isFinite(v))
      ) {
        return { ok: false, error: 'box must be [x1, y1, x2, y2] with finite numbers' };
      }
      const metadata = await sharp(ctx.image.path).metadata();
      const imgWidth = metadata.width ?? 0;
      const imgHeight = metadata.height ?? 0;
      if (imgWidth <= 0 || imgHeight <= 0) {
        return { ok: false, error: 'Unable to read image dimensions' };
      }
      const [x1, y1, x2, y2] = box as [number, number, number, number];
      const left = Math.max(0, Math.round(x1));
      const top = Math.max(0, Math.round(y1));
      const width = Math.min(imgWidth, Math.round(x2)) - left;
      const height = Math.min(imgHeight, Math.round(y2)) - top;
      if (width <= 0 || height <= 0) {
        return { ok: false, error: 'Invalid crop box (empty region after clamping)' };
      }
      const digest = createHash('sha256')
        .update(ctx.image.contentHash)
        .update(box.join(','))
        .digest('hex')
        .slice(0, 16);
      const outPath = join(DEFAULT_TEMP, `omnivision-crop-${digest}.png`);
      await sharp(ctx.image.path).extract({ left, top, width, height }).png().toFile(outPath);
      return { ok: true, data: { path: outPath, width, height } };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

registerTool({
  name: 'vision_pixel_diff',
  description:
    'Pixel-level comparison of two images via sharp: mean absolute difference per channel and a 0..1 similarity score.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'object', description: '{ path, contentHash, mime?, bytes? }' },
      reference: { type: 'object', description: 'Reference image { path, contentHash, ... }' },
    },
    required: ['image', 'reference'],
  },
  async handler(ctx, args): Promise<ToolResult> {
    try {
      const sharp = await loadSharp();
      if (!sharp) {
        return {
          ok: false,
          error: 'vision_pixel_diff requires the optional dependency: sharp (npm i sharp)',
        };
      }
      const reference = toAttachment(args.reference);
      if (!reference) {
        return { ok: false, error: 'reference must be an image attachment { path, contentHash }' };
      }
      const [metaA, metaB] = await Promise.all([
        sharp(ctx.image.path).metadata(),
        sharp(reference.path).metadata(),
      ]);
      const width = Math.min(metaA.width ?? 0, metaB.width ?? 0);
      const height = Math.min(metaA.height ?? 0, metaB.height ?? 0);
      if (width <= 0 || height <= 0) {
        return { ok: false, error: 'Unable to read image dimensions' };
      }
      const [rawA, rawB] = await Promise.all([
        sharp(ctx.image.path).resize(width, height).raw().toBuffer({ resolveWithObject: true }),
        sharp(reference.path).resize(width, height).raw().toBuffer({ resolveWithObject: true }),
      ]);
      const length = Math.min(rawA.data.length, rawB.data.length);
      const channels = Math.max(1, Math.min(rawA.info.channels, rawB.info.channels));
      if (length === 0) return { ok: false, error: 'Empty pixel data' };
      const perChannel: number[] = [];
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        let count = 0;
        for (let i = c; i < length; i += channels) {
          sum += Math.abs(rawA.data[i] - rawB.data[i]);
          count += 1;
        }
        perChannel.push(count > 0 ? sum / count : 0);
      }
      const meanAbsDiff = perChannel.reduce((acc, v) => acc + v, 0) / perChannel.length;
      return {
        ok: true,
        data: {
          similarity: 1 - meanAbsDiff / 255,
          meanAbsDiff,
          perChannel,
          width,
          height,
          channels,
        },
      };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

registerTool({
  name: 'vision_trace',
  description: 'Record a step-by-step trace of the vision pipeline (not implemented yet).',
  inputSchema: { type: 'object', properties: {} },
  async handler(): Promise<ToolResult> {
    return {
      ok: false,
      error:
        'vision_trace is not implemented yet: it will record a step-by-step trace of the vision chain in a later milestone. No vision provider is called.',
    };
  },
});

registerTool({
  name: 'vision_screenshot',
  description: 'Render HTML to a screenshot image (not implemented yet).',
  inputSchema: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'HTML document to render' },
    },
  },
  async handler(): Promise<ToolResult> {
    return {
      ok: false,
      error:
        'vision_screenshot is not implemented yet: it requires the optional peer dependency puppeteer-core (npm i puppeteer-core) plus a browser executable; planned for a later milestone.',
    };
  },
});
