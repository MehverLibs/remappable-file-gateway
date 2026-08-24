/**
 * The frontend-owned mapping draft.
 *
 * `GET /api/v1/meta/map` returns the raw document `{entries:[...]}`; there
 * is no revision. The backend supports an optional If-Match, but this hook
 * saves unconditionally: `PUT` replaces the whole document wholesale (the
 * backend validates shape, path safety, and the 1:1 virtual/local constraint).
 * This hook loads the document, tracks a mutable
 * draft plus a dirty flag, and saves through the client. A dirty draft is
 * never clobbered silently by a reload. A ref mirrors the draft so save()
 * always reads the latest entries synchronously.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { describeError, isAbortError, type MappingDocument, type MappingEntry, type RfgClient } from "../api";

function cloneEntries(entries: readonly MappingEntry[]): MappingEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export interface MappingDraft {
  /** Current draft entries (possibly unsaved). */
  readonly entries: MappingEntry[];
  /** True after any local edit that has not been saved or discarded. */
  readonly dirty: boolean;
  /** True while the very first load is in flight. */
  readonly loading: boolean;
  /** Last load/save failure text, if any. */
  readonly error: string | null;
  /** Replace the draft (marks it dirty). */
  setEntries(next: MappingEntry[] | ((previous: MappingEntry[]) => MappingEntry[])): void;
  /** Re-read the server document; a dirty draft is left untouched. */
  reload(signal?: AbortSignal): Promise<void>;
  /** Wholesale-save the draft; throws ApiError on rejection. */
  save(): Promise<MappingDocument>;
  /** Discard local edits and fall back to the server baseline, or the initial empty draft if none exists. */
  discard(): void;
}

export function useMappingDraft(client: RfgClient): MappingDraft {
  const [entries, setEntriesState] = useState<MappingEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Synchronous mirrors: updater functions are not guaranteed to run
  // synchronously, so save()/reload() must never read pending state.
  const entriesRef = useRef<MappingEntry[]>(entries);
  const dirtyRef = useRef(dirty);
  const editVersionRef = useRef(0);
  // The server baseline must be synchronous too: discard() can run before a
  // response-triggered render. Its generation invalidates older GET responses.
  const serverDocumentRef = useRef<MappingDocument | null>(null);
  const serverGenerationRef = useRef(0);
  const reloadRequestRef = useRef(0);

  const applyEntries = useCallback(
    (next: MappingEntry[] | ((previous: MappingEntry[]) => MappingEntry[])) => {
      const resolved = typeof next === "function" ? next(entriesRef.current) : next;
      entriesRef.current = resolved;
      dirtyRef.current = true;
      editVersionRef.current += 1;
      setEntriesState(resolved);
      setDirty(true);
    },
    [],
  );

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++reloadRequestRef.current;
      const generation = serverGenerationRef.current;
      try {
        const document = await client.getMapping(signal);
        // A newer reload or any intervening accepted save/reload owns the
        // baseline. This GET must not roll it back after a local save.
        if (request !== reloadRequestRef.current || generation !== serverGenerationRef.current) return;
        serverDocumentRef.current = document;
        serverGenerationRef.current += 1;
        setError(null);
        if (!dirtyRef.current) {
          entriesRef.current = cloneEntries(document.entries);
          setEntriesState(entriesRef.current);
        }
        // A dirty draft is never clobbered: local edits stay, and the fresh
        // server document is kept only for a later discard().
      } catch (loadError) {
        if (isAbortError(loadError)) return;
        if (request !== reloadRequestRef.current || generation !== serverGenerationRef.current) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  // Initial load.
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const save = useCallback(async (): Promise<MappingDocument> => {
    const editVersion = editVersionRef.current;
    const snapshot = cloneEntries(entriesRef.current);
    try {
      const saved = await client.putMapping({ entries: snapshot });
      serverDocumentRef.current = saved;
      serverGenerationRef.current += 1;
      // A later edit normally wins. If it was discarded while the save was in
      // flight, however, the now-confirmed response is the current baseline.
      if (editVersionRef.current === editVersion || !dirtyRef.current) {
        entriesRef.current = cloneEntries(saved.entries);
        dirtyRef.current = false;
        setEntriesState(entriesRef.current);
        setDirty(false);
      }
      setError(null);
      return saved;
    } catch (saveError) {
      setError(describeError(saveError));
      throw saveError;
    }
  }, [client]);

  const discard = useCallback(() => {
    if (serverDocumentRef.current !== null) {
      entriesRef.current = cloneEntries(serverDocumentRef.current.entries);
    } else {
      // A failed initial load has no server baseline. Discard must still
      // restore the hook's initial draft rather than leave edited entries
      // behind while marking them clean.
      entriesRef.current = [];
    }
    setEntriesState(entriesRef.current);
    dirtyRef.current = false;
    setDirty(false);
  }, []);

  return { entries, dirty, loading, error, setEntries: applyEntries, reload, save, discard };
}
