import { useEffect, useMemo, useRef, useState } from "react";
import { HASH_ALGORITHMS, type HashAlgorithm, type LocalFile, type MappingEntry, type RfgClient } from "../api";
import { type HashCache } from "../hashCache";
import { HashQueue } from "../hashQueue";
import { createHashMergeConsumer } from "../hashResultMerge";
import { ROW_FILTER_LABELS, buildWorkspaceRows, countByKind, filterRows, type RowFilter } from "../join";
import { duplicatePaths } from "../mapping";
import { applyRematchValues, type CandidateInfo } from "../matching";
import { bindCurrentSourceFacts, missingZipMemberCrcRequests, sourceFactsByPath } from "../sourceCatalog";
import type { MappingDraft } from "../react/useMappingDraft";
import { BatchMapModal } from "./BatchMapModal";
import { RematchModal } from "./RematchModal";
import { WorkspaceTable } from "./WorkspaceTable";

interface Props { client: RfgClient; localFiles: readonly LocalFile[]; localLoading: boolean; draft: MappingDraft; onMessage: (message: string) => void; onNotice: (notice: { tone: "ok" | "warn" | "error"; text: string } | null) => void; }
const FILTERS: readonly RowFilter[] = ["all", "paired", "local_only", "virtual_only"];

export function MappingWorkspace({ client, localFiles, localLoading, draft, onMessage, onNotice }: Props) {
  const paths = useMemo(() => localFiles.map((file) => file.local_path), [localFiles]);
  const sourceFacts = useMemo(() => sourceFactsByPath(localFiles), [localFiles]);
  const sourceFactsRef = useRef(sourceFacts);
  sourceFactsRef.current = sourceFacts;
  const sizes = useMemo(() => new Map(localFiles.map((file) => [file.local_path, file.size_bytes])), [localFiles]);
  const queue = useRef(new HashQueue((request, signal) => client.hash(request, signal))).current;
  const [, redraw] = useState(0);
  const [cache, setCache] = useState<HashCache>(new Map());
  const [filter, setFilter] = useState<RowFilter>("all"); const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set()); const [picked, setPicked] = useState<ReadonlySet<HashAlgorithm>>(new Set(["md5", "sha256"]));
  const [batchOpen, setBatchOpen] = useState(false); const [rematch, setRematch] = useState<{ candidatePaths: string[]; entryIndexes: number[] } | null>(null);
  useEffect(() => { const unsubscribe = queue.subscribe(() => redraw((n) => n + 1)); return () => { unsubscribe(); queue.abort(); }; }, [queue]);
  const entries = draft.entries;
  const rows = useMemo(() => buildWorkspaceRows(paths, entries), [paths, entries]); const counts = useMemo(() => countByKind(rows), [rows]); const duplicates = useMemo(() => duplicatePaths(entries), [entries]);
  const visible = useMemo(() => { const needle = search.trim().toLowerCase(); return filterRows(rows, filter).filter((row) => !needle || (row.local_path ?? "").toLowerCase().includes(needle) || (row.entry?.virtual_path ?? "").toLowerCase().includes(needle)); }, [rows, filter, search]);
  const selected = rows.filter((row) => selection.has(row.key)); const localOnly = selected.filter((row) => row.kind === "local_only"); const virtualOnly = selected.filter((row) => row.kind === "virtual_only"); const withLocal = selected.filter((row) => row.local_path !== null);
  const updateCache = (result: import("../api").HashResult) => setCache((previous) => { const next = new Map(previous); const old = next.get(result.local_path) ?? { values: {}, failures: {} }; next.set(result.local_path, { ...old, values: result.status === "succeeded" ? { ...old.values, [result.algorithm]: result.value } : old.values, failures: result.status === "failed" ? { ...old.failures, [result.algorithm]: result.error.message } : old.failures }); return next; });
  const enqueue = (requests: readonly { local_path: string; algorithm: HashAlgorithm }[], merge: boolean) => requests.forEach((request) => {
    const mergeConsumer = merge ? createHashMergeConsumer(() => sourceFactsRef.current, draft.setEntries) : undefined;
    queue.enqueue(request, (result) => {
      updateCache(result);
      mergeConsumer?.(result);
      if (result.status === "failed") onNotice({ tone: "error", text: `哈希失败：${result.local_path} · ${result.algorithm} · ${result.code}：${result.detail}` });
    });
  });
  // Catalog supplies ordinary-file sizes. Only a ZIP member that lacks its
  // actual CRC32 creates an automatic hash request.
  useEffect(() => {
    const requests = missingZipMemberCrcRequests(entries, sourceFacts);
    if (requests.length) enqueue(requests, true);
  }, [entries, sizes]); // enqueue is intentionally stable over this render's queue/client
  const toggle = (key: string, checked: boolean) => setSelection((previous) => { const next = new Set(previous); checked ? next.add(key) : next.delete(key); return next; });
  const candidateInfo = (path: string): CandidateInfo => ({ local_path: path, size_bytes: sourceFacts.get(path)?.size_bytes, values: cache.get(path)?.values ?? {} });
  const queueItems = queue.snapshot(); const active = queueItems.filter((item) => item.state !== "final").length;
  return <section className="workspace card" aria-label="映射工作区">
    <div className="workspace-toolbar"><div className="filter-tabs">{FILTERS.map((value) => <button key={value} type="button" className={filter === value ? "tab active" : "tab"} onClick={() => setFilter(value)}>{ROW_FILTER_LABELS[value]} <span className="tab-count">{value === "all" ? rows.length : counts[value]}</span></button>)}</div><input className="workspace-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按路径过滤…" /><span className="muted">已选 {selection.size} 行</span></div>
    <div className="workspace-actions"><div className="action-group"><button type="button" className="btn" disabled={!localOnly.length} onClick={() => setBatchOpen(true)}>批量创建映射</button><button type="button" className="btn" disabled={!(localOnly.length === 1 && virtualOnly.length === 1)} onClick={() => { const local = localOnly[0]; const virtual = virtualOnly[0]; if (local.local_path && virtual.entry) { draft.setEntries((previous) => previous.map((entry, index) => index === virtual.entryIndex ? applyRematchValues(entry, candidateInfo(local.local_path!)) : entry)); onMessage("已重绑本地路径；使用目录当前大小和已有哈希结果。" ); } }}>连接选中</button><button type="button" className="btn" disabled={!selected.some((row) => row.entry)} onClick={() => draft.setEntries((previous) => previous.filter((_, index) => !selected.some((row) => row.entryIndex === index)))}>删除选中条目</button></div><div className="action-group"><span className="algo-picker">{HASH_ALGORITHMS.map((algorithm) => <label key={algorithm} className="check"><input type="checkbox" checked={picked.has(algorithm)} onChange={() => setPicked((previous) => { const next = new Set(previous); next.has(algorithm) ? next.delete(algorithm) : next.add(algorithm); return next; })}/>{algorithm}</label>)}</span><button type="button" className="btn" disabled={!withLocal.length || !picked.size} onClick={() => { enqueue(withLocal.flatMap((row) => [...picked].map((algorithm) => ({ local_path: row.local_path!, algorithm }))), true); onMessage("哈希请求已加入浏览器本地队列；相同路径和算法会合并。" ); }}>计算选中哈希</button><button type="button" className="btn" disabled={!localOnly.length || !virtualOnly.length} onClick={() => setRematch({ candidatePaths: localOnly.map((row) => row.local_path!).filter(Boolean), entryIndexes: virtualOnly.map((row) => row.entryIndex) })}>自动重新匹配…</button></div></div>
    <WorkspaceTable rows={visible} unfilteredCount={rows.length} selection={selection} onToggleRow={toggle} onToggleAll={(checked) => visible.forEach((row) => toggle(row.key, checked))} duplicateVirtualPaths={duplicates.virtualPaths} cache={cache} catalogSizes={sizes} onEditEntry={(index, patch) => draft.setEntries((previous) => previous.map((entry, at) => at === index ? { ...entry, ...patch } : entry))} loading={localLoading || draft.loading} error={draft.error} />
    {batchOpen && <BatchMapModal localPaths={localOnly.map((row) => row.local_path!).filter(Boolean)} existingVirtualPaths={new Set(entries.map((entry) => entry.virtual_path))} onConfirm={(created) => { draft.setEntries((previous) => [...previous, ...created.map((entry) => bindCurrentSourceFacts(entry, sourceFacts))]); setBatchOpen(false); }} onClose={() => setBatchOpen(false)} />}
    {rematch && <RematchModal candidates={rematch.candidatePaths.map(candidateInfo)} missingEntries={rematch.entryIndexes.map((index) => ({ entry: entries[index]!, entryIndex: index }))} pending={active > 0} onRequestHashes={(algorithms, requestedPaths) => enqueue(requestedPaths.flatMap((local_path) => algorithms.map((algorithm) => ({ local_path, algorithm }))), false)} onApply={(updates) => draft.setEntries((previous) => previous.map((entry, index) => updates.get(index) ? bindCurrentSourceFacts(updates.get(index)!, sourceFacts) : entry))} onClose={() => setRematch(null)} />}
  </section>;
}
