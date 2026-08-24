import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MappingDocument, RfgClient } from "../api";
import { useMappingDraft } from "./useMappingDraft";

const initialDocument: MappingDocument = {
  entries: [{ virtual_path: "server.txt", local_path: "source/server.txt" }],
};

function fakeClient(getMapping: RfgClient["getMapping"], putMapping: RfgClient["putMapping"]): RfgClient {
  return {
    base: "", getMapping, putMapping, health: vi.fn(), getLocalFiles: vi.fn(),
    hash: vi.fn(), resourceUrl: vi.fn(),
  };
}

describe("useMappingDraft", () => {
  it("loads the server mapping and finishes loading", async () => {
    const getMapping = vi.fn().mockResolvedValue(initialDocument);
    const client = fakeClient(getMapping, vi.fn());
    const { result } = renderHook(() => useMappingDraft(client));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getMapping).toHaveBeenCalledOnce();
    expect(result.current.entries).toEqual(initialDocument.entries);
    expect(result.current.dirty).toBe(false);
  });

  it("discards to the initial empty draft when the initial load fails", async () => {
    const failure = new Error("load failed");
    const client = fakeClient(vi.fn().mockRejectedValue(failure), vi.fn());
    const { result } = renderHook(() => useMappingDraft(client));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("load failed");
    });
    act(() => result.current.setEntries([{ virtual_path: "local.txt", local_path: "source/local.txt" }]));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.discard());

    expect(result.current.entries).toEqual([]);
    expect(result.current.dirty).toBe(false);
  });

  it("saves the complete local draft and clears dirty state on success", async () => {
    const putMapping = vi.fn().mockImplementation(async (document: MappingDocument) => document);
    const client = fakeClient(vi.fn().mockResolvedValue(initialDocument), putMapping);
    const { result } = renderHook(() => useMappingDraft(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const edited = { virtual_path: "edited.txt", local_path: "source/edited.txt" };
    act(() => result.current.setEntries([edited]));
    await act(async () => { await result.current.save(); });

    expect(putMapping).toHaveBeenCalledWith({ entries: [edited] });
    expect(result.current.entries).toEqual([edited]);
    expect(result.current.dirty).toBe(false);
  });

  it("preserves a dirty draft on reload but discard uses the latest server document", async () => {
    const latestDocument: MappingDocument = {
      entries: [{ virtual_path: "latest.txt", local_path: "source/latest.txt" }],
    };
    const getMapping = vi.fn().mockResolvedValueOnce(initialDocument).mockResolvedValueOnce(latestDocument);
    const client = fakeClient(getMapping, vi.fn());
    const { result } = renderHook(() => useMappingDraft(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const local = { virtual_path: "local.txt", local_path: "source/local.txt" };
    act(() => result.current.setEntries([local]));
    await act(async () => { await result.current.reload(); });

    expect(result.current.entries).toEqual([local]);
    expect(result.current.dirty).toBe(true);
    act(() => result.current.discard());
    expect(result.current.entries).toEqual(latestDocument.entries);
    expect(result.current.dirty).toBe(false);
  });

  it("keeps the draft dirty and rejects when saving fails", async () => {
    const failure = new Error("save failed");
    const putMapping = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(vi.fn().mockResolvedValue(initialDocument), putMapping);
    const { result } = renderHook(() => useMappingDraft(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setEntries([{ virtual_path: "local.txt", local_path: "source/local.txt" }]));

    await act(async () => {
      await expect(result.current.save()).rejects.toBe(failure);
    });
    expect(result.current.error).toBe("save failed");
    expect(result.current.dirty).toBe(true);
  });

  it("preserves edits made while save is in flight but discards to the saved response", async () => {
    let resolveSave!: (document: MappingDocument) => void;
    const pendingSave = new Promise<MappingDocument>((resolve) => { resolveSave = resolve; });
    const saved = { entries: [{ virtual_path: "saved.txt", local_path: "source/saved.txt" }] };
    const client = fakeClient(
      vi.fn().mockResolvedValue(initialDocument),
      vi.fn().mockReturnValue(pendingSave),
    );
    const { result } = renderHook(() => useMappingDraft(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstEdit = { virtual_path: "first.txt", local_path: "source/first.txt" };
    const newerEdit = { virtual_path: "newer.txt", local_path: "source/newer.txt" };

    act(() => result.current.setEntries([firstEdit]));
    let saveResult!: Promise<MappingDocument>;
    act(() => { saveResult = result.current.save(); });
    act(() => result.current.setEntries([newerEdit]));
    await act(async () => {
      resolveSave(saved);
      await expect(saveResult).resolves.toEqual(saved);
    });

    expect(result.current.entries).toEqual([newerEdit]);
    expect(result.current.dirty).toBe(true);
    act(() => result.current.discard());
    expect(result.current.entries).toEqual(saved.entries);
    expect(result.current.dirty).toBe(false);
  });

  it("uses the save response when edits made during save are discarded before it resolves", async () => {
    let resolveSave!: (document: MappingDocument) => void;
    const pendingSave = new Promise<MappingDocument>((resolve) => { resolveSave = resolve; });
    const saved = { entries: [{ virtual_path: "saved.txt", local_path: "source/saved.txt" }] };
    const client = fakeClient(
      vi.fn().mockResolvedValue(initialDocument),
      vi.fn().mockReturnValue(pendingSave),
    );
    const { result } = renderHook(() => useMappingDraft(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const saving = { virtual_path: "saving.txt", local_path: "source/saving.txt" };
    const later = { virtual_path: "later.txt", local_path: "source/later.txt" };

    act(() => result.current.setEntries([saving]));
    let saveResult!: Promise<MappingDocument>;
    act(() => { saveResult = result.current.save(); });
    act(() => result.current.setEntries([later]));
    act(() => result.current.discard());
    await act(async () => {
      resolveSave(saved);
      await expect(saveResult).resolves.toEqual(saved);
    });

    expect(result.current.entries).toEqual(saved.entries);
    expect(result.current.dirty).toBe(false);
  });

  it("does not let a reload started before a save overwrite the saved document", async () => {
    let resolveReload!: (document: MappingDocument) => void;
    const pendingReload = new Promise<MappingDocument>((resolve) => { resolveReload = resolve; });
    const saved = { entries: [{ virtual_path: "saved.txt", local_path: "source/saved.txt" }] };
    const getMapping = vi.fn().mockResolvedValueOnce(initialDocument).mockReturnValueOnce(pendingReload);
    const client = fakeClient(getMapping, vi.fn().mockResolvedValue(saved));
    const { result } = renderHook(() => useMappingDraft(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let reloadResult!: Promise<void>;
    act(() => { reloadResult = result.current.reload(); });
    act(() => result.current.setEntries(saved.entries));
    await act(async () => { await result.current.save(); });
    await act(async () => {
      resolveReload({ entries: [{ virtual_path: "stale.txt", local_path: "source/stale.txt" }] });
      await reloadResult;
    });

    expect(result.current.entries).toEqual(saved.entries);
    expect(result.current.dirty).toBe(false);
  });

  it("does not overwrite a draft when reload completes before its edit rerenders", async () => {
    let resolveReload: (document: MappingDocument) => void;
    const reload = new Promise<MappingDocument>((resolve) => { resolveReload = resolve; });
    const getMapping = vi.fn().mockResolvedValueOnce(initialDocument).mockReturnValueOnce(reload);
    const client = fakeClient(getMapping, vi.fn());
    const { result } = renderHook(() => useMappingDraft(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const local = { virtual_path: "local.txt", local_path: "source/local.txt" };
    const server = { entries: [{ virtual_path: "server-new.txt", local_path: "source/server-new.txt" }] };

    await act(async () => {
      result.current.setEntries([local]);
      const pendingReload = result.current.reload();
      resolveReload!(server);
      await pendingReload;
    });

    expect(result.current.entries).toEqual([local]);
    expect(result.current.dirty).toBe(true);
  });
});
