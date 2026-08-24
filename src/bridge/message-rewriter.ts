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
  attachments?: never; // Always empty after rewriting
}

type Language = 'zh' | 'en';
type Depth = 'fast' | 'standard' | 'deep';

/**
 * Stable full-description template (auto mode / vision_describe tool).
 * Same image + same template → identical cache key and provider prefix.
 */
export function buildDescribeQuery(language: Language, depth: Depth): string {
  if (language === 'zh') {
    if (depth === 'fast') return '请简要描述这张图片的主要内容。';
    const base =
      '请详细描述这张图片：主要内容、可见文字（如有请逐条列出）、重要元素及其空间位置关系。';
    if (depth === 'deep') {
      return `${base}请进一步说明图片的整体结构与布局、各元素之间的关系，并对不确定的内容明确标注。`;
    }
    return base;
  }
  if (depth === 'fast') return 'Briefly describe the main content of this image.';
  const base =
    'Describe this image in detail: the main content, any visible text (list each item on its own line), and the key elements with their spatial relationships.';
  if (depth === 'deep') {
    return `${base} Also explain the overall structure and layout, the relationships between elements, and explicitly flag anything uncertain.`;
  }
  return base;
}

/**
 * Short summary template for interactive mode (fast depth regardless of
 * config.visionDepth).
 */
export function buildSummaryQuery(language: Language): string {
  return language === 'zh'
    ? '请用一两句话简要概括这张图片。'
    : 'Summarize this image in one or two sentences.';
}

/**
 * Tool hint appended in interactive mode so the model knows it can drill
 * down via tools instead of receiving a heavy description up front.
 */
export function buildToolHint(language: Language): string {
  return language === 'zh'
    ? '如需更详细的图像分析，可调用 vision_describe / vision_ground / vision_detect 工具。'
    : 'For more detailed image analysis, call the vision_describe / vision_ground / vision_detect tools.';
}

function formatOcr(description: VisionDescription): string {
  if (!description.ocr) return '';
  const truncated = description.ocr.substring(0, 500);
  const ellipsis = description.ocr.length > 500 ? '...' : '';
  return `\nOCR: ${truncated}${ellipsis}`;
}

/**
 * Build the text markers for a list of successful descriptions.
 */
export function buildMarkers(descriptions: VisionDescription[], language: Language): string {
  return descriptions
    .map((desc, i) => {
      const summary = desc.summary || 'Image content';
      const body = `${summary}${formatOcr(desc)}`;
      return language === 'zh' ? `[已识图${i + 1}: ${body}]` : `[Image ${i + 1}: ${body}]`;
    })
    .join('\n\n');
}

export interface RewriteOptions {
  /** Extra line appended after the markers (e.g. interactive tool hint) */
  toolHint?: string;
}

/**
 * Rewrite a message containing images into pure text.
 * `images` and `descriptions` must be the SUCCESSFUL pairs (same length,
 * same order); failed images never contribute markers.
 */
export function rewriteMessage(
  originalContent: string,
  images: ImageAttachment[],
  descriptions: VisionDescription[],
  language: Language = 'zh',
  options: RewriteOptions = {},
): RewrittenMessage {
  if (images.length === 0 || descriptions.length === 0) {
    return { role: 'user', content: originalContent };
  }

  const markers = buildMarkers(descriptions, language);
  const parts =
    images.length === 1
      ? [originalContent, markers]
      : [
          originalContent,
          language === 'zh' ? `已识图${images.length}张：` : `${images.length} images described:`,
          markers,
        ];
  if (options.toolHint) parts.push(options.toolHint);

  return {
    role: 'user',
    content: parts.filter((p) => p.length > 0).join('\n\n'),
  };
}

/**
 * Create text marker for a single image (for inline insertion)
 */
export function createTextMarker(
  description: VisionDescription,
  index: number,
  language: Language = 'zh',
): string {
  const body = `${description.summary}${formatOcr(description)}`;
  return language === 'zh' ? `[已识图${index}: ${body}]` : `[Image ${index}: ${body}]`;
}

/**
 * Extract descriptions from rewritten content (for shadow history)
 */
export function extractDescriptions(
  content: string,
  language: Language = 'zh',
): VisionDescription[] {
  const descriptions: VisionDescription[] = [];
  const regex = language === 'zh' ? /\[已识图(\d+): ([^\]]+)\]/g : /\[Image (\d+): ([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while (true) {
    match = regex.exec(content);
    if (match === null) break;
    const index = Number.parseInt(match[1] ?? '', 10);
    const summary = match[2] ?? '';
    descriptions.push({ summary, raw: { _index: index } });
  }

  return descriptions;
}

/**
 * Sanitize content for DeepSeek (remove internal markers)
 */
export function sanitizeForDeepSeek(content: string): string {
  // Remove __vision__ markers that are internal implementation details
  return content.replace(/\[__vision__:[^\]]+\]/g, '').trim();
}
