import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Mock, vi } from 'vitest';
import type { VisionExecuteOptions, VisionFailure, VisionResult } from '../src/config/types.ts';
import type { VisionProvider } from '../src/vision/provider.ts';

/** Real 1x1 PNG bytes — provider tests only base64-encode file contents. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Unique temp dir inside os.tmpdir() (an allowed read root everywhere). */
export function makeTempDir(prefix = 'omnivision-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Unique temp dir inside the user's home directory — guaranteed OUTSIDE
 * os.tmpdir(), used to exercise allowedReadRoots / PATH_DENIED behavior
 * portably (writable on Windows and POSIX alike).
 */
export function makeHomeTempDir(prefix = 'omnivision-outside-'): string {
  return mkdtempSync(join(homedir(), `.${prefix}`));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Write a small PNG file and return its absolute path. */
export function writePng(dir: string, name: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, TINY_PNG);
  return filePath;
}

/** Snapshot env vars; invoking the returned function restores them. */
export function captureEnv(keys: string[]): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export function okResult(summary: string, provider = 'mock'): VisionResult {
  return {
    ok: true,
    data: { summary },
    meta: { provider, model: 'mock-model', durationMs: 1 },
  };
}

export function failureResult(
  kind: VisionFailure['kind'],
  message: string,
  retryable: boolean,
  provider = 'mock',
): VisionResult {
  return {
    ok: false,
    meta: { provider, model: 'mock-model', durationMs: 1 },
    errors: [{ kind, code: 'VISION_TEST', message, retryable }],
  };
}

export function authFailure(message = 'auth missing'): VisionFailure {
  return { kind: 'AUTH', code: 'VISION_401', message, retryable: false };
}

export type MockProvider = VisionProvider & { execute: Mock };

/** Mock provider whose execute is a vi.fn so tests can assert calls. */
export function makeProvider(
  name: string,
  impl: (options: VisionExecuteOptions) => Promise<VisionResult>,
): MockProvider {
  return {
    name,
    defaultModel: 'mock-model',
    category: 'api',
    speedClass: 'fast',
    execute: vi.fn(impl),
  };
}
