/**
 * Typed client for the fixed RemappableFileGateway (RFG) API contract.
 *
 * Public routes:
 *
 * - `GET  /api/v1/health`        → `{status:"ok", product:"RemappableFileGateway"}`
 * - `GET  /api/v1/meta/local`    → `{local_files:[{local_path,size_bytes}]}`.
 * - `GET  /api/v1/meta/map`      → the raw mapping document `{entries:[...]}`.
 * - `PUT  /api/v1/meta/map`      → submit the same JSON document wholesale;
 *   the backend validates and persists atomically. The backend accepts an
 *   optional If-Match, but this demo submits unconditional replacements.
 * - `POST /api/v1/hashes`        → `{local_path,algorithm}`; returns one
 *   final HashResult (HTTP 200). 429 includes Retry-After and was not accepted.
 * - `GET|HEAD /res/{virtual_path}` → mapped content; `archive.rfg.zip!/member`
 *   is a legitimate local logical path on the local side of a mapping.
 *
 * The demo defaults to same-origin relative URLs; `?apiBase=https://host`
 * (optionally with a path prefix) overrides the base so a single-file build
 * can be served standalone or statically hosted on another origin. Query overrides
 * accept only absolute http(s) URLs; invalid values safely use same-origin.
 */

export type HashAlgorithm = "crc32" | "md5" | "sha256" | "ahash" | "dhash" | "phash";

export const HASH_ALGORITHMS: readonly HashAlgorithm[] = [
  "crc32",
  "md5",
  "sha256",
  "ahash",
  "dhash",
  "phash",
];
export const IMAGE_HASH_ALGORITHMS: readonly HashAlgorithm[] = ["ahash", "dhash", "phash"];

export interface HashRequest {
  local_path: string;
  algorithm: HashAlgorithm;
}
export interface HashErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
}

export interface HashSucceeded extends HashRequest {
  profile: string | null;
  status: "succeeded";
  value: string;
  code: string;
  detail: null;
  error: null;
}

export interface HashFailed extends HashRequest {
  profile: string | null;
  status: "failed";
  value: null;
  code: string;
  detail: string;
  error: HashErrorDetail;
}

/** Final result returned by POST /api/v1/hashes. */
export type HashResult = HashSucceeded | HashFailed;
export interface LocalFile { local_path: string; size_bytes: number; }

/**
 * One virtual workspace entry. `size_bytes` and every hash are optional
 * (absent/null = unknown). Entries carry no id, enabled flag, source object,
 * schema marker, attributes, or revision.
 */
export interface MappingEntry {
  virtual_path: string;
  local_path: string;
  size_bytes?: number | null;
  crc32?: string | null;
  md5?: string | null;
  sha256?: string | null;
  ahash?: string | null;
  dhash?: string | null;
  phash?: string | null;
}

/** The whole mapping document: exactly an object with an entries list. */
export interface MappingDocument {
  entries: MappingEntry[];
}

export interface HealthResponse {
  status: string;
  product: string;
}

export const RFG_PRODUCT_NAME = "RemappableFileGateway";

/** Canonical route paths, for clients and for documentation samples. */
export const API_PATHS = {
  health: "/api/v1/health",
  local: "/api/v1/meta/local",
  map: "/api/v1/meta/map",
  hashes: "/api/v1/hashes",
} as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly payload: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export type ApiCallOutcome = "pending" | "success" | "hash-failed" | "http-error" | "network-error" | "cancelled";
export interface ApiCallLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly method: string;
  readonly route: string;
  readonly requestDescription: string;
  readonly status: number | null;
  readonly outcome: ApiCallOutcome;
  readonly durationMs: number;
  readonly resultDescription: string;
}

/** Browser-local, observable request history. It deliberately stores summaries, never request bodies. */
export interface ApiCallLog {
  snapshot(): readonly ApiCallLogEntry[];
  subscribe(listener: () => void): () => void;
  clear(): void;
  record(entry: Omit<ApiCallLogEntry, "id">): number;
  update(id: number, entry: Omit<ApiCallLogEntry, "id">): void;
}

