/**
 * Plugin entry point — Main DSH integration
 */
import { statSync } from 'node:fs';
import {
  buildDescribeQuery,
  buildSummaryQuery,
  buildToolHint,
  rewriteMessage,
} from '../bridge/message-rewriter.ts';
import { createShadowReplacements } from '../bridge/shadow-history.ts';
import { VisionBridge } from '../bridge/vision-bridge.ts';
import type { OmniVisionConfig } from '../config/schema.ts';
import { resolveConfig } from '../config/schema.ts';
import type { ImageAttachment } from '../config/types.ts';
import { VisionCircuitBreaker } from '../resilience/circuit.ts';
import { DEFAULT_TEMP, getKnownSecrets, PathPolicy, redactSecrets } from '../security/index.ts';
import { getTool, listTools, validateToolArgs } from '../tools/index.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../tools/types.ts';
import type { VisionProvider } from '../vision/provider.ts';
import {
  createAnthropicProvider,
  createGeminiProvider,
  createOpenAICompatibleProvider,
  createOpenAIProvider,
  createOvhProvider,
  createZhipuProvider,
} from '../vision/providers.ts';

export interface PluginContext {
  config: OmniVisionConfig;
  workspace: string;
  sessionId?: string;
  /** Optional additional providers (e.g. mock providers for testing) — first in the chain */
  extraProviders?: VisionProvider[];
}

/** Why a single attachment did not contribute a description. */
export type AttachmentFailureReason = 'too_large' | 'symlink' | 'provider';

export interface AttachmentFailure {
  /** Position of the attachment in the original `attachments` array */
  index: number;
  path: string;
  reason: AttachmentFailureReason;
  message: string;
}

export interface ProcessMessageResult {
  /** true when at least one image produced a description marker */
  rewritten: boolean;
  /** Model-visible content. Unchanged original when nothing succeeded. */
  newContent: string;
  /** Number of validated image attachments (never the raw attachment count) */
  imageCount: number;
  /** Successful description summaries, in image order (successes only) */
  descriptions: string[];
  /** Shadow-history replacements (only when eventId was provided) */
  shadows?: Array<{ surfaceOp: unknown; modelOp: unknown }>;
  /** true when any attachment failed (too large / symlink / all providers failed) */
  hasErrors: boolean;
  /** Per-attachment failure details — NEVER rendered into newContent */
  failures?: AttachmentFailure[];
}

type ValidatedAttachment =
  | { ok: true; image: ImageAttachment }
  | { ok: false; failure: AttachmentFailure }
  | null; // null = silently skipped (not an image / outside roots / unreadable)

function requiresImage(def: ToolDefinition): boolean {
  const required = def.inputSchema.required;
  return Array.isArray(required) && required.includes('image');
}

export class OmniVisionPlugin {
  private readonly bridge: VisionBridge;
  private readonly circuitBreaker: VisionCircuitBreaker;
  private readonly providers: VisionProvider[];
  private readonly policy: PathPolicy;
  /** Effective config: user values merged over DEFAULT_CONFIG */
  private readonly config: OmniVisionConfig;

  constructor(private ctx: PluginContext) {
    this.config = resolveConfig(ctx.config);
    this.circuitBreaker = new VisionCircuitBreaker();
    this.policy = new PathPolicy(ctx.workspace, { tempDir: DEFAULT_TEMP });
    this.providers = this.composeProviders();
    this.bridge = new VisionBridge(this.providers, this.config.mode, {
      sessionId: ctx.sessionId,
      circuitBreaker: this.circuitBreaker,
      cacheEnabled: this.config.cache,
      cacheTtlMs: this.config.cacheTtlSeconds * 1000,
      cacheMaxEntries: this.config.cacheMaxEntries,
      totalTimeoutMs: this.config.timeoutMs,
      providerTimeoutMs: this.config.visionTaskTimeoutMs,
    });
  }

