// DSH Omnivision — Next-gen vision plugin for DeepSeek Harness
// KV-cache safe by design: all image processing happens before DeepSeek sees the request.

export type { OmniVisionConfig } from './config/schema.ts';
export { DEFAULT_CONFIG, resolveConfig, validateConfig } from './config/schema.ts';
export type {
  FailureKind,
  ImageAttachment,
  RoutingMode,
  VisionDescription,
  VisionMode,
} from './config/types.ts';
export type {
  AttachmentFailure,
  AttachmentFailureReason,
  PluginContext,
  ProcessMessageResult,
} from './plugin/index.ts';
export { createOmnivisionPlugin, OmniVisionPlugin } from './plugin/index.ts';
export { getTool, listTools, registerTool, toolRegistry } from './tools/index.ts';
export type { ToolContext, ToolDefinition, ToolResult } from './tools/types.ts';
export type { VisionFailure, VisionProvider, VisionResult } from './vision/provider.ts';
