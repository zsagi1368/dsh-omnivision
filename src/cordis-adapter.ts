/**
 * Cordis adapter shell for loader-direct mounting.
 *
 * The upstream factory (`createOmnivisionPlugin`) targets the DSH harness
 * PluginContext and is not itself a cordis plugin, while the host mounts this
 * package straight from a loader entry (`name: dsh-omnivision`): the loader
 * unwraps the module namespace and hands it to the cordis registry, which only
 * accepts a function or an object with an `apply` method. This shell provides
 * that handshake as a first-class part of the package.
 *
 * Contract — the cordis apply-plugin shape: named `name`/`inject`/`apply`
 * exports, no default required (the loader falls back to the namespace object,
 * whose `apply` the registry resolves).
 *
 * No cordis imports on purpose: this package must keep building standalone
 * (cordis is not in its dependency graph), so the host context is typed
 * structurally and every seam is optional.
 */
import type { OmniVisionConfig } from './config/schema.ts';
import { resolveConfig, validateConfig } from './config/schema.ts';
import type { OmniVisionPlugin } from './plugin/index.ts';
import { createOmnivisionPlugin } from './plugin/index.ts';

/** Loader entry / registry plugin name — matches the bundle patch row. */
export const name = 'dsh-omnivision';

/** No injected service dependencies: the plugin is self-contained. */
export const inject: readonly string[] = [];

/**
 * Structural subset of the host context used here. Optional members mean the
 * host may or may not expose them; the shell degrades silently without them.
 */
export interface CordisContextLike {
  logger?: {
    info?(message: string): void;
    warn?(message: string): void;
  };
  /**
   * Host cordis fiber effect face (`ctx.effect(setup, label?)`): `setup` runs
   * IMMEDIATELY and its RETURN VALUE — a disposer, or an iterable of disposers
   * (cordis `SyncEffect`) — is what gets collected for fiber unload. Verified
   * shape (FileHub aab73d7 / AutoPilot 3bc4963 / verticals cordis.ts:96); the
   * old `(teardown: () => unknown)` face was misleading: passing a teardown
   * directly makes it run at mount time and collects nothing for unload.
   */
  effect?(setup: () => (() => void) | Iterable<() => void>, label?: string): unknown;
}

/** What `apply` mounted, exposed for tests and diagnostics. */
export interface MountedOmnivision {
  plugin: OmniVisionPlugin;
  config: OmniVisionConfig;
  workspace: string;
}

/** Instances mounted per host context (inspection seam). */
const mounted = new WeakMap<object, MountedOmnivision>();

/** Test/inspection hook: the mount record for a given host context. */
export function mountedFor(ctx: object): MountedOmnivision | undefined {
  return mounted.get(ctx);
}

/**
 * Mount the omnivision runtime onto a cordis host context.
 *
 * Construction is local-only (config merge + provider chain objects; no
 * network, no filesystem access), so a mount failure means a programming or
 * config-shape error — surfaced loudly at boot instead of being swallowed.
 *
 * Config: the loader passes the patch row's config verbatim (this shell ships
 * no Config validator); `resolveConfig` merges it over `DEFAULT_CONFIG`, so a
 * partial row config is behavior-neutral by design. The factory re-resolves
 * internally, which is a no-op on an already-resolved config.
 */
export function apply(
  ctx: CordisContextLike,
  config?: Partial<OmniVisionConfig>,
): OmniVisionPlugin {
  const resolved = resolveConfig(config ?? {});
  const workspace = process.cwd();
  const plugin = createOmnivisionPlugin({ config: resolved, workspace });
  mounted.set(ctx, { plugin, config: resolved, workspace });
  for (const warning of validateConfig(resolved)) {
    ctx.logger?.warn?.(`[omnivision] ${warning}`);
  }
  ctx.logger?.info?.(
    `[omnivision] ready (mode=${resolved.mode}, providers=${plugin.stats().providers})`,
  );
  // Effect contract (TC-B4-OM1, RA1d fix14 judgment): setup runs immediately
  // and its return value is the unload disposer — double-arrow form. The old
  // `() => plugin.dispose()` called dispose at MOUNT time (immediate-call
  // trap) and collected nothing for unload. dispose is idempotent
  // (plugin/index.ts:419 — two Map.clear calls), so double-run is safe.
  ctx.effect?.(() => () => plugin.dispose(), 'omnivision-dispose');
  return plugin;
}
