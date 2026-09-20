/**
 * TC-B4-OM1 — cordis effect-contract locks for the omnivision adapter shell.
 *
 * Root cause (mainline probe v3, 2026-09-19; DESIGN-intake-tech.md fix14):
 * cordis `ctx.effect(setup)` executes `setup` IMMEDIATELY and collects the
 * RETURN VALUE of setup as the fiber-unload disposer. The pre-fix wiring
 * `ctx.effect?.(() => plugin.dispose(), 'omnivision-dispose')` passed an
 * immediate-call body: dispose ran at MOUNT time (a no-op in practice on a
 * fresh instance whose cache/circuit are empty, but a contract violation) and
 * unload collected `undefined` — zero disposers. The fix is the double-arrow
 * form `ctx.effect?.(() => () => plugin.dispose(), 'omnivision-dispose')`
 * (verticals cordis.ts:96 / FileHub aab73d7 / AutoPilot 3bc4963 precedent).
 *
 * cordis is deliberately NOT in this package's dependency graph (standalone
 * build, see cordis-adapter.ts header), so these locks follow the FileHub
 * RA1d lock-C plain-host approach: a structural ctx stub mirroring the fiber
 * effect semantics (execute setup now, collect its return).
 *
 * Locks:
 *   A. mount does NOT dispose (counter = 0) and the effect collects a
 *      function disposer under the 'omnivision-dispose' label.
 *   B. executing the collected disposer disposes exactly once (counter = 1);
 *      dispose is idempotent (src/plugin/index.ts:419-422 = two Map.clear
 *      calls via bridge.clear/circuitBreaker.clear), so a double run is
 *      asserted per actual semantics: no throw, counter = 2, observable
 *      state stays cleared.
 *   C. NEGATIVE control — the old immediate-call form turns the same lock-A
 *      assertions RED (mount-time counter = 1 / collected = undefined):
 *      discriminative-power self-proof.
 *   D. degraded path (bare ctx without an effect face — `ctx.effect?.`
 *      optional chaining keeps apply from throwing) is already covered by
 *      tests/cordis-adapter.test.ts 'mountedFor exposes the mount record per
 *      context' (apply({})); registered in the receipt, not duplicated here.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config/schema.ts';
import { apply } from '../src/cordis-adapter.ts';
import { createOmnivisionPlugin, OmniVisionPlugin } from '../src/plugin/index.ts';

interface CollectedEffect {
  label: string | undefined;
  returned: unknown;
}

/**
 * Mirror of the cordis fiber effect face: `setup` executes IMMEDIATELY and
 * its return value (the disposer, per the verified SyncEffect shape) is what
 * the host would collect for fiber unload.
 */
function makeEffectCtx(): {
  ctx: { effect(setup: () => (() => void) | Iterable<() => void>, label?: string): unknown };
  collected: CollectedEffect[];
} {
  const collected: CollectedEffect[] = [];
  return {
    ctx: {
      effect(setup, label) {
        collected.push({ label, returned: setup() });
        return undefined;
      },
    },
    collected,
  };
}

describe('OM1 · lock A — mount does not dispose; effect collects the disposer', () => {
  it('keeps the dispose counter at 0 during apply and collects a labeled function disposer', () => {
    const disposeSpy = vi.spyOn(OmniVisionPlugin.prototype, 'dispose');
    try {
      const { ctx, collected } = makeEffectCtx();
      const plugin = apply(ctx);

      // Mount-time dispose counter = 0 (the immediate-call trap would make
      // the old form register exactly 1 call right here).
      expect(disposeSpy).not.toHaveBeenCalled();

      // … and the unload disposer IS collected, under the documented label.
      expect(collected).toHaveLength(1);
      expect(collected[0]?.label).toBe('omnivision-dispose');
      expect(typeof collected[0]?.returned).toBe('function');
      expect(plugin.stats().providers).toBeGreaterThan(0);
    } finally {
      disposeSpy.mockRestore();
    }
  });
});

describe('OM1 · lock B — collected disposer disposes once; double run is safe', () => {
  it('counts exactly 1 dispose after the disposer runs, then survives a re-run (idempotent)', () => {
    const disposeSpy = vi.spyOn(OmniVisionPlugin.prototype, 'dispose');
    try {
      const { ctx, collected } = makeEffectCtx();
      const plugin = apply(ctx);
      const disposer = collected[0]?.returned as () => void;

      disposer();
      expect(disposeSpy).toHaveBeenCalledTimes(1); // unload disposal ran exactly once
      expect(plugin.stats().cache.cached).toBe(0);
      expect(plugin.stats().circuit.total).toBe(0);

      // dispose idempotency (verified: two pure Map.clear calls) — a second
      // run must not throw and the observable state stays disposed.
      expect(() => disposer()).not.toThrow();
      expect(disposeSpy).toHaveBeenCalledTimes(2);
      expect(plugin.stats().cache.cached).toBe(0);
      expect(plugin.stats().circuit.total).toBe(0);
    } finally {
      disposeSpy.mockRestore();
    }
  });
});

describe('OM1 · lock C — negative control: old immediate-call form is RED under the same assertions', () => {
  it('runs dispose at mount (counter = 1) and collects undefined for unload', () => {
    const disposeSpy = vi.spyOn(OmniVisionPlugin.prototype, 'dispose');
    try {
      // The pre-fix contract face and wiring, reproduced verbatim:
      //   effect?(teardown: () => unknown, label?: string): unknown
      //   ctx.effect?.(() => plugin.dispose(), 'omnivision-dispose')
      const collected: CollectedEffect[] = [];
      const oldCtx = {
        effect(teardown: () => unknown, label?: string): unknown {
          collected.push({ label, returned: teardown() });
          return undefined;
        },
      };
      const plugin = createOmnivisionPlugin({
        config: resolveConfig({}),
        workspace: process.cwd(),
      });
      oldCtx.effect(() => plugin.dispose(), 'omnivision-dispose');

      // The defect the fix removes: dispose already ran at "mount" …
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      // … and unload collected nothing (setup returned undefined).
      expect(collected[0]?.label).toBe('omnivision-dispose');
      expect(collected[0]?.returned).toBeUndefined();

      // Discriminative-power self-proof: lock A's assertions FAIL (red) under
      // the old form — the locks only pass on the double-arrow wiring.
      expect(() => expect(disposeSpy).not.toHaveBeenCalled()).toThrow();
      expect(() => expect(typeof collected[0]?.returned).toBe('function')).toThrow();
    } finally {
      disposeSpy.mockRestore();
    }
  });
});