  /**
   * Compose the provider chain (failover order):
   *  1. extraProviders (test seam)
   *  2. config.providers custom entries
   *  3. local LM Studio, then local Ollama
   *  4. free cloud fallback (ordering driven by freeCloudFirst)
   */
  private composeProviders(): VisionProvider[] {
    const config = this.config;
    const allowedReadRoots = [this.ctx.workspace, DEFAULT_TEMP];
    const providers: VisionProvider[] = [];

    if (this.ctx.extraProviders) providers.push(...this.ctx.extraProviders);

    for (const entry of config.providers) {
      const opts = {
        model: entry.model,
        baseUrl: entry.baseUrl,
        apiKeyEnv: entry.apiKeyEnv,
        allowedReadRoots,
      };
      switch (entry.name) {
        case 'openai':
          providers.push(createOpenAIProvider(opts));
          break;
        case 'anthropic':
          providers.push(createAnthropicProvider(opts));
          break;
        case 'gemini':
          providers.push(createGeminiProvider(opts));
          break;
        case 'zhipu':
          providers.push(createZhipuProvider(opts));
          break;
        case 'ovh':
        case 'ovh-free':
          providers.push(createOvhProvider(opts));
          break;
        default:
          if (entry.baseUrl) {
            providers.push(
              createOpenAICompatibleProvider(entry.name, { ...opts, category: 'api' }),
            );
          }
      }
    }

    if (config.localLmStudio.enabled) {
      providers.push(
        createOpenAICompatibleProvider('lmstudio', {
          baseUrl: config.localLmStudio.baseURL,
          model: config.localLmStudio.model,
          allowedReadRoots,
          allowLocalNetwork: true,
        }),
      );
    }
    if (config.localOllama.enabled) {
      providers.push(
        createOpenAICompatibleProvider('ollama', {
          baseUrl: config.localOllama.baseURL,
          model: config.localOllama.model,
          allowedReadRoots,
          allowLocalNetwork: true,
        }),
      );
    }

    if (config.freeFallback) {
      const zhipu = createZhipuProvider({ allowedReadRoots });
      const ovh = createOvhProvider({ allowedReadRoots });
      const zhipuReady = Boolean(process.env.ZAI_API_KEY);
      // OpenCode Zen free tier: OpenAI-compatible, key-gated (sign-in required).
      // Free models rotate, so the model id comes from config. If the free model
      // rejects image input the failover chain simply moves on.
      const zen = config.freeZen;
      const zenProvider =
        zen?.enabled && zen.model && process.env[zen.apiKeyEnv ?? 'OPENCODE_API_KEY']
          ? createOpenAICompatibleProvider('zen-free', {
              baseUrl: 'https://opencode.ai/zen/v1',
              model: zen.model,
              apiKeyEnv: zen.apiKeyEnv,
              allowedReadRoots,
              category: 'free',
            })
          : undefined;
      if (config.freeCloudFirst) {
        if (zhipuReady) providers.push(zhipu);
        if (zenProvider) providers.push(zenProvider);
        providers.push(ovh);
      } else {
        providers.push(ovh);
        if (zhipuReady) providers.push(zhipu);
        if (zenProvider) providers.push(zenProvider);
      }
    }

    return providers;
  }

  /**
   * Validate one attachment against the path policy, symlink rule and
   * maxImageBytes. Returns null for shapes that are simply not processable
   * image attachments (silently skipped), or a structured failure.
   */
  private validateAttachment(raw: unknown, index: number): ValidatedAttachment {
    if (typeof raw !== 'object' || raw === null) return null;
    const v = raw as {
      path?: unknown;
      contentHash?: unknown;
      mime?: unknown;
      bytes?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (typeof v.path !== 'string' || typeof v.contentHash !== 'string') return null;
    const path = this.policy.normalize(v.path);

    if (!this.policy.allowInput(path)) return null;

    try {
      this.policy.rejectSymlink(path);
    } catch (error) {
      if (error instanceof Error && error.message.includes('SYMLINK_DENIED')) {
        return {
          ok: false,
          failure: {
            index,
            path,
            reason: 'symlink',
            message: 'Symbolic links are not allowed for image input',
          },
        };
      }
      return null; // unreadable path (e.g. ENOENT) — skip, do not crash batch
    }

    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return null; // missing file — skip
    }

    if (size > this.config.maxImageBytes) {
      return {
        ok: false,
        failure: {
          index,
          path,
          reason: 'too_large',
          message: `Image exceeds maxImageBytes (${size} > ${this.config.maxImageBytes})`,
        },
      };
    }

    return {
      ok: true,
      image: {
        path,
        contentHash: v.contentHash,
        mime: typeof v.mime === 'string' ? v.mime : 'image/png',
        bytes: typeof v.bytes === 'number' ? v.bytes : size,
        width: typeof v.width === 'number' ? v.width : undefined,
        height: typeof v.height === 'number' ? v.height : undefined,
      },
    };
  }