export function createApiCallLog(): ApiCallLog {
  let nextId = 1;
  let entries: ApiCallLogEntry[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    snapshot: () => entries,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    clear: () => { entries = []; notify(); },
    record: (entry) => {
      const id = nextId++;
      entries = [...entries, { ...entry, id }];
      notify();
      return id;
    },
    update: (id, entry) => {
      const index = entries.findIndex((candidate) => candidate.id === id);
      if (index < 0) return;
      entries = entries.map((candidate) => candidate.id === id ? { ...entry, id } : candidate);
      notify();
    },
  };
}

/** Default shared browser history, used even by clients without an explicit observer. */
export const browserApiCallLog = createApiCallLog();

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Human-readable one-liner for any failure surfaced to the UI. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `[${error.status}] ${error.detail}` : error.detail;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function extractDetail(status: number, body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      // FastAPI 422 validation payload: [{loc, msg, type}, ...]
      const parts = detail
        .map((entry) => {
          if (!entry || typeof entry !== "object") return String(entry);
          const loc = Array.isArray(entry.loc) ? entry.loc.join(".") : "";
          const msg = typeof entry.msg === "string" ? entry.msg : JSON.stringify(entry);
          return loc ? `${loc}: ${msg}` : msg;
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join("；");
    }
  }
  return `HTTP ${status}`;
}

/**
 * Normalize a user-supplied API base. "" means same-origin relative URLs.
 * Only absolute HTTP(S) bases are accepted; relative values and all other
 * schemes safely fall back to "" so they cannot reach fetch or resource URL
 * generation. Query strings and fragments are rejected because a base is a
 * URL prefix, not a request URL.
 */
export function normalizeApiBase(value: string): string {
  const raw = value.trim();
  if (raw === "") return "";
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname === "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return "";
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return "";
  }
}

/**
 * Resolve the API base from a query string (`?apiBase=...`). Absent, empty,
 * relative, or non-HTTP(S) values fall back to "" (same origin).
 */
export function resolveApiBase(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("apiBase");
  if (raw === null) return "";
  return normalizeApiBase(raw);
}

/** Join an API base ("" = same origin) with an absolute API path. */
export function apiUrl(base: string, path: string): string {
  return `${normalizeApiBase(base)}${path}`;
}

/**
 * Content URL for a mapped virtual path: `/res/<virtual_path>` with each
 * path segment URI-encoded (separators stay intact for the `:path` route).
 */
