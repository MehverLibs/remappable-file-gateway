import type { LocalFile, MappingEntry } from "./api";
import { isZipArchiveMemberPath } from "./paths";

/** Current non-hash facts reported by GET /api/v1/meta/local. */
export type SourceFacts = ReadonlyMap<string, LocalFile>;

export function sourceFactsByPath(files: readonly LocalFile[]): SourceFacts {
  return new Map(files.map((file) => [file.local_path, file]));
}

/** Attach the current catalog size when a local source is newly bound or rebound. */
export function bindCurrentSourceFacts(entry: MappingEntry, facts: SourceFacts): MappingEntry {
  const source = facts.get(entry.local_path);
  return source ? { ...entry, size_bytes: source.size_bytes } : entry;
}

/** Automatic CRC work is limited to ZIP members; source sizes are never hashes. */
export function missingZipMemberCrcRequests(entries: readonly MappingEntry[], facts: SourceFacts) {
  return entries
    .filter((entry) => isZipArchiveMemberPath(entry.local_path) && facts.has(entry.local_path) && !entry.crc32)
    .map((entry) => ({ local_path: entry.local_path, algorithm: "crc32" as const }));
}
