import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HealthResponse, RfgClient } from "../api";
import { useApiStatus } from "./useApiStatus";

const healthy: HealthResponse = { status: "ok", product: "RemappableFileGateway" };

function fakeClient(health: RfgClient["health"]): RfgClient {
  return {
    base: "", health, getMapping: vi.fn(), putMapping: vi.fn(), getLocalFiles: vi.fn(),
    hash: vi.fn(), resourceUrl: vi.fn(),
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

describe("useApiStatus", () => {
  afterEach(() => vi.useRealTimers());

  it("reports online and the product after the initial health check", async () => {
    vi.useFakeTimers();
    const health = vi.fn().mockResolvedValue(healthy);
    const client = fakeClient(health);
    const { result } = renderHook(() => useApiStatus(client));

    expect(result.current.status).toBe("checking");
    await flushPromises();
    expect(health).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ status: "online", product: healthy.product });
  });

  it("reports offline when a health check fails", async () => {
    vi.useFakeTimers();
    const client = fakeClient(vi.fn().mockRejectedValue(new Error("down")));
    const { result } = renderHook(() => useApiStatus(client));

    await flushPromises();
    expect(result.current).toMatchObject({ status: "offline", product: null });
  });

  it("sets checking for a manual recheck and applies its recovered result", async () => {
    vi.useFakeTimers();
    let resolveRecheck: (response: HealthResponse) => void;
    const pendingRecheck = new Promise<HealthResponse>((resolve) => { resolveRecheck = resolve; });
    const health = vi.fn().mockResolvedValueOnce(healthy).mockReturnValueOnce(pendingRecheck);
    const client = fakeClient(health);
    const { result } = renderHook(() => useApiStatus(client));
    await flushPromises();

    act(() => result.current.recheck());
    expect(result.current.status).toBe("checking");
    await act(async () => {
      resolveRecheck!({ status: "ok", product: "Recovered RFG" });
      await pendingRecheck;
    });
    expect(result.current).toMatchObject({ status: "online", product: "Recovered RFG" });
  });

  it("uses and aborts the current lifecycle signal for a manual recheck", async () => {
    vi.useFakeTimers();
    let recheckSignal: AbortSignal | undefined;
    const health = vi.fn()
      .mockResolvedValueOnce(healthy)
      .mockImplementationOnce((signal?: AbortSignal) => {
        recheckSignal = signal;
        return new Promise<HealthResponse>(() => {});
      });
    const client = fakeClient(health);
    const { result, unmount } = renderHook(() => useApiStatus(client));
    await flushPromises();
    const lifecycleSignal = health.mock.calls[0]?.[0] as AbortSignal;

    act(() => result.current.recheck());
    expect(recheckSignal).toBe(lifecycleSignal);
    expect(recheckSignal?.aborted).toBe(false);
    unmount();
    expect(recheckSignal?.aborted).toBe(true);
  });

  it("keeps a newer recheck result when an older health request finishes later", async () => {
    let rejectInitial!: (error: Error) => void;
    let resolveRecheck!: (response: HealthResponse) => void;
    const initial = new Promise<HealthResponse>((_resolve, reject) => {
      rejectInitial = reject;
    });
    const recheck = new Promise<HealthResponse>((resolve) => { resolveRecheck = resolve; });
    const health = vi.fn()
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(recheck)
      .mockResolvedValue(healthy);
    const client = fakeClient(health);
    const { result } = renderHook(() => useApiStatus(client));
    await waitFor(() => expect(health).toHaveBeenCalledOnce());

    act(() => result.current.recheck());
    resolveRecheck({ status: "ok", product: "Newer RFG" });
    await waitFor(() => expect(result.current).toMatchObject({ status: "online", product: "Newer RFG" }));
    rejectInitial(new Error("old request failed"));
    await waitFor(() => expect(result.current).toMatchObject({ status: "online", product: "Newer RFG" }));
  });

  it("does not turn an aborted health check into offline status", async () => {
    vi.useFakeTimers();
    const abortError = new DOMException("cancelled", "AbortError");
    const client = fakeClient(vi.fn().mockRejectedValue(abortError));
    const { result } = renderHook(() => useApiStatus(client));

    await flushPromises();
    expect(result.current).toMatchObject({ status: "checking", product: null });
  });

  it("aborts its request and clears its polling interval when unmounted", () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const health = vi.fn().mockImplementation((nextSignal?: AbortSignal) => {
      signal = nextSignal;
      return new Promise<HealthResponse>(() => {});
    });
    const client = fakeClient(health);
    const { unmount } = renderHook(() => useApiStatus(client));

    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
