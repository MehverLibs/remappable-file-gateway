import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type HashRequest, type HashResult } from "./api";
import { HashQueue } from "./hashQueue";

const request: HashRequest = { local_path: "a.txt", algorithm: "md5" };
const succeeded: HashResult = { ...request, profile: null, status: "succeeded", value: "aa", code: "computed", detail: null, error: null };

describe("HashQueue", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("deduplicates one local_path × algorithm request and fans its result out to every consumer", async () => {
    const execute = vi.fn().mockResolvedValue(succeeded);
    const queue = new HashQueue(execute, { concurrency: 1, jitter: () => 0 });
    const first = vi.fn();
    const second = vi.fn();
    queue.enqueue(request, first);
    queue.enqueue(request, second);
    await queue.whenIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(succeeded);
    expect(second).toHaveBeenCalledWith(succeeded);
  });

  it("releases completed consumers after fanout while later consumers still receive the final result", async () => {
    const execute = vi.fn().mockResolvedValue(succeeded);
    const queue = new HashQueue(execute, { concurrency: 1, jitter: () => 0 });
    const first = vi.fn();
    const later = vi.fn();
    queue.enqueue(request, first);
    await queue.whenIdle();
    expect(first).toHaveBeenCalledWith(succeeded);
    expect((queue as unknown as { consumers: Map<string, unknown> }).consumers.size).toBe(0);
    queue.enqueue(request, later);
    expect(later).toHaveBeenCalledWith(succeeded);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("passes a plain HashRequest to every execution, never scheduler state", async () => {
    const execute = vi.fn().mockResolvedValue(succeeded);
    const queue = new HashQueue(execute, { concurrency: 1, jitter: () => 0 });
    queue.enqueue(request);
    await queue.whenIdle();
    expect(execute).toHaveBeenCalledWith({ local_path: "a.txt", algorithm: "md5" }, expect.any(AbortSignal));
  });

  it("moves a 429 request to retry-wait using Retry-After and retries it", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockRejectedValueOnce(new ApiError(429, "busy", null, 1000)).mockResolvedValue(succeeded);
    const queue = new HashQueue(execute, { concurrency: 1, jitter: () => 0 });
    queue.enqueue(request);
    await vi.waitFor(() => expect(queue.snapshot()[0]?.state).toBe("retry-wait"));
    await vi.advanceTimersByTimeAsync(1020);
    await queue.whenIdle();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queue.snapshot()[0]?.state).toBe("final");
  });

  it("does not retry ambiguous network failures", async () => {
    const execute = vi.fn().mockRejectedValue(new ApiError(0, "network", null));
    const queue = new HashQueue(execute, { jitter: () => 0 });
    queue.enqueue(request);
    await queue.whenIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.snapshot()[0]?.result?.status).toBe("failed");
    expect(queue.snapshot()[0]?.result).toEqual(expect.objectContaining({ local_path: "a.txt", algorithm: "md5" }));
    expect(queue.snapshot()[0]?.result).not.toHaveProperty("state");
  });

  it("disposes an in-flight request on abort and resolves idle without firing consumers", async () => {
    let rejectRequest!: (error: Error) => void;
    const execute = vi.fn((_request: HashRequest, signal: AbortSignal) => new Promise<HashResult>((_resolve, reject) => {
      rejectRequest = reject;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const consumer = vi.fn();
    const queue = new HashQueue(execute);
    queue.enqueue(request, consumer);
    await vi.waitFor(() => expect(queue.snapshot()[0]?.state).toBe("running"));
    queue.abort();
    await queue.whenIdle();
    expect(rejectRequest).toBeTypeOf("function");
    expect(queue.snapshot()).toEqual([]);
    expect(consumer).not.toHaveBeenCalled();
  });

  it("starts a fresh request after abort instead of delivering a cancelled lifecycle result", async () => {
    let rejectFirst!: (error: Error) => void;
    const execute = vi.fn()
      .mockImplementationOnce((_request: HashRequest, signal: AbortSignal) => new Promise<HashResult>((_resolve, reject) => {
        rejectFirst = reject;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(succeeded);
    const queue = new HashQueue(execute, { concurrency: 1, jitter: () => 0 });
    const cancelledConsumer = vi.fn();
    const freshConsumer = vi.fn();

    queue.enqueue(request, cancelledConsumer);
    await vi.waitFor(() => expect(queue.snapshot()[0]?.state).toBe("running"));
    queue.abort();
    queue.enqueue(request, freshConsumer);
    rejectFirst(new DOMException("aborted", "AbortError"));
    await queue.whenIdle();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(cancelledConsumer).not.toHaveBeenCalled();
    expect(freshConsumer).toHaveBeenCalledWith(succeeded);
  });

  it("cancels a scheduled 429 retry on abort without retaining the disposed request", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockRejectedValue(new ApiError(429, "busy", null, 1_000));
    const queue = new HashQueue(execute, { jitter: () => 0 });
    queue.enqueue(request);
    await vi.waitFor(() => expect(queue.snapshot()[0]?.state).toBe("retry-wait"));
    queue.abort();
    await queue.whenIdle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.snapshot()).toEqual([]);
  });
});
