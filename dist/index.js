import { lookup } from "node:dns/promises";
import { lstatSync, realpathSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
const DEFAULT_TEMP = tmpdir();
function isPathAllowed(path, allowedRoots) {
  const resolvedPath = resolve(path);
  for (const root of allowedRoots) {
    const rel = relative(resolve(root), resolvedPath);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}
function isPlainFileAt(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
function isPrivateOrReserved(ip) {
  const unwrapped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(unwrapped)) {
    const parts = unwrapped.split(".").map(Number);
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 127) return true;
    if (first === 0) return true;
    if (first === 169 && second === 254) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first >= 224 && first <= 255) return true;
  }
  if (ip.startsWith("::1") || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }
  return false;
}
async function assertSafeRemoteTarget(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`SSRF_UNSUPPORTED_PROTOCOL: ${parsed.protocol}`);
  }
  let ip;
  try {
    const result = await lookup(parsed.hostname);
    ip = result.address;
  } catch {
    throw new Error("SSRF_DNS_FAILED");
  }
  if (isPrivateOrReserved(ip)) {
    throw new Error(`SSRF_PRIVATE_IP: ${ip}`);
  }
  return { ip, url: parsed };
}
function isFinalSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
class PathPolicy {
  workspace;
  allowedDirs;
  tempDir;
  constructor(workspace, options = {}) {
    this.workspace = this.canonicalize(resolve(workspace));
    this.allowedDirs = new Set(
      (options.allowedDirs ?? []).map((d) => this.canonicalize(resolve(d)))
    );
    this.tempDir = this.canonicalize(options.tempDir ?? DEFAULT_TEMP);
  }
  /** realpathSync with ENOENT/EPERM fallback to the input path. */
  canonicalize(p) {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }
  /** Canonicalize a candidate path before containment checks. */
  canonical(path) {
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
  allowInput(path) {
    const resolved = this.canonical(path);
    return isPathAllowed(resolved, [this.workspace, this.tempDir, ...this.allowedDirs]) && !isFinalSymlink(resolved);
  }
  allowOutput(path) {
    const resolved = this.canonical(path);
    return isPathAllowed(resolved, [this.workspace, this.tempDir]) && !isFinalSymlink(resolved);
  }
  rejectSymlink(path) {
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`PATH_SYMLINK_DENIED: Symbolic links not allowed: ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("SYMLINK_DENIED")) {
        throw error;
      }
    }
  }
  normalize(path) {
    return resolve(path);
  }
}
function redactSecrets(text, knownSecrets = []) {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length > 3) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  out = out.replace(/(?:sk-|pk-)[a-zA-Z0-9_-]{20,}/g, "[REDACTED_KEY]");
  out = out.replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]");
  out = out.replace(/api[_-]?key["\s:=]+[a-zA-Z0-9_-]{20,}/gi, "api_key=[REDACTED]");
  out = out.replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)(@)/g, "$1***:***$4");
  return out;
}
function getKnownSecrets() {
  const secrets = [];
  const keyNames = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "ZAI_API_KEY",
    "OPENCODE_API_KEY"
  ];
  for (const name2 of keyNames) {
    const value = process.env[name2];
    if (value && value.length > 10) {
      secrets.push(value);
    }
  }
  return secrets;
}
const DEFAULT_CONFIG = {
  mode: "auto",
  routing: "pre-step",
  providers: [],
  localOllama: { enabled: false, baseURL: "http://127.0.0.1:11434/v1", model: "qwen2.5-vl:7b" },
  localLmStudio: { enabled: false, baseURL: "http://localhost:1234/v1", model: "qwen2.5-vl-7b" },
  freeFallback: true,
  freeCloudFirst: false,
  freeZen: { enabled: true, model: "big-pickle", apiKeyEnv: "OPENCODE_API_KEY" },
  maxImageBytes: 4 * 1024 * 1024,
  maxImagePixels: 2e7,
  cache: true,
  cacheTtlSeconds: 3600,
  cacheMaxEntries: 200,
  timeoutMs: 12e4,
  visionTaskTimeoutMs: 45e3,
  language: "zh",
  visionDepth: "standard",
  progressiveTools: false
};
function resolveConfig(config) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    localOllama: { ...DEFAULT_CONFIG.localOllama, ...config.localOllama },
    localLmStudio: { ...DEFAULT_CONFIG.localLmStudio, ...config.localLmStudio },
    freeZen: { ...DEFAULT_CONFIG.freeZen, ...config.freeZen }
  };
}
function isLocalBaseUrl(baseURL) {
  let hostname;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true;
  }
  return isPrivateOrReserved(hostname.replace(/^\[|\]$/g, ""));
}
function validateConfig(config) {
  const warnings = [];
  for (const p of config.providers) {
    if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) {
      warnings.push(`Warning: ${p.apiKeyEnv} not set in environment`);
    }
  }
  if (config.localOllama.enabled && !isLocalBaseUrl(config.localOllama.baseURL)) {
    warnings.push(
      `Warning: localOllama.baseURL (${config.localOllama.baseURL}) points at a non-local host`
    );
  }
  if (config.localLmStudio.enabled && !isLocalBaseUrl(config.localLmStudio.baseURL)) {
    warnings.push(
      `Warning: localLmStudio.baseURL (${config.localLmStudio.baseURL}) points at a non-local host`
    );
  }
  if (config.maxImageBytes > 25 * 1024 * 1024) {
    warnings.push("Warning: maxImageBytes > 25MB may cause memory issues");
  }
  if (config.maxImagePixels > 1e8) {
    warnings.push("Warning: maxImagePixels > 100MP may cause OOM");
  }
  return warnings;
}
function buildDescribeQuery(language, depth) {
  if (language === "zh") {
    if (depth === "fast") return "请简要描述这张图片的主要内容。";
    const base2 = "请详细描述这张图片：主要内容、可见文字（如有请逐条列出）、重要元素及其空间位置关系。";
    if (depth === "deep") {
      return `${base2}请进一步说明图片的整体结构与布局、各元素之间的关系，并对不确定的内容明确标注。`;
    }
    return base2;
  }
  if (depth === "fast") return "Briefly describe the main content of this image.";
  const base = "Describe this image in detail: the main content, any visible text (list each item on its own line), and the key elements with their spatial relationships.";
  if (depth === "deep") {
    return `${base} Also explain the overall structure and layout, the relationships between elements, and explicitly flag anything uncertain.`;
  }
  return base;
}
function buildSummaryQuery(language) {
  return language === "zh" ? "请用一两句话简要概括这张图片。" : "Summarize this image in one or two sentences.";
}
function buildToolHint(language) {
  return language === "zh" ? "如需更详细的图像分析，可调用 vision_describe / vision_ground / vision_detect 工具。" : "For more detailed image analysis, call the vision_describe / vision_ground / vision_detect tools.";
}
function formatOcr(description) {
  if (!description.ocr) return "";
  const truncated = description.ocr.substring(0, 500);
  const ellipsis = description.ocr.length > 500 ? "..." : "";
  return `
OCR: ${truncated}${ellipsis}`;
}
function buildMarkers(descriptions, language) {
  return descriptions.map((desc, i) => {
    const summary = desc.summary || "Image content";
    const body = `${summary}${formatOcr(desc)}`;
    return language === "zh" ? `[已识图${i + 1}: ${body}]` : `[Image ${i + 1}: ${body}]`;
  }).join("\n\n");
}
function rewriteMessage(originalContent, images, descriptions, language = "zh", options = {}) {
  if (images.length === 0 || descriptions.length === 0) {
    return { role: "user", content: originalContent };
  }
  const markers = buildMarkers(descriptions, language);
  const parts = images.length === 1 ? [originalContent, markers] : [
    originalContent,
    language === "zh" ? `已识图${images.length}张：` : `${images.length} images described:`,
    markers
  ];
  if (options.toolHint) parts.push(options.toolHint);
  return {
    role: "user",
    content: parts.filter((p) => p.length > 0).join("\n\n")
  };
}
function createShadowReplacements(originalEventId, images, descriptions) {
  if (images.length === 0) return [];
  const replacement = descriptions.join("\n\n");
  return [
    {
      surfaceOp: { op: "keep", eventId: originalEventId },
      modelOp: { op: "replace", eventId: originalEventId, replacement }
    }
  ];
}
class VisionCircuitBreaker {
  states = /* @__PURE__ */ new Map();
  options;
  constructor(options = {}) {
    this.options = {
      authTripTtlMs: options.authTripTtlMs ?? 10 * 60 * 1e3,
      defaultRateCooldownMs: options.defaultRateCooldownMs ?? 60 * 1e3,
      maxEntries: options.maxEntries ?? 128
    };
  }
  isBlocked(provider) {
    const state = this.states.get(provider);
    if (!state) return false;
    if (state.blockedUntil > Date.now()) return true;
    this.states.delete(provider);
    return false;
  }
  record(provider, result) {
    if (result === "success") {
      this.states.delete(provider);
      return;
    }
    const ttlMs = this.getTtlForKind(result.kind);
    const blockedUntil = ttlMs > 0 ? Date.now() + ttlMs : 0;
    const existing = this.states.get(provider);
    if (existing) {
      existing.blockedUntil = blockedUntil;
      existing.consecutiveFailures += 1;
      existing.lastFailure = result;
    } else {
      this.evictToCapacity();
      this.states.set(provider, {
        blockedUntil,
        consecutiveFailures: 1,
        lastFailure: result
      });
    }
  }
  /**
   * Enforce maxEntries before inserting a new provider state: evict the
   * entry with the earliest blockedUntil (ties broken by insertion order —
   * Map iteration is insertion-ordered, and strict `<` keeps the oldest).
   */
  evictToCapacity() {
    if (this.options.maxEntries <= 0) {
      this.states.clear();
      return;
    }
    while (this.states.size >= this.options.maxEntries) {
      let evictKey;
      let evictBlockedUntil = Number.POSITIVE_INFINITY;
      for (const [key, state] of this.states) {
        if (state.blockedUntil < evictBlockedUntil) {
          evictBlockedUntil = state.blockedUntil;
          evictKey = key;
        }
      }
      if (evictKey === void 0) break;
      this.states.delete(evictKey);
    }
  }
  getTimeUntilReady(provider) {
    const state = this.states.get(provider);
    if (!state || state.blockedUntil === 0) return 0;
    return Math.max(0, state.blockedUntil - Date.now());
  }
  getTtlForKind(kind) {
    switch (kind) {
      case "AUTH":
      case "REGION":
      case "TOS":
        return this.options.authTripTtlMs;
      case "RATE_LIMIT":
      case "QUOTA":
        return this.options.defaultRateCooldownMs;
      default:
        return Math.floor(this.options.defaultRateCooldownMs / 2);
    }
  }
  clear() {
    this.states.clear();
  }
  stats() {
    const blocked = Array.from(this.states.entries()).filter(([, s]) => s.blockedUntil > Date.now()).map(([p]) => p);
    return { blocked, total: this.states.size };
  }
}
function createVisionCircuitBreaker(options) {
  return new VisionCircuitBreaker(options);
}
async function executeWithFailover(providers, options, config = {}, circuitBreaker) {
  const { totalTimeoutMs = 12e4, providerTimeoutMs = 45e3 } = config;
  const attempts = [];
  const breaker = circuitBreaker ?? createVisionCircuitBreaker();
  const startTime = Date.now();
  const knownSecrets = getKnownSecrets();
  for (const provider of providers) {
    if (breaker.isBlocked(provider.name)) {
      attempts.push({ provider: provider.name, ok: false, error: "Circuit breaker open" });
      continue;
    }
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeoutMs) {
      return {
        ok: false,
        meta: { provider: "none", model: "none", durationMs: elapsed },
        errors: [
          {
            kind: "TIMEOUT",
            code: "VISION_TOTAL_TIMEOUT",
            message: "Request timed out",
            retryable: false
          }
        ]
      };
    }
    try {
      const result = await provider.execute({
        ...options,
        signal: options.signal,
        timeoutMs: Math.min(providerTimeoutMs, totalTimeoutMs - elapsed)
      });
      if (result.ok) {
        breaker.record(provider.name, "success");
        return { ...result, meta: { ...result.meta } };
      }
      const failure = result.errors?.[0];
      if (failure) {
        breaker.record(provider.name, failure);
        attempts.push({ provider: provider.name, ok: false, failure });
      }
      if (!failure?.retryable) {
        break;
      }
    } catch (error) {
      const failure = classifyError(error);
      breaker.record(provider.name, failure);
      attempts.push({
        provider: provider.name,
        ok: false,
        error: redactSecrets(failure.message, knownSecrets)
      });
      if (!failure.retryable) {
        break;
      }
    }
  }
  return {
    ok: false,
    meta: { provider: "none", model: "none", durationMs: Date.now() - startTime },
    errors: [
      {
        kind: "OTHER",
        code: "VISION_ALL_FAILED",
        message: `All vision providers failed`,
        retryable: false,
        advice: "Check your configuration or try again later",
        // Redacted per-provider attempt details so callers can see WHY each
        // provider failed without leaking credentials.
        attempted: attempts.length > 0 ? attempts : void 0
      }
    ]
  };
}
function classifyError(error) {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("abort") || msg.includes("cancel")) {
      return {
        kind: "TIMEOUT",
        code: "VISION_CANCELLED",
        message: "Request cancelled",
        retryable: false
      };
    }
    if (msg.includes("timeout")) {
      return {
        kind: "TIMEOUT",
        code: "VISION_TIMEOUT",
        message: "Provider timeout",
        retryable: true
      };
    }
    if (msg.includes("network") || msg.includes("fetch") || msg.includes("refused") || msg.includes("econnrefused")) {
      return {
        kind: "NETWORK",
        code: "VISION_NETWORK_ERROR",
        message: "Network error",
        retryable: true
      };
    }
    if (msg.includes("auth") || msg.includes("permission")) {
      return {
        kind: "AUTH",
        code: "VISION_AUTH_ERROR",
        message: "Authentication failed",
        retryable: false
      };
    }
  }
  return {
    kind: "OTHER",
    code: "VISION_UNKNOWN_ERROR",
    message: "Unknown error",
    retryable: false
  };
}
const DEFAULT_TTL_MS = 36e5;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const DEFAULT_TOTAL_TIMEOUT_MS = 12e4;
const DEFAULT_PROVIDER_TIMEOUT_MS = 45e3;
class VisionBridge {
  constructor(providers, mode, opts = {}) {
    this.providers = providers;
    this.mode = mode;
    this.ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.maxCacheEntries = opts.cacheMaxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.cacheEnabled = opts.cacheEnabled ?? true;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.providerTimeoutMs = opts.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.sessionId = opts.sessionId;
    this.circuitBreaker = opts.circuitBreaker;
  }
  /** LRU cache: Map iteration order = least → most recently used */
  completedResults = /* @__PURE__ */ new Map();
  ttlMs;
  maxCacheEntries;
  cacheEnabled;
  totalTimeoutMs;
  providerTimeoutMs;
  sessionId;
  circuitBreaker;
  /**
   * Process images and return successful descriptions plus per-image failures.
   * Never throws for provider errors; only aborts/cancellations propagate.
   */
  async processImages(images, query, signal) {
    if (images.length === 0 || this.mode === "manual") {
      return { descriptions: [], failures: [] };
    }
    const settled = await Promise.allSettled(
      images.map((image) => this.processSingleImage(image, query, signal))
    );
    const descriptions = [];
    const failures = [];
    const knownSecrets = getKnownSecrets();
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === "fulfilled") {
        if (result.value.ok) descriptions.push(result.value.description);
        else failures.push({ index, message: redactSecrets(result.value.message, knownSecrets) });
        continue;
      }
      throw result.reason;
    }
    return { descriptions, failures };
  }
  /**
   * Generate brief summaries joined into a single line (interactive mode).
   * Empty string when nothing succeeded.
   */
  async processSummary(images, query, signal) {
    const { descriptions } = await this.processImages(images, query, signal);
    if (descriptions.length === 0) return "";
    return descriptions.map((d) => d.summary).join("。");
  }
  /**
   * Stable cache key — hash(sessionId, mode, contentHash, query).
   * The FULL query is hashed (queries are stable templates, so identical
   * image + template → identical key; no slicing that could collide).
   */
  createCacheKey(image, query) {
    return createHash("sha256").update(this.sessionId ?? "default").update(this.mode).update(image.contentHash).update(query).digest("hex");
  }
  /**
   * Process single image through the failover chain.
   * Returns a success description or a failure message; only rethrows for
   * cancellation/abort so callers can stop the whole batch.
   */
  async processSingleImage(image, query, signal) {
    const cacheKey = this.createCacheKey(image, query);
    const cached = this.getFromCache(cacheKey);
    if (cached) return { ok: true, description: cached };
    try {
      const options = {
        images: [
          {
            kind: "local",
            path: image.path,
            contentHash: image.contentHash,
            mime: image.mime
          }
        ],
        query,
        tool: "vision_describe",
        signal,
        timeoutMs: this.providerTimeoutMs
      };
      const result = await executeWithFailover(
        this.providers,
        options,
        { totalTimeoutMs: this.totalTimeoutMs, providerTimeoutMs: this.providerTimeoutMs },
        this.circuitBreaker
      );
      if (result.ok && result.data) {
        const description = this.extractDescription(result.data);
        this.setCache(cacheKey, description);
        return { ok: true, description };
      }
      const failure = result.errors?.[0];
      const message = failure ? `${failure.code}: ${failure.message}` : "Unknown error";
      return { ok: false, message };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "Cancelled" || msg.toLowerCase().includes("abort")) throw error;
      return { ok: false, message: msg };
    }
  }
  /** Cache get with TTL check + LRU refresh (delete & re-insert). */
  getFromCache(key) {
    const entry = this.completedResults.get(key);
    if (!entry) return void 0;
    if (Date.now() > entry.expiresAt) {
      this.completedResults.delete(key);
      return void 0;
    }
    this.completedResults.delete(key);
    this.completedResults.set(key, entry);
    return entry.description;
  }
  setCache(key, description) {
    if (!this.cacheEnabled) return;
    if (this.maxCacheEntries <= 0) return;
    if (this.completedResults.size >= this.maxCacheEntries && !this.completedResults.has(key)) {
      const oldestKey = this.completedResults.keys().next().value;
      if (oldestKey) this.completedResults.delete(oldestKey);
    }
    this.completedResults.set(key, {
      description,
      expiresAt: Date.now() + this.ttlMs
    });
  }
  extractDescription(data) {
    if (!data || typeof data !== "object") {
      return { summary: "Image processed (no structured data)" };
    }
    const d = data;
    const summary = typeof d.summary === "string" ? d.summary : "";
    return {
      summary: summary || "Image content processed",
      ocr: typeof d.ocr === "string" ? d.ocr : void 0,
      regions: d.regions ?? void 0,
      entities: d.entities ?? void 0,
      uncertainty: d.uncertainty ?? void 0,
      raw: d
    };
  }
  clear() {
    this.completedResults.clear();
  }
  stats() {
    return { cached: this.completedResults.size };
  }
}
const toolRegistry = /* @__PURE__ */ new Map();
function registerTool(def) {
  toolRegistry.set(def.name, def);
}
function getTool(name2) {
  return toolRegistry.get(name2);
}
function listTools() {
  return Array.from(toolRegistry.values());
}
function matchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}
function validateToolArgs(def, args) {
  const schema = def.inputSchema;
  for (const key of schema.required ?? []) {
    if (args[key] === void 0) return `Missing required argument: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const type = schema.properties?.[key]?.type;
    if (type && !matchesType(value, type)) {
      return `Argument "${key}" must be of type ${type}`;
    }
  }
  return void 0;
}
function failureFrom(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: redactSecrets(message, getKnownSecrets()) };
}
async function runQuery(ctx, query) {
  const { descriptions, failures } = await ctx.bridge.processImages([ctx.image], query);
  if (descriptions.length > 0) return { ok: true, description: descriptions[0] };
  const message = failures[0]?.message ?? "No vision provider produced a description";
  return { ok: false, error: message };
}
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}
function parseJsonPayload(text) {
  const cleaned = stripCodeFences(text);
  const candidates = [cleaned];
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
    }
  }
  return void 0;
}
function toAttachment(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const v = value;
  if (typeof v.path !== "string" || typeof v.contentHash !== "string") return void 0;
  return {
    path: v.path,
    contentHash: v.contentHash,
    mime: typeof v.mime === "string" ? v.mime : "image/png",
    bytes: typeof v.bytes === "number" ? v.bytes : 0
  };
}
const SHARP_DEPENDENCY_ERROR = "vision_crop requires the optional dependency: sharp (npm i sharp)";
let sharpFactory;
async function loadSharp() {
  if (sharpFactory) return sharpFactory;
  try {
    const specifier = "sharp";
    const mod = await import(
      /* @vite-ignore */
      specifier
    );
    const candidate = mod.default ?? mod;
    if (typeof candidate === "function") sharpFactory = candidate;
  } catch {
    return void 0;
  }
  return sharpFactory;
}
registerTool({
  name: "vision_describe",
  description: "Describe an image: main content, visible text, key elements and layout.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "object", description: "{ path, contentHash, mime?, bytes? }" },
      query: { type: "string", description: "Optional query override" }
    },
    required: ["image"]
  },
  async handler(ctx, args) {
    try {
      const query = typeof args.query === "string" && args.query.length > 0 ? args.query : buildDescribeQuery(ctx.config.language, ctx.config.visionDepth);
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const { description } = outcome;
      const data = { summary: description.summary };
      if (description.ocr) data.ocr = description.ocr;
      if (description.regions) data.regions = description.regions;
      if (description.entities) data.entities = description.entities;
      if (description.uncertainty) data.uncertainty = description.uncertainty;
      return { ok: true, data };
    } catch (error) {
      return failureFrom(error);
    }
  }
});
registerTool({
  name: "vision_ocr",
  description: "Extract all visible text from an image.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "object", description: "{ path, contentHash, mime?, bytes? }" }
    },
    required: ["image"]
  },
  async handler(ctx) {
    try {
      const query = ctx.config.language === "zh" ? "请提取图片中所有可见文字，逐条列出；如无文字，请回答“无可见文字”。" : 'Extract all visible text in this image, one item per line; if there is none, answer "No visible text".';
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      return { ok: true, data: { text: outcome.description.ocr ?? outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  }
});
registerTool({
  name: "vision_detect",
  description: "Enumerate the elements in an image as a JSON array of { name, type }.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "object", description: "{ path, contentHash, mime?, bytes? }" }
    },
    required: ["image"]
  },
  async handler(ctx) {
    try {
      const query = ctx.config.language === "zh" ? '请以严格 JSON 数组格式列出图中所有可见元素，每个元素形如 {"name": "string", "type": "string"}，只输出 JSON，不要输出其他内容。' : 'List every visible element in this image as a strict JSON array, each item shaped like {"name": "string", "type": "string"}. Output only JSON, nothing else.';
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const items = parseJsonPayload(
        outcome.description.summary
      );
      if (Array.isArray(items)) return { ok: true, data: { items } };
      return { ok: true, data: { text: outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  }
});
registerTool({
  name: "vision_ground",
  description: "Locate a target in an image; returns strict JSON { found, box, label }.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "object", description: "{ path, contentHash, mime?, bytes? }" },
      target: { type: "string", description: "What to locate in the image" }
    },
    required: ["image", "target"]
  },
  async handler(ctx, args) {
    try {
      const target = String(args.target);
      const query = ctx.config.language === "zh" ? `请在图中定位目标“${target}”。仅输出严格 JSON：{"found": boolean, "box": [x1, y1, x2, y2], "label": "string"}，坐标使用 0-1000 的归一化像素坐标；若未找到目标，输出 {"found": false}。` : `Locate the target "${target}" in this image. Output only strict JSON: {"found": boolean, "box": [x1, y1, x2, y2], "label": "string"} using normalized 0-1000 pixel coordinates; if the target is not found, output {"found": false}.`;
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const grounded = parseJsonPayload(
        outcome.description.summary
      );
      if (grounded && typeof grounded === "object" && "found" in grounded) {
        return { ok: true, data: grounded };
      }
      return { ok: true, data: { found: false, raw: outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  }
});
registerTool({
  name: "vision_bootstrap",
  description: "First-pass structured analysis of an image: { visual_kind, entities, overview, recommended_followups }.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "object", description: "{ path, contentHash, mime?, bytes? }" }
    },
    required: ["image"]
  },
  async handler(ctx) {
    try {
      const query = ctx.config.language === "zh" ? '请分析这张图片，并仅输出严格 JSON：{"visual_kind": "string", "entities": [{"name": "string", "type": "string"}], "overview": "string", "recommended_followups": ["string"]}。' : 'Analyze this image and output only strict JSON: {"visual_kind": "string", "entities": [{"name": "string", "type": "string"}], "overview": "string", "recommended_followups": ["string"]}.';
      const outcome = await runQuery(ctx, query);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const parsed = parseJsonPayload(outcome.description.summary);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, data: parsed };
      }
      return { ok: true, data: { text: outcome.description.summary } };
    } catch (error) {
      return failureFrom(error);
    }
  }
});
registerTool({
  name: "vision_crop",
  description: "Crop an image to a box [x1, y1, x2, y2] (pixel coordinates) and save as PNG.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "object", description: "{ path, contentHash, mime?, bytes? }" },
      box: { type: "array", description: "[x1, y1, x2, y2] in pixels" }
    },
    required: ["image", "box"]
  },
  async handler(ctx, args) {
    try {
      const sharp = await loadSharp();
      if (!sharp) return { ok: false, error: SHARP_DEPENDENCY_ERROR };
      const box = args.box;
      if (!Array.isArray(box) || box.length < 4 || box.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        return { ok: false, error: "box must be [x1, y1, x2, y2] with finite numbers" };
      }
      const metadata = await sharp(ctx.image.path).metadata();
      const imgWidth = metadata.width ?? 0;
      const imgHeight = metadata.height ?? 0;
      if (imgWidth <= 0 || imgHeight <= 0) {
        return { ok: false, error: "Unable to read image dimensions" };
      }
      const [x1, y1, x2, y2] = box;
      const left = Math.max(0, Math.round(x1));
      const top = Math.max(0, Math.round(y1));
      const width = Math.min(imgWidth, Math.round(x2)) - left;
      const height = Math.min(imgHeight, Math.round(y2)) - top;
      if (width <= 0 || height <= 0) {
        return { ok: false, error: "Invalid crop box (empty region after clamping)" };
      }
      const digest = createHash("sha256").update(ctx.image.contentHash).update(box.join(",")).digest("hex").slice(0, 16);
      const outPath = join(DEFAULT_TEMP, `omnivision-crop-${digest}.png`);
      await sharp(ctx.image.path).extract({ left, top, width, height }).png().toFile(outPath);
      return { ok: true, data: { path: outPath, width, height } };
    } catch (error) {
      return failureFrom(error);
    }
  }
});
registerTool({
  name: "vision_pixel_diff",
  description: "Pixel-level comparison of two images via sharp: mean absolute difference per channel and a 0..1 similarity score.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "object", description: "{ path, contentHash, mime?, bytes? }" },
      reference: { type: "object", description: "Reference image { path, contentHash, ... }" }
    },
    required: ["image", "reference"]
  },
  async handler(ctx, args) {
    try {
      const sharp = await loadSharp();
      if (!sharp) {
        return {
          ok: false,
          error: "vision_pixel_diff requires the optional dependency: sharp (npm i sharp)"
        };
      }
      const reference = toAttachment(args.reference);
      if (!reference) {
        return { ok: false, error: "reference must be an image attachment { path, contentHash }" };
      }
      const [metaA, metaB] = await Promise.all([
        sharp(ctx.image.path).metadata(),
        sharp(reference.path).metadata()
      ]);
      const width = Math.min(metaA.width ?? 0, metaB.width ?? 0);
      const height = Math.min(metaA.height ?? 0, metaB.height ?? 0);
      if (width <= 0 || height <= 0) {
        return { ok: false, error: "Unable to read image dimensions" };
      }
      const [rawA, rawB] = await Promise.all([
        sharp(ctx.image.path).resize(width, height).raw().toBuffer({ resolveWithObject: true }),
        sharp(reference.path).resize(width, height).raw().toBuffer({ resolveWithObject: true })
      ]);
      const length = Math.min(rawA.data.length, rawB.data.length);
      const channels = Math.max(1, Math.min(rawA.info.channels, rawB.info.channels));
      if (length === 0) return { ok: false, error: "Empty pixel data" };
      const perChannel = [];
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        let count = 0;
        for (let i = c; i < length; i += channels) {
          sum += Math.abs(rawA.data[i] - rawB.data[i]);
          count += 1;
        }
        perChannel.push(count > 0 ? sum / count : 0);
      }
      const meanAbsDiff = perChannel.reduce((acc, v) => acc + v, 0) / perChannel.length;
      return {
        ok: true,
        data: {
          similarity: 1 - meanAbsDiff / 255,
          meanAbsDiff,
          perChannel,
          width,
          height,
          channels
        }
      };
    } catch (error) {
      return failureFrom(error);
    }
  }
});
registerTool({
  name: "vision_trace",
  description: "Record a step-by-step trace of the vision pipeline (not implemented yet).",
  inputSchema: { type: "object", properties: {} },
  async handler() {
    return {
      ok: false,
      error: "vision_trace is not implemented yet: it will record a step-by-step trace of the vision chain in a later milestone. No vision provider is called."
    };
  }
});
registerTool({
  name: "vision_screenshot",
  description: "Render HTML to a screenshot image (not implemented yet).",
  inputSchema: {
    type: "object",
    properties: {
      html: { type: "string", description: "HTML document to render" }
    }
  },
  async handler() {
    return {
      ok: false,
      error: "vision_screenshot is not implemented yet: it requires the optional peer dependency puppeteer-core (npm i puppeteer-core) plus a browser executable; planned for a later milestone."
    };
  }
});
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_PATHS = ["/tmp", "/private/tmp"];
function buildFailureResponse(status, message, providerName, retryable = true, kindOverride) {
  const kind = kindOverride ?? (status === 401 || status === 403 ? "AUTH" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : "OTHER");
  const code = kindOverride && status === 0 ? `VISION_${message}` : `VISION_${status}`;
  return {
    ok: false,
    meta: { provider: providerName, model: "unknown", durationMs: 0 },
    errors: [{ kind, code, message, retryable }]
  };
}
function authMissing(providerName) {
  return buildFailureResponse(0, "AUTH_MISSING", providerName, true, "AUTH");
}
function classifyLocalFileError(error, providerName, fallbackMessage) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "PATH_DENIED" || message === "FILE_TOO_LARGE") {
    return buildFailureResponse(0, message, providerName, false, "INVALID_REQUEST");
  }
  return buildFailureResponse(0, fallbackMessage, providerName);
}
function detectMime(path) {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const mimeMap = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml"
  };
  return mimeMap[ext] ?? "image/png";
}
function readFileAsBase64(path, allowedReadRoots = []) {
  const resolved = resolve(path);
  const allowed = isPathAllowed(resolved, [...ALLOWED_PATHS, DEFAULT_TEMP, ...allowedReadRoots]);
  if (!allowed) {
    throw new Error("PATH_DENIED");
  }
  if (!isPlainFileAt(resolved)) {
    throw new Error("PATH_DENIED");
  }
  const buffer = readFileSync(resolved);
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error("FILE_TOO_LARGE");
  }
  return buffer.toString("base64");
}
async function assertSafeTarget(url, allowLocalNetwork) {
  if (allowLocalNetwork) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`SSRF_UNSUPPORTED_PROTOCOL: ${parsed.protocol}`);
    }
    return;
  }
  await assertSafeRemoteTarget(url);
}
function composeSignal(options) {
  const signals = [
    options.signal,
    options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : void 0
  ].filter((s) => s !== void 0);
  if (signals.length > 1) {
    return AbortSignal.any(signals);
  }
  return signals[0];
}
async function postJson(url, headers, body, signal) {
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    redirect: "manual"
  });
}
function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}
function buildOpenAiContents(options, allowedReadRoots) {
  const contents = [];
  if (options.query) contents.push({ type: "text", text: options.query });
  for (const img of options.images) {
    if (img.kind === "local" && img.path) {
      const mime = img.mime || detectMime(img.path);
      const base64 = readFileAsBase64(img.path, allowedReadRoots);
      contents.push({ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } });
    }
  }
  return contents;
}
async function executeOpenAiWire(spec, options) {
  const startTime = Date.now();
  try {
    await assertSafeTarget(spec.endpoint, spec.allowLocalNetwork);
    const contents = buildOpenAiContents(options, spec.allowedReadRoots);
    const response = await postJson(
      spec.endpoint,
      spec.headers,
      { model: spec.model, messages: [{ role: "user", content: contents }] },
      composeSignal(options)
    );
    if (!response.ok) {
      const message = response.status === 429 ? "RATE_LIMITED" : "API_ERROR";
      return buildFailureResponse(response.status, message, spec.name);
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      data: { summary: text },
      meta: { provider: spec.name, model: spec.model, durationMs: Date.now() - startTime }
    };
  } catch (error) {
    return classifyLocalFileError(error, spec.name, spec.catchMessage);
  }
}
function createOpenAIProvider(opts = {}) {
  const model = opts.model ?? "gpt-4o";
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  const apiKeyEnv = opts.apiKeyEnv ?? "OPENAI_API_KEY";
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: "openai",
    defaultModel: model,
    category: "api",
    speedClass: "fast",
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing("openai");
      return executeOpenAiWire(
        {
          name: "openai",
          model,
          endpoint: joinUrl(baseUrl, "/chat/completions"),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: "API_ERROR"
        },
        options
      );
    }
  };
}
function createAnthropicProvider(opts = {}) {
  const model = opts.model ?? "claude-3-5-sonnet-20241022";
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  const apiKeyEnv = opts.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: "anthropic",
    defaultModel: model,
    category: "api",
    speedClass: "fast",
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing("anthropic");
      const startTime = Date.now();
      try {
        const endpoint = joinUrl(baseUrl, "/v1/messages");
        await assertSafeTarget(endpoint, opts.allowLocalNetwork === true);
        const content = [];
        if (options.query) content.push({ type: "text", text: options.query });
        for (const img of options.images) {
          if (img.kind === "local" && img.path) {
            const mime = img.mime || detectMime(img.path);
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: mime,
                data: readFileAsBase64(img.path, allowedReadRoots)
              }
            });
          }
        }
        const response = await postJson(
          endpoint,
          {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          { model, max_tokens: 4096, messages: [{ role: "user", content }] },
          composeSignal(options)
        );
        if (!response.ok) return buildFailureResponse(response.status, "API_ERROR", "anthropic");
        const data = await response.json();
        const text = data.content?.find((c) => c.type === "text")?.text ?? "";
        return {
          ok: true,
          data: { summary: text },
          meta: { provider: "anthropic", model, durationMs: Date.now() - startTime }
        };
      } catch (error) {
        return classifyLocalFileError(error, "anthropic", "API_ERROR");
      }
    }
  };
}
function createGeminiProvider(opts = {}) {
  const model = opts.model ?? "gemini-2.0-flash";
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com";
  const apiKeyEnv = opts.apiKeyEnv ?? "GEMINI_API_KEY";
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: "gemini",
    defaultModel: model,
    category: "api",
    speedClass: "fast",
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing("gemini");
      const startTime = Date.now();
      try {
        const endpoint = joinUrl(baseUrl, `/v1beta/models/${model}:generateContent`);
        await assertSafeTarget(endpoint, opts.allowLocalNetwork === true);
        const parts = [];
        if (options.query) parts.push({ text: options.query });
        for (const img of options.images) {
          if (img.kind === "local" && img.path) {
            const mime = img.mime || detectMime(img.path);
            parts.push({
              inlineData: { mimeType: mime, data: readFileAsBase64(img.path, allowedReadRoots) }
            });
          }
        }
        const response = await postJson(
          endpoint,
          { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          { contents: [{ role: "user", parts }] },
          composeSignal(options)
        );
        if (!response.ok) return buildFailureResponse(response.status, "API_ERROR", "gemini");
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        return {
          ok: true,
          data: { summary: text },
          meta: { provider: "gemini", model, durationMs: Date.now() - startTime }
        };
      } catch (error) {
        return classifyLocalFileError(error, "gemini", "API_ERROR");
      }
    }
  };
}
function createOvhProvider(opts = {}) {
  const model = opts.model ?? "Qwen2.5-VL-72B-Instruct";
  const baseUrl = opts.baseUrl ?? "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: "ovh-free",
    defaultModel: model,
    category: "free",
    speedClass: "slow",
    async execute(options) {
      return executeOpenAiWire(
        {
          name: "ovh-free",
          model,
          endpoint: joinUrl(baseUrl, "/chat/completions"),
          headers: { "Content-Type": "application/json" },
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: "NETWORK_ERROR"
        },
        options
      );
    }
  };
}
function createZhipuProvider(opts = {}) {
  const model = opts.model ?? "glm-4.6v-flash";
  const baseUrl = opts.baseUrl ?? "https://open.bigmodel.cn/api/paas/v4";
  const apiKeyEnv = opts.apiKeyEnv ?? "ZAI_API_KEY";
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: "zhipu",
    defaultModel: model,
    category: "free",
    speedClass: "fast",
    async execute(options) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return authMissing("zhipu");
      return executeOpenAiWire(
        {
          name: "zhipu",
          model,
          endpoint: joinUrl(baseUrl, "/chat/completions"),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: "NETWORK_ERROR"
        },
        options
      );
    }
  };
}
function createOpenAICompatibleProvider(name2, opts = {}) {
  const baseUrl = opts.baseUrl;
  if (!baseUrl) {
    throw new Error(`Provider "${name2}": baseUrl is required for OpenAI-compatible providers`);
  }
  const model = opts.model ?? "qwen2.5-vl:7b";
  const allowedReadRoots = opts.allowedReadRoots ?? [];
  return {
    name: name2,
    defaultModel: model,
    category: opts.category ?? "local",
    speedClass: "medium",
    async execute(options) {
      const headers = { "Content-Type": "application/json" };
      if (opts.apiKeyEnv) {
        const apiKey = process.env[opts.apiKeyEnv];
        if (!apiKey) return authMissing(name2);
        headers.Authorization = `Bearer ${apiKey}`;
      }
      return executeOpenAiWire(
        {
          name: name2,
          model,
          endpoint: joinUrl(baseUrl, "/chat/completions"),
          headers,
          allowLocalNetwork: opts.allowLocalNetwork === true,
          allowedReadRoots,
          catchMessage: "NETWORK_ERROR"
        },
        options
      );
    }
  };
}
createOpenAIProvider();
createAnthropicProvider();
createGeminiProvider();
createOvhProvider();
createZhipuProvider();
function requiresImage(def) {
  const required = def.inputSchema.required;
  return Array.isArray(required) && required.includes("image");
}
class OmniVisionPlugin {
  constructor(ctx) {
    this.ctx = ctx;
    this.config = resolveConfig(ctx.config);
    this.circuitBreaker = new VisionCircuitBreaker();
    this.policy = new PathPolicy(ctx.workspace, { tempDir: DEFAULT_TEMP });
    this.providers = this.composeProviders();
    this.bridge = new VisionBridge(this.providers, this.config.mode, {
      sessionId: ctx.sessionId,
      circuitBreaker: this.circuitBreaker,
      cacheEnabled: this.config.cache,
      cacheTtlMs: this.config.cacheTtlSeconds * 1e3,
      cacheMaxEntries: this.config.cacheMaxEntries,
      totalTimeoutMs: this.config.timeoutMs,
      providerTimeoutMs: this.config.visionTaskTimeoutMs
    });
  }
  bridge;
  circuitBreaker;
  providers;
  policy;
  /** Effective config: user values merged over DEFAULT_CONFIG */
  config;
  /**
   * Compose the provider chain (failover order):
   *  1. extraProviders (test seam)
   *  2. config.providers custom entries
   *  3. local LM Studio, then local Ollama
   *  4. free cloud fallback (ordering driven by freeCloudFirst)
   */
  composeProviders() {
    const config = this.config;
    const allowedReadRoots = [this.ctx.workspace, DEFAULT_TEMP];
    const providers = [];
    if (this.ctx.extraProviders) providers.push(...this.ctx.extraProviders);
    for (const entry of config.providers) {
      const opts = {
        model: entry.model,
        baseUrl: entry.baseUrl,
        apiKeyEnv: entry.apiKeyEnv,
        allowedReadRoots
      };
      switch (entry.name) {
        case "openai":
          providers.push(createOpenAIProvider(opts));
          break;
        case "anthropic":
          providers.push(createAnthropicProvider(opts));
          break;
        case "gemini":
          providers.push(createGeminiProvider(opts));
          break;
        case "zhipu":
          providers.push(createZhipuProvider(opts));
          break;
        case "ovh":
        case "ovh-free":
          providers.push(createOvhProvider(opts));
          break;
        default:
          if (entry.baseUrl) {
            providers.push(
              createOpenAICompatibleProvider(entry.name, { ...opts, category: "api" })
            );
          }
      }
    }
    if (config.localLmStudio.enabled) {
      providers.push(
        createOpenAICompatibleProvider("lmstudio", {
          baseUrl: config.localLmStudio.baseURL,
          model: config.localLmStudio.model,
          allowedReadRoots,
          allowLocalNetwork: true
        })
      );
    }
    if (config.localOllama.enabled) {
      providers.push(
        createOpenAICompatibleProvider("ollama", {
          baseUrl: config.localOllama.baseURL,
          model: config.localOllama.model,
          allowedReadRoots,
          allowLocalNetwork: true
        })
      );
    }
    if (config.freeFallback) {
      const zhipu = createZhipuProvider({ allowedReadRoots });
      const ovh = createOvhProvider({ allowedReadRoots });
      const zhipuReady = Boolean(process.env.ZAI_API_KEY);
      const zen = config.freeZen;
      const zenProvider = zen?.enabled && zen.model && process.env[zen.apiKeyEnv ?? "OPENCODE_API_KEY"] ? createOpenAICompatibleProvider("zen-free", {
        baseUrl: "https://opencode.ai/zen/v1",
        model: zen.model,
        apiKeyEnv: zen.apiKeyEnv,
        allowedReadRoots,
        category: "free"
      }) : void 0;
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
  validateAttachment(raw, index) {
    if (typeof raw !== "object" || raw === null) return null;
    const v = raw;
    if (typeof v.path !== "string" || typeof v.contentHash !== "string") return null;
    const path = this.policy.normalize(v.path);
    if (!this.policy.allowInput(path)) return null;
    try {
      this.policy.rejectSymlink(path);
    } catch (error) {
      if (error instanceof Error && error.message.includes("SYMLINK_DENIED")) {
        return {
          ok: false,
          failure: {
            index,
            path,
            reason: "symlink",
            message: "Symbolic links are not allowed for image input"
          }
        };
      }
      return null;
    }
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return null;
    }
    if (size > this.config.maxImageBytes) {
      return {
        ok: false,
        failure: {
          index,
          path,
          reason: "too_large",
          message: `Image exceeds maxImageBytes (${size} > ${this.config.maxImageBytes})`
        }
      };
    }
    return {
      ok: true,
      image: {
        path,
        contentHash: v.contentHash,
        mime: typeof v.mime === "string" ? v.mime : "image/png",
        bytes: typeof v.bytes === "number" ? v.bytes : size,
        width: typeof v.width === "number" ? v.width : void 0,
        height: typeof v.height === "number" ? v.height : void 0
      }
    };
  }
  /**
   * Pre-step message processing: describe images BEFORE DeepSeek sees the
   * request and rewrite the content to pure text. Failed images never inject
   * error text into `newContent`; they are reported via `failures`.
   * When ALL images fail, `rewritten` is false and `newContent` is the
   * original content.
   */
  async processMessage(content, attachments = [], eventId) {
    const config = this.config;
    const images = [];
    const failures = [];
    for (let index = 0; index < attachments.length; index++) {
      const validated = this.validateAttachment(attachments[index], index);
      if (validated === null) continue;
      if (validated.ok) images.push(validated.image);
      else failures.push(validated.failure);
    }
    if (config.mode === "manual" || images.length === 0) {
      return {
        rewritten: false,
        newContent: content,
        imageCount: images.length,
        descriptions: [],
        hasErrors: failures.length > 0,
        failures: failures.length > 0 ? failures : void 0
      };
    }
    const isInteractive = config.mode === "interactive";
    const query = isInteractive ? buildSummaryQuery(config.language) : buildDescribeQuery(config.language, config.visionDepth);
    const { descriptions: successDescriptions, failures: bridgeFailures } = await this.bridge.processImages(images, query);
    const failedIndices = new Set(bridgeFailures.map((f) => f.index));
    const successImages = images.filter((_, i) => !failedIndices.has(i));
    for (const failure of bridgeFailures) {
      failures.push({
        index: failure.index,
        path: images[failure.index]?.path ?? "",
        reason: "provider",
        message: failure.message
      });
    }
    if (successDescriptions.length === 0) {
      return {
        rewritten: false,
        newContent: content,
        imageCount: images.length,
        descriptions: [],
        hasErrors: true,
        failures: failures.length > 0 ? failures : void 0
      };
    }
    const toolHint = isInteractive ? buildToolHint(config.language) : void 0;
    const rewritten = rewriteMessage(content, successImages, successDescriptions, config.language, {
      toolHint
    });
    const shadows = eventId ? createShadowReplacements(
      eventId,
      successImages,
      successDescriptions.map((d) => d.summary)
    ) : void 0;
    return {
      rewritten: true,
      newContent: rewritten.content,
      imageCount: images.length,
      descriptions: successDescriptions.map((d) => d.summary),
      shadows,
      hasErrors: failures.length > 0,
      failures: failures.length > 0 ? failures : void 0
    };
  }
  /**
   * Dispatch a tool call through the registry: validate args, resolve the
   * image attachment, build the ToolContext and invoke the handler.
   * Handler exceptions are caught and returned as redacted errors.
   */
  async callTool(tool, args = {}) {
    const definition = getTool(tool);
    if (!definition) {
      const available = listTools().map((t) => t.name).join(", ");
      return { ok: false, error: `Unknown tool: ${tool}. Available: ${available}` };
    }
    const validationError = validateToolArgs(definition, args);
    if (validationError) return { ok: false, error: validationError };
    let image;
    if (args.image !== void 0) {
      const validated = this.validateAttachment(args.image, 0);
      if (validated === null || !validated.ok) {
        const detail = validated && !validated.ok ? validated.failure.message : "invalid shape";
        return { ok: false, error: `Invalid image attachment: ${detail}` };
      }
      image = validated.image;
    }
    if (!image && requiresImage(definition)) {
      return { ok: false, error: "Missing required argument: image" };
    }
    const ctx = {
      bridge: this.bridge,
      image: image ?? { path: "", contentHash: "", mime: "image/png", bytes: 0 },
      query: typeof args.query === "string" ? args.query : void 0,
      config: this.config
    };
    try {
      return await definition.handler(ctx, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: redactSecrets(message, getKnownSecrets()) };
    }
  }
  stats() {
    return {
      cache: this.bridge.stats(),
      circuit: this.circuitBreaker.stats(),
      providers: this.providers.length
    };
  }
  dispose() {
    this.bridge.clear();
    this.circuitBreaker.clear();
  }
}
function createOmnivisionPlugin(ctx) {
  return new OmniVisionPlugin(ctx);
}
const name = "dsh-omnivision";
const inject = [];
const mounted = /* @__PURE__ */ new WeakMap();
function mountedFor(ctx) {
  return mounted.get(ctx);
}
function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});
  const workspace = process.cwd();
  const plugin = createOmnivisionPlugin({ config: resolved, workspace });
  mounted.set(ctx, { plugin, config: resolved, workspace });
  for (const warning of validateConfig(resolved)) {
    ctx.logger?.warn?.(`[omnivision] ${warning}`);
  }
  ctx.logger?.info?.(
    `[omnivision] ready (mode=${resolved.mode}, providers=${plugin.stats().providers})`
  );
  ctx.effect?.(() => () => plugin.dispose(), "omnivision-dispose");
  return plugin;
}
export {
  DEFAULT_CONFIG,
  OmniVisionPlugin,
  apply,
  createOmnivisionPlugin,
  getTool,
  inject,
  listTools,
  mountedFor,
  name,
  registerTool,
  resolveConfig,
  toolRegistry,
  validateConfig
};
//# sourceMappingURL=index.js.map
