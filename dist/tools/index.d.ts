import type { ToolDefinition } from './types.ts';
export type { ToolContext, ToolDefinition, ToolResult } from './types.ts';
export declare const toolRegistry: Map<string, ToolDefinition>;
export declare function registerTool(def: ToolDefinition): void;
export declare function getTool(name: string): ToolDefinition | undefined;
export declare function listTools(): ToolDefinition[];
/**
 * Validate args against a tool's `inputSchema` ({ type, properties, required }).
 * Returns an error message, or undefined when valid.
 */
export declare function validateToolArgs(def: ToolDefinition, args: Record<string, unknown>): string | undefined;
//# sourceMappingURL=index.d.ts.map