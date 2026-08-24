/**
 * Security utilities — SSRF protection, path policy, credential redaction
 */
import { lookup } from 'node:dns/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Canonical cross-platform temp directory (os.tmpdir()).
 * Shared by PathPolicy defaults and provider local-file reads.
 */
export const DEFAULT_TEMP = tmpdir();

/**
 * Check if a path is strictly INSIDE one of the allowed roots.
 *
 * Segment-aware: `/tmp-evil` is NOT inside `/tmp`, but `/tmp/foo.png` is.
 * The path itself (equal to a root) is denied — only contents count.
 */
export function isPathAllowed(path: string, allowedRoots: readonly string[]): boolean {
  const resolvedPath = resolve(path);
  for (const root of allowedRoots) {
    const rel = relative(resolve(root), resolvedPath);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if IP is private or reserved
 */
export function isPrivateOrReserved(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] >= 224 && parts[0] <= 255) return true;
  }
  if (
    ip.startsWith('::1') ||
    ip.startsWith('fe80:') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve hostname to IP and check if safe
 */
export async function assertSafeRemoteTarget(url: string): Promise<{ ip: string; url: URL }> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`SSRF_UNSUPPORTED_PROTOCOL: ${parsed.protocol}`);
  }
  let ip: string;
  try {
    const result = await lookup(parsed.hostname);
    ip = result.address;
  } catch {
    throw new Error('SSRF_DNS_FAILED');
  }
  if (isPrivateOrReserved(ip)) {
    throw new Error(`SSRF_PRIVATE_IP: ${ip}`);
  }
  return { ip, url: parsed };
}

/**
 * Path policy — whitelist-based access control
 */
export class PathPolicy {
  private workspace: string;
  private allowedDirs: Set<string>;
  private tempDir: string;

  constructor(workspace: string, options: { allowedDirs?: string[]; tempDir?: string } = {}) {
    this.workspace = resolve(workspace);
    this.allowedDirs = new Set((options.allowedDirs ?? []).map((d) => resolve(d)));
    this.tempDir = options.tempDir ?? DEFAULT_TEMP;
  }

  allowInput(path: string): boolean {
    return isPathAllowed(path, [this.workspace, this.tempDir, ...this.allowedDirs]);
  }

  allowOutput(path: string): boolean {
    return isPathAllowed(path, [this.workspace, this.tempDir]);
  }

  rejectSymlink(path: string): void {
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`PATH_SYMLINK_DENIED: Symbolic links not allowed: ${path}`);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('SYMLINK_DENIED')) {
        throw error;
      }
    }
  }

  normalize(path: string): string {
    return resolve(path);
  }
}

/**
 * Three-layer credential redaction
 */
export function redactSecrets(text: string, knownSecrets: string[] = []): string {
  let out = text;
  // Layer 1: Exact match for known secrets
  for (const secret of knownSecrets) {
    if (secret.length > 3) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  // Layer 2: Token shape regex
  out = out.replace(/(?:sk-|pk-)[a-zA-Z0-9_-]{20,}/g, '[REDACTED_KEY]');
  out = out.replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, 'Bearer [REDACTED]');
  out = out.replace(/api[_-]?key["\s:=]+[a-zA-Z0-9_-]{20,}/gi, 'api_key=[REDACTED]');
  // Layer 3: URL userinfo
  out = out.replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)(@)/g, '$1***:***$4');
  return out;
}

/**
 * Redact URL credentials
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
      return parsed.toString();
    }
  } catch {
    // Invalid URL
  }
  return url;
}

/**
 * Get a list of currently set API keys for redaction
 */
export function getKnownSecrets(): string[] {
  const secrets: string[] = [];
  const keyNames = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'ZAI_API_KEY',
    'OPENCODE_API_KEY',
  ];
  for (const name of keyNames) {
    const value = process.env[name];
    if (value && value.length > 10) {
      secrets.push(value);
    }
  }
  return secrets;
}