  /**
   * Pre-step message processing: describe images BEFORE DeepSeek sees the
   * request and rewrite the content to pure text. Failed images never inject
   * error text into `newContent`; they are reported via `failures`.
   * When ALL images fail, `rewritten` is false and `newContent` is the
   * original content.
   */
  async processMessage(
    content: string,
    attachments: unknown[] = [],
    eventId?: string,
  ): Promise<ProcessMessageResult> {
    const config = this.config;
    const images: ImageAttachment[] = [];
    const failures: AttachmentFailure[] = [];

    for (let index = 0; index < attachments.length; index++) {
      const validated = this.validateAttachment(attachments[index], index);
      if (validated === null) continue;
      if (validated.ok) images.push(validated.image);
      else failures.push(validated.failure);
    }

    // Manual mode performs no pre-processing; content is returned unchanged.
    if (config.mode === 'manual' || images.length === 0) {
      return {
        rewritten: false,
        newContent: content,
        imageCount: images.length,
        descriptions: [],
        hasErrors: failures.length > 0,
        failures: failures.length > 0 ? failures : undefined,
      };
    }

    // Stable query template (never raw user content) → stable cache key.
    // Interactive mode uses the short summary template regardless of depth.
    const isInteractive = config.mode === 'interactive';
    const query = isInteractive
      ? buildSummaryQuery(config.language)
      : buildDescribeQuery(config.language, config.visionDepth);

    const { descriptions: successDescriptions, failures: bridgeFailures } =
      await this.bridge.processImages(images, query);

    const failedIndices = new Set(bridgeFailures.map((f) => f.index));
    const successImages = images.filter((_, i) => !failedIndices.has(i));
    for (const failure of bridgeFailures) {
      failures.push({
        index: failure.index,
        path: images[failure.index]?.path ?? '',
        reason: 'provider',
        message: failure.message,
      });
    }

    // All images failed → nothing rewritten; original content returned.
    if (successDescriptions.length === 0) {
      return {
        rewritten: false,
        newContent: content,
        imageCount: images.length,
        descriptions: [],
        hasErrors: true,
        failures: failures.length > 0 ? failures : undefined,
      };
    }

    const toolHint = isInteractive ? buildToolHint(config.language) : undefined;
    const rewritten = rewriteMessage(content, successImages, successDescriptions, config.language, {
      toolHint,
    });

    const shadows = eventId
      ? createShadowReplacements(
          eventId,
          successImages,
          successDescriptions.map((d) => d.summary),
        )
      : undefined;

    return {
      rewritten: true,
      newContent: rewritten.content,
      imageCount: images.length,
      descriptions: successDescriptions.map((d) => d.summary),
      shadows,
      hasErrors: failures.length > 0,
      failures: failures.length > 0 ? failures : undefined,
    };
  }

  /**
   * Dispatch a tool call through the registry: validate args, resolve the
   * image attachment, build the ToolContext and invoke the handler.
   * Handler exceptions are caught and returned as redacted errors.
   */
  async callTool(tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const definition = getTool(tool);
    if (!definition) {
      const available = listTools()
        .map((t) => t.name)
        .join(', ');
      return { ok: false, error: `Unknown tool: ${tool}. Available: ${available}` };
    }

    const validationError = validateToolArgs(definition, args);
    if (validationError) return { ok: false, error: validationError };

    let image: ImageAttachment | undefined;
    if (args.image !== undefined) {
      const validated = this.validateAttachment(args.image, 0);
      if (validated === null || !validated.ok) {
        const detail = validated && !validated.ok ? validated.failure.message : 'invalid shape';
        return { ok: false, error: `Invalid image attachment: ${detail}` };
      }
      image = validated.image;
    }
    if (!image && requiresImage(definition)) {
      return { ok: false, error: 'Missing required argument: image' };
    }

    // Non-image tools (vision_trace, vision_screenshot) ignore the placeholder.
    const ctx: ToolContext = {
      bridge: this.bridge,
      image: image ?? { path: '', contentHash: '', mime: 'image/png', bytes: 0 },
      query: typeof args.query === 'string' ? args.query : undefined,
      config: this.config,
    };

    try {
      return await definition.handler(ctx, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: redactSecrets(message, getKnownSecrets()) };
    }
  }

  stats(): {
    cache: { cached: number };
    circuit: { blocked: string[]; total: number };
    providers: number;
  } {
    return {
      cache: this.bridge.stats(),
      circuit: this.circuitBreaker.stats(),
      providers: this.providers.length,
    };
  }

  dispose(): void {
    this.bridge.clear();
    this.circuitBreaker.clear();
  }
}

export function createOmnivisionPlugin(ctx: PluginContext): OmniVisionPlugin {
  return new OmniVisionPlugin(ctx);
}
