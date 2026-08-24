/**
 * Tool context and result types
 */
import type { VisionBridge } from '../bridge/vision-bridge.ts';
import type { OmniVisionConfig } from '../config/schema.ts';
import type { ImageAttachment } from '../config/types.ts';

export interface ToolContext {
  bridge: VisionBridge;
  image: ImageAttachment;
  /** Optional caller-provided query override (template is used otherwise) */
  query?: string;
  /** Full plugin config so handlers can honor language / depth settings */
  config: OmniVisionConfig;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * Plain JSON-schema-ish object: `{ type: 'object', properties, required }`.
   * Validated lightly by the plugin dispatcher before the handler runs.
   */
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}
