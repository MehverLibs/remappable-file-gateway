/** Hash summaries for persisted mapping values and session-only candidate results. */

import type { MappingEntry } from "../api";
import { HASH_FIELD_LABELS, entryHashKeys } from "../mapping";
import type { HashCache } from "../hashCache";

export function EntryHashChips({ entry }: { readonly entry: MappingEntry }) {
  const keys = entryHashKeys(entry);
  if (keys.length === 0) return <span className="empty-cell"><span aria-hidden="true">?</span>未记录哈希</span>;
  return <span className="hash-chips">{keys.map((field) => <span key={field} className="tag ok" title={`${HASH_FIELD_LABELS[field]} = ${entry[field]}`}>{HASH_FIELD_LABELS[field]}</span>)}</span>;
}

export function CandidateHashChips({ localPath, cache }: { readonly localPath: string; readonly cache: HashCache }) {
  const cached = cache.get(localPath);
  if (!cached) return <span className="empty-cell"><span aria-hidden="true">?</span>尚未计算</span>;
  const succeeded = Object.keys(cached.values) as (keyof typeof cached.values)[];
  const failed = Object.keys(cached.failures) as (keyof typeof cached.failures)[];
  if (succeeded.length === 0 && failed.length === 0) return <span className="empty-cell"><span aria-hidden="true">?</span>未获得哈希</span>;
  return <span className="hash-chips">
    {succeeded.map((field) => <span key={field} className="tag cache" title={`临时 ${HASH_FIELD_LABELS[field]} = ${cached.values[field]}`}>{HASH_FIELD_LABELS[field]}</span>)}
    {failed.map((field) => <span key={field} className="tag bad" title={`${HASH_FIELD_LABELS[field]} 计算失败：${cached.failures[field]}`}>{HASH_FIELD_LABELS[field]}✕</span>)}
  </span>;
}
