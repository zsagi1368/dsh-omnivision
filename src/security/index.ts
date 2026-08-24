/**
 * Security utilities — SSRF protection, path policy, credential redaction
 */
import { lookup } from 'node:dns/promises';
import { lstatSync, realpathSync } from 'node:fs';
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
 * Best-effort TOCTOU re-check of the final path component immediately before
 * opening it. Only regular files pass; symlinks, directories, and devices are
 * rejected. RESIDUAL RISK: the component can still be swapped between this
 * check and the actual open — closing that window needs openat-style relative
 * handles, which this codebase's provider layer does not use.
 */
export function isPlainFileAt(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if IP is private or reserved
 */
export function isPrivateOrReserved(ip: string): boolean {
  // IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.5) must be judged by its embedded
  // IPv4 address, otherwise the mapped form bypasses the v4 ranges below.
  const unwrapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(unwrapped)) {
    const parts = unwrapped.split('.').map(Number);
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 127) return true;
    if (first === 0) return true;
    if (first === 169 && second === 254) return true;
    // CGNAT (100.64.0.0/10): the full /10 spans 100.64 through 100.127.
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first >= 224 && first <= 255) return true;
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
 * Best-effort lstat probe of the FINAL path component: true only when it
 * exists and is a symbolic link. Unreadable or missing targets read as "not
 * a symlink" — the same ENOENT tolerance rejectSymlink applies.
 */
function isFinalSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Path policy — whitelist-based access control
 */
export class PathPolicy {
  private workspace: string;
  private allowedDirs: Set<string>;
  private tempDir: string;

  constructor(workspace: string, options: { allowedDirs?: string[]; tempDir?: string } = {}) {
    // Normalize all roots through realpathSync so symlink components in the
    // root paths are dereferenced before any containment check runs. This
    // makes both sides of every comparison live in canonical real-path space.
    this.workspace = this.canonicalize(resolve(workspace));
    this.allowedDirs = new Set(
      (options.allowedDirs ?? []).map((d) => this.canonicalize(resolve(d))),
    );
    this.tempDir = this.canonicalize(options.tempDir ?? DEFAULT_TEMP);
  }

  /** realpathSync with ENOENT/EPERM fallback to the input path. */
  private canonicalize(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }

  /** Canonicalize a candidate path before containment checks. */
  private canonical(path: string): string {
    return this.canonicalize(resolve(path));
  }

  /**
   * Whether `resolved` passes containment AND its fully-resolved real path
   * still sits inside an allowed root: both the candidate and all roots are
   * canonicalized through realpathSync, so symlink components are
   * dereferenced before comparison. The final component is additionally
   * lstat-probed to reject a symlink planted at the leaf. RESIDUAL RISK:
   * TOCTOU between this check and open.
   */
  allowInput(path: string): boolean {
    const resolved = this.canonical(path);
    return (
      isPathAllowed(resolved, [this.workspace, this.tempDir, ...this.allowedDirs]) &&
      !isFinalSymlink(resolved)
    );
  }

  allowOutput(path: string): boolean {
    // Same canonical containment-plus-final-symlink discipline as allowInput.
    const resolved = this.canonical(path);
    return isPathAllowed(resolved, [this.workspace, this.tempDir]) && !isFinalSymlink(resolved);
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
