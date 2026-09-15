/**
 * Canonical cross-platform temp directory (os.tmpdir()).
 * Shared by PathPolicy defaults and provider local-file reads.
 */
export declare const DEFAULT_TEMP: string;
/**
 * Check if a path is strictly INSIDE one of the allowed roots.
 *
 * Segment-aware: `/tmp-evil` is NOT inside `/tmp`, but `/tmp/foo.png` is.
 * The path itself (equal to a root) is denied — only contents count.
 */
export declare function isPathAllowed(path: string, allowedRoots: readonly string[]): boolean;
/**
 * Best-effort TOCTOU re-check of the final path component immediately before
 * opening it. Only regular files pass; symlinks, directories, and devices are
 * rejected. RESIDUAL RISK: the component can still be swapped between this
 * check and the actual open — closing that window needs openat-style relative
 * handles, which this codebase's provider layer does not use.
 */
export declare function isPlainFileAt(path: string): boolean;
/**
 * Check if IP is private or reserved
 */
export declare function isPrivateOrReserved(ip: string): boolean;
/**
 * Resolve hostname to IP and check if safe
 */
export declare function assertSafeRemoteTarget(url: string): Promise<{
    ip: string;
    url: URL;
}>;
/**
 * Path policy — whitelist-based access control
 */
export declare class PathPolicy {
    private workspace;
    private allowedDirs;
    private tempDir;
    constructor(workspace: string, options?: {
        allowedDirs?: string[];
        tempDir?: string;
    });
    /** realpathSync with ENOENT/EPERM fallback to the input path. */
    private canonicalize;
    /** Canonicalize a candidate path before containment checks. */
    private canonical;
    /**
     * Whether `resolved` passes containment AND its fully-resolved real path
     * still sits inside an allowed root: both the candidate and all roots are
     * canonicalized through realpathSync, so symlink components are
     * dereferenced before comparison. The final component is additionally
     * lstat-probed to reject a symlink planted at the leaf. RESIDUAL RISK:
     * TOCTOU between this check and open.
     */
    allowInput(path: string): boolean;
    allowOutput(path: string): boolean;
    rejectSymlink(path: string): void;
    normalize(path: string): string;
}
/**
 * Three-layer credential redaction
 */
export declare function redactSecrets(text: string, knownSecrets?: string[]): string;
/**
 * Redact URL credentials
 */
export declare function redactUrl(url: string): string;
/**
 * Get a list of currently set API keys for redaction
 */
export declare function getKnownSecrets(): string[];
//# sourceMappingURL=index.d.ts.map