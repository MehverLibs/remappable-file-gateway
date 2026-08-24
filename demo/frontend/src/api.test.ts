import { afterEach, describe, expect, it, vi } from "vitest";

import {
  API_PATHS,
  apiUrl,
  createApiCallLog,
  createRfgClient,
  normalizeApiBase,
  resolveApiBase,
  resourceUrl,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveApiBase", () => {
  it("defaults to same-origin (empty string)", () => {
    expect(resolveApiBase("")).toBe("");
    expect(resolveApiBase("?view=workspace")).toBe("");
    expect(resolveApiBase("?apiBase=")).toBe("");
  });

  it("accepts absolute origins and strips trailing slashes", () => {
    expect(resolveApiBase("?apiBase=https://files.example.com")).toBe("https://files.example.com");
    expect(resolveApiBase("?apiBase=https://files.example.com/")).toBe("https://files.example.com");
    expect(resolveApiBase("?apiBase=https://files.example.com///")).toBe(
      "https://files.example.com",
    );
  });

  it("accepts HTTP(S) path prefixes and survives URL encoding", () => {
    expect(resolveApiBase("?apiBase=https://files.example.com/gateway/")).toBe(
      "https://files.example.com/gateway",
    );
    expect(resolveApiBase("?apiBase=http%3A%2F%2F127.0.0.1%3A8080")).toBe("http://127.0.0.1:8080");
  });

  it("safely falls back to same-origin for relative or unsafe overrides", () => {
    expect(resolveApiBase("?apiBase=/gateway/")).toBe("");
    expect(resolveApiBase("?apiBase=javascript:alert(1)")).toBe("");
    expect(resolveApiBase("?apiBase=file:///tmp/rfg")).toBe("");
    expect(resolveApiBase("?apiBase=ftp://files.example.com")).toBe("");
  });

  it("ignores unrelated parameters", () => {
    expect(resolveApiBase("?view=workspace&apiBase=https://a.b&x=1")).toBe("https://a.b");
  });
});

describe("normalizeApiBase / apiUrl", () => {
  it("trims whitespace and trailing slashes from absolute HTTP(S) bases", () => {
    expect(normalizeApiBase("  https://a.b/ ")).toBe("https://a.b");
    expect(normalizeApiBase("")).toBe("");
  });

  it("does not pass unsafe direct bases to API or resource URL generation", () => {
    expect(normalizeApiBase("javascript:alert(1)")).toBe("");
    expect(apiUrl("file:///tmp/rfg", API_PATHS.local)).toBe("/api/v1/meta/local");
    expect(resourceUrl("javascript:alert(1)", "报告.png")).toBe(
      `/res/${encodeURIComponent("报告.png")}`,
    );
    expect(createRfgClient("javascript:alert(1)").base).toBe("");
  });

  it("joins base and path", () => {
    expect(apiUrl("", "/api/v1/health")).toBe("/api/v1/health");
    expect(apiUrl("https://a.b/", API_PATHS.local)).toBe("https://a.b/api/v1/meta/local");
  });
});

describe("resourceUrl", () => {
  it("builds /res/<virtual_path> with encoded segments and intact separators", () => {
    expect(resourceUrl("", "dir/a b.jpg")).toBe("/res/dir/a%20b.jpg");
    expect(resourceUrl("https://a.b", "报告/一#1.png")).toBe(
      `https://a.b/res/${encodeURIComponent("报告")}/${encodeURIComponent("一#1.png")}`,
    );
  });
});

describe("client request shapes", () => {
  interface RecordedCall {
    url: string;
    init: RequestInit;
  }

  /** Stub global fetch; records calls and answers with `body`. */
  function stubFetch(body: unknown): RecordedCall[] {
    const calls: RecordedCall[] = [];
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const status = 200;
      return Promise.resolve({
        ok: true,
        status,
        json: () => Promise.resolve(body),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("PUT /api/v1/meta/map submits the raw document unconditionally, without If-Match", async () => {
    const calls = stubFetch({ entries: [] });
    const client = createRfgClient("https://a.b/");
    await client.putMapping({ entries: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://a.b/api/v1/meta/map");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ entries: [] }));
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["If-Match"]).toBeUndefined();
  });

  it("GET local catalog returns path and current size", async () => {
    const calls = stubFetch({ local_files: [{ local_path: "a.txt", size_bytes: 12 }] });
    const client = createRfgClient("");
    await expect(client.getLocalFiles()).resolves.toEqual([{ local_path: "a.txt", size_bytes: 12 }]);
    expect(calls[0]?.url).toBe("/api/v1/meta/local");
  });

  it("POST /api/v1/hashes sends one exact request and returns the structured final result", async () => {
    const calls = stubFetch({ local_path: "a.txt", algorithm: "md5", profile: null, status: "succeeded", value: "aa", code: "computed", detail: null, error: null });
    const client = createRfgClient("");
    const result = await client.hash({ local_path: "a.txt", algorithm: "md5" });
    expect(calls[0]?.url).toBe("/api/v1/hashes");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      local_path: "a.txt",
      algorithm: "md5",
    });
    expect(result).toEqual({ local_path: "a.txt", algorithm: "md5", profile: null, status: "succeeded", value: "aa", code: "computed", detail: null, error: null });
  });

  it("serializes only HashRequest fields even when a scheduler item is passed at runtime", async () => {
    const calls = stubFetch({ local_path: "a.txt", algorithm: "md5", profile: null, status: "succeeded", value: "aa", code: "computed", detail: null, error: null });
    await createRfgClient("").hash({ local_path: "a.txt", algorithm: "md5", state: "running", retryAt: 123 } as never);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ local_path: "a.txt", algorithm: "md5" });
  });

  it("rejects malformed terminal results instead of exposing a non-contract state", async () => {
    stubFetch({ local_path: "a.txt", algorithm: "md5", status: "invalid", value: "aa" });
    await expect(createRfgClient("").hash({ local_path: "a.txt", algorithm: "md5" })).rejects.toThrow(
      "Invalid hash result",
    );
  });

  it("preserves the backend structured error on a failed hash", async () => {
    stubFetch({ local_path: "a.txt", algorithm: "md5", profile: null, status: "failed", value: null, code: "source_stale", detail: "source changed", error: { code: "source_stale", message: "source changed", retryable: true } });
    await expect(createRfgClient("").hash({ local_path: "a.txt", algorithm: "md5" })).resolves.toMatchObject({
      status: "failed", error: { code: "source_stale", message: "source changed", retryable: true },
    });
  });

  it("GET requests stay body-less and Content-Type-free", async () => {
    const calls = stubFetch({ local_files: [{ local_path: "a.txt", size_bytes: 1 }] });
    const client = createRfgClient("");
    const files = await client.getLocalFiles();
    expect(files).toEqual([{ local_path: "a.txt", size_bytes: 1 }]);
    expect(calls[0]?.url).toBe("/api/v1/meta/local");
    expect(calls[0]?.init.method ?? "GET").toBe("GET");
    expect(calls[0]?.init.headers).toBeUndefined();
  });

  it("records successful calls and marks HTTP 200 hash failures as hash-failed with path, algorithm, and code", async () => {
    const log = createApiCallLog();
    stubFetch({ local_path: "a.txt", algorithm: "md5", profile: null, status: "failed", value: null, code: "source_stale", detail: "source changed", error: { code: "source_stale", message: "source changed", retryable: true } });
    await createRfgClient("", log).hash({ local_path: "a.txt", algorithm: "md5" });
    expect(log.snapshot()).toMatchObject([{
      method: "POST", route: "/api/v1/hashes", requestDescription: "a.txt · md5", status: 200,
      outcome: "hash-failed", resultDescription: "failed · source_stale: source changed",
    }]);
    expect(log.snapshot()[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("creates one pending hash entry before fetch settles and updates that entry on success", async () => {
    const log = createApiCallLog();
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const hashing = createRfgClient("", log).hash({ local_path: "slow.txt", algorithm: "sha256" });
    expect(log.snapshot()).toMatchObject([{
      method: "POST", route: "/api/v1/hashes", requestDescription: "slow.txt · sha256",
      status: null, outcome: "pending", resultDescription: "请求中",
    }]);
    const pendingId = log.snapshot()[0]?.id;
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ local_path: "slow.txt", algorithm: "sha256", profile: null, status: "succeeded", value: "aa", code: "computed", detail: null, error: null }) } as Response);
    await hashing;
    expect(log.snapshot()).toHaveLength(1);
    expect(log.snapshot()[0]).toMatchObject({ id: pendingId, status: 200, outcome: "success", resultDescription: "succeeded · computed" });
  });

  it("records an ordinary HTTP 200 response as success", async () => {
    const log = createApiCallLog();
    stubFetch({ status: "ok", product: "RemappableFileGateway" });
    await createRfgClient("", log).health();
    expect(log.snapshot()[0]).toMatchObject({ status: 200, outcome: "success", resultDescription: "ok · RemappableFileGateway" });
  });

  it("records HTTP failures including 429 without exposing mapping payloads", async () => {
    const log = createApiCallLog();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 429, headers: new Headers({ "Retry-After": "1" }), json: () => Promise.resolve({ detail: "busy" }) } as Response)));
    await expect(createRfgClient("", log).putMapping({ entries: [{ virtual_path: "private", local_path: "secret" }] })).rejects.toMatchObject({ status: 429 });
    expect(log.snapshot()).toMatchObject([{
      method: "PUT", route: "/api/v1/meta/map", requestDescription: "保存映射（1 条）", status: 429, outcome: "http-error", resultDescription: "busy",
    }]);
  });

  it("records network failures and cancellations", async () => {
    const networkLog = createApiCallLog();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    await expect(createRfgClient("", networkLog).health()).rejects.toMatchObject({ status: 0 });
    expect(networkLog.snapshot()[0]).toMatchObject({ method: "GET", route: "/api/v1/health", status: null, outcome: "network-error" });

    const cancelledLog = createApiCallLog();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError"))));
    await expect(createRfgClient("", cancelledLog).getLocalFiles()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledLog.snapshot()[0]).toMatchObject({ route: "/api/v1/meta/local", status: null, outcome: "cancelled" });
  });

});
