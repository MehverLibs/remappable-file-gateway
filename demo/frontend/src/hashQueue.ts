import { ApiError, isAbortError, type HashRequest, type HashResult } from "./api";

export type HashQueueState = "pending" | "running" | "retry-wait" | "final";
export interface HashQueueItem extends HashRequest { state: HashQueueState; result?: HashResult; retryAt?: number }
type Consumer = (result: HashResult) => void;
type Execute = (request: HashRequest, signal: AbortSignal) => Promise<HashResult>;

/** Browser-owned, single-request scheduler. A key has one network request and many consumers. */
export class HashQueue {
  private items = new Map<string, HashQueueItem>();
  private consumers = new Map<string, Consumer[]>();
  private listeners = new Set<() => void>();
  private active = 0;
  private controller = new AbortController();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleResolvers: (() => void)[] = [];
  constructor(private readonly execute: Execute, private readonly options: { concurrency?: number; jitter?: () => number } = {}) {}
  private key(request: HashRequest) { return `${request.local_path}\u0000${request.algorithm}`; }
  snapshot(): HashQueueItem[] { return [...this.items.values()]; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify() { this.listeners.forEach((listener) => listener()); }
  enqueue(request: HashRequest, consumer?: Consumer): void {
    const key = this.key(request);
    const existing = this.items.get(key);
    if (consumer && existing?.state === "final" && existing.result) consumer(existing.result);
    else if (consumer) this.consumers.set(key, [...(this.consumers.get(key) ?? []), consumer]);
    if (!existing) this.items.set(key, { ...request, state: "pending" });
    this.notify(); this.pump();
  }
  private pump(): void {
    while (this.active < (this.options.concurrency ?? 2)) {
      const next = [...this.items.entries()].find(([, item]) => item.state === "pending");
      if (!next) break;
      void this.run(next[0], next[1]);
    }
    if (this.active === 0 && ![...this.items.values()].some((item) => item.state === "pending" || item.state === "running" || item.state === "retry-wait")) this.idleResolvers.splice(0).forEach((resolve) => resolve());
  }
  private async run(key: string, item: HashQueueItem): Promise<void> {
    this.active++; item.state = "running"; this.notify();
    const controller = this.controller;
    try {
      // Queue items acquire lifecycle fields while running; the API contract is
      // deliberately narrower and must never receive those scheduler fields.
      const result = await this.execute({ local_path: item.local_path, algorithm: item.algorithm }, controller.signal);
      if (!controller.signal.aborted) this.finish(key, result);
    }
    catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 429) {
        item.state = "retry-wait"; item.retryAt = Date.now() + (error.retryAfterMs ?? 1000) + (this.options.jitter?.() ?? Math.random() * 250); this.notify();
        const timer = setTimeout(() => {
          this.retryTimers.delete(key);
          if (!controller.signal.aborted && item.state === "retry-wait") { item.state = "pending"; this.notify(); this.pump(); }
        }, Math.max(0, item.retryAt - Date.now()));
        this.retryTimers.set(key, timer);
      } else this.finish(key, this.failure(item, "request_failed", error instanceof Error ? error.message : String(error), false));
    } finally { this.active--; this.notify(); this.pump(); }
  }
  private failure(request: HashRequest, code: string, detail: string, retryable: boolean): HashResult {
    return { local_path: request.local_path, algorithm: request.algorithm, profile: null, status: "failed", value: null, code, detail, error: { code, message: detail, retryable } };
  }
  private finish(key: string, result: HashResult): void {
    const item = this.items.get(key);
    if (!item) return;
    item.state = "final";
    item.result = result;
    try {
      this.consumers.get(key)?.forEach((consumer) => consumer(result));
    } finally {
      // Later enqueue() reads item.result directly; retaining prior closures is unnecessary.
      this.consumers.delete(key);
    }
  }
  whenIdle(): Promise<void> { return ![...this.items.values()].some((item) => item.state !== "final") && this.active === 0 ? Promise.resolve() : new Promise((resolve) => this.idleResolvers.push(resolve)); }
  abort(): void {
    this.controller.abort();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    // abort() disposes a UI lifecycle rather than terminally completing it.
    // Clearing both maps prevents its consumers or aborted result from being
    // reused when StrictMode immediately mounts the same queue again.
    this.items.clear();
    this.consumers.clear();
    this.controller = new AbortController();
    this.notify();
    this.pump();
  }
}
