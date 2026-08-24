/**
 * API connectivity status via `GET /api/v1/health`. Checks on mount, on a
 * slow interval, and on demand (clicking the status pill). Background polls
 * never reset a settled status to "checking", so the pill does not flicker.
 * The reported product string is surfaced so a non-RFG service is visible
 * instead of silently trusted.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isAbortError, type RfgClient } from "../api";

export type ApiStatus = "checking" | "online" | "offline";

const STATUS_POLL_INTERVAL_MS = 30_000;

export interface ApiStatusState {
  readonly status: ApiStatus;
  /** `product` field from the last completed health response. */
  readonly product: string | null;
  readonly recheck: () => void;
}

export function useApiStatus(client: RfgClient): ApiStatusState {
  const [state, setState] = useState<{ status: ApiStatus; product: string | null }>({
    status: "checking",
    product: null,
  });
  const requestIdRef = useRef(0);
  const lifecycleControllerRef = useRef<AbortController | null>(null);

  const check = useCallback(
    (signal?: AbortSignal) => {
      const requestId = ++requestIdRef.current;
      client
        .health(signal)
        .then((body) => {
          if (!signal?.aborted && requestId === requestIdRef.current) {
            setState({ status: "online", product: body.product });
          }
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          if (!signal?.aborted && requestId === requestIdRef.current) {
            setState({ status: "offline", product: null });
          }
        });
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifecycleControllerRef.current = controller;
    check(controller.signal);
    const timer = window.setInterval(() => check(controller.signal), STATUS_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [check]);

  const recheck = useCallback(() => {
    setState((previous) => ({ ...previous, status: "checking" }));
    check(lifecycleControllerRef.current?.signal);
  }, [check]);

  return { ...state, recheck };
}