export function resourceUrl(base: string, virtualPath: string): string {
  const encoded = virtualPath.split("/").map(encodeURIComponent).join("/");
  return apiUrl(base, `/res/${encoded}`);
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

async function request<T>(
  base: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    requestDescription?: string;
    describeResult?: (body: T) => string;
    isFailedResult?: (body: T) => boolean;
  } = {},
  log: ApiCallLog = browserApiCallLog,
): Promise<T> {
  const method = init.method ?? "GET";
  const startedAt = Date.now();
  const entry = (status: number | null, outcome: ApiCallOutcome, resultDescription: string) => ({
    timestamp: new Date(startedAt).toISOString(), method, route: path,
    requestDescription: init.requestDescription ?? path, status, outcome,
    durationMs: Date.now() - startedAt, resultDescription,
  });
  const entryId = log.record(entry(null, "pending", "请求中"));
  const settle = (status: number | null, outcome: Exclude<ApiCallOutcome, "pending">, resultDescription: string) =>
    log.update(entryId, entry(status, outcome, resultDescription));
  let response: Response;
  try {
    response = await fetch(apiUrl(base, path), {
      method,
      signal: init.signal,
      // A JSON Content-Type is only sent when there is a body, so plain GETs
      // stay CORS-simple for cross-origin apiBase deployments.
      ...(init.body !== undefined
        ? { body: JSON.stringify(init.body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
  } catch (error) {
    if (isAbortError(error)) { settle(null, "cancelled", "请求已取消"); throw error; }
    settle(null, "network-error", "无法连接后端服务");
    throw new ApiError(0, "无法连接后端服务（网络错误、服务未启动或跨域被拒绝）", null);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = extractDetail(response.status, body);
    settle(response.status, "http-error", detail);
    throw new ApiError(response.status, detail, body, retryAfterMs(response.headers.get("Retry-After")));
  }
  try {
    const body = await response.json() as T;
    settle(response.status, init.isFailedResult?.(body) ? "hash-failed" : "success", init.describeResult?.(body) ?? "完成");
    return body;
  } catch (error) {
    settle(response.status, "success", error instanceof Error ? error.message : "响应解析失败");
    throw error;
  }
}

function isHashErrorDetail(value: unknown): value is HashErrorDetail {
  return !!value && typeof value === "object" &&
    typeof (value as HashErrorDetail).code === "string" &&
    typeof (value as HashErrorDetail).message === "string" &&
    typeof (value as HashErrorDetail).retryable === "boolean";
}

/** Validate the final hashes response before it enters UI state. */
function parseHashResult(value: unknown): HashResult {
  if (!value || typeof value !== "object") throw new Error("Invalid hash result");
  const result = value as Record<string, unknown>;
  const shared = typeof result.local_path === "string" &&
    typeof result.algorithm === "string" &&
    (typeof result.profile === "string" || result.profile === null) &&
    typeof result.code === "string";
  if (shared && result.status === "succeeded" && typeof result.value === "string" && result.detail === null && result.error === null) {
    return result as unknown as HashSucceeded;
  }
  if (shared && result.status === "failed" && result.value === null && typeof result.detail === "string" && isHashErrorDetail(result.error)) {
    return result as unknown as HashFailed;
  }
  throw new Error("Invalid hash result");
}

export interface RfgClient {
  /** Normalized API base; "" means same origin. */
  readonly base: string;
  health(signal?: AbortSignal): Promise<HealthResponse>;
  /** Returns the current local catalog with authoritative sizes. */
  getLocalFiles(signal?: AbortSignal): Promise<LocalFile[]>;
  getMapping(signal?: AbortSignal): Promise<MappingDocument>;
  /** Wholesale replace; the saved (validated) document is returned. */
  putMapping(document: MappingDocument, signal?: AbortSignal): Promise<MappingDocument>;
  hash(request: HashRequest, signal?: AbortSignal): Promise<HashResult>;
  resourceUrl(virtualPath: string): string;
}

function hashRequestDescription(request: HashRequest): string {
  return `${request.local_path} · ${request.algorithm}`;
}

function hashResultDescription(value: unknown): string {
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    if (result.status === "failed" && typeof result.code === "string") {
      return `failed · ${result.code}${typeof result.detail === "string" ? `: ${result.detail}` : ""}`;
    }
    if (result.status === "succeeded" && typeof result.code === "string") return `succeeded · ${result.code}`;
  }
  return "响应已接收";
}

export function createRfgClient(apiBase: string, log: ApiCallLog = browserApiCallLog): RfgClient {
  const base = normalizeApiBase(apiBase);
  return {
    base,
    health: (signal) => request<HealthResponse>(base, API_PATHS.health, {
      signal, requestDescription: "健康检查", describeResult: (result) => `${result.status} · ${result.product}`,
    }, log),
    getLocalFiles: async (signal) => {
      const body = await request<{ local_files: LocalFile[] }>(base, API_PATHS.local, {
        signal, requestDescription: "读取本地目录", describeResult: (result) => `${result.local_files.length} 个文件`,
      }, log);
      return body.local_files;
    },
    getMapping: (signal) => request<MappingDocument>(base, API_PATHS.map, {
      signal, requestDescription: "读取映射", describeResult: (result) => `${result.entries.length} 条映射`,
    }, log),
    putMapping: (document, signal) =>
      request<MappingDocument>(base, API_PATHS.map, {
        method: "PUT", body: document, signal, requestDescription: `保存映射（${document.entries.length} 条）`,
        describeResult: (result) => `${result.entries.length} 条映射已保存`,
      }, log),
    hash: async (hashRequest, signal) => {
      // Defensively discard queue/UI runtime fields before serialization.
      const body: HashRequest = { local_path: hashRequest.local_path, algorithm: hashRequest.algorithm };
      return parseHashResult(await request<unknown>(base, API_PATHS.hashes, {
        method: "POST",
        body,
        signal,
        requestDescription: hashRequestDescription(body),
        describeResult: hashResultDescription,
        isFailedResult: (result) => !!result && typeof result === "object" && (result as { status?: unknown }).status === "failed",
      }, log));
    },
    resourceUrl: (virtualPath) => resourceUrl(base, virtualPath),
  };
}
