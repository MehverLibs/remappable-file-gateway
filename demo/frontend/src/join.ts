/**
 * The full-outer-join workspace rows: one row per pairing between the
 * current local catalog (from `GET /api/v1/meta/local`) and the mapping
 * draft's virtual entries.
 *
 * - `paired`       — both columns filled: the entry's local_path is in the
 *                    current local catalog;
 * - `local_only`   — local column only: a local file no entry currently
 *                    claims;
 * - `virtual_only` — virtual column only: the entry's recorded local_path is
 *                    missing from the current catalog ("本地来源缺失").
 */

import type { MappingEntry } from "./api";

export type RowKind = "paired" | "local_only" | "virtual_only";

export type RowFilter = "all" | RowKind;

export interface WorkspaceRow {
  /** Stable React key: entry rows by draft index, local-only rows by path. */
  readonly key: string;
  readonly kind: RowKind;
  /** Current-catalog local logical path (paired / local_only rows). */
  readonly local_path: string | null;
  /** Draft entry reference (paired / virtual_only rows). */
  readonly entry: MappingEntry | null;
  /** Index into the draft entries array; -1 for local_only rows. */
  readonly entryIndex: number;
}

export const ROW_KIND_LABELS: Record<RowKind, string> = {
  paired: "已映射",
  local_only: "本地未映射",
  virtual_only: "本地来源缺失",
};

export const ROW_FILTER_LABELS: Record<RowFilter, string> = {
  all: "全部",
  paired: "已映射",
  local_only: "本地未映射",
  virtual_only: "本地缺失",
};

/** Distinct non-color glyphs for the three row states. */
export const ROW_KIND_GLYPHS: Record<RowKind, string> = {
  paired: "●",
  local_only: "○",
  virtual_only: "⚠",
};

const KIND_RANK: Record<RowKind, number> = { paired: 0, local_only: 1, virtual_only: 2 };

/**
 * Join the current local catalog paths with the draft entries. An entry
 * claims its local_path regardless of file existence; every catalog path
 * claimed by no entry becomes a local_only row, and every entry whose
 * local_path is not in the catalog becomes a virtual_only row.
 */
export function buildWorkspaceRows(
  localPaths: readonly string[],
  entries: readonly MappingEntry[],
): WorkspaceRow[] {
  const catalog = new Set(localPaths);
  const claimed = new Set<string>();
  const rows: WorkspaceRow[] = [];

  entries.forEach((entry, entryIndex) => {
    if (catalog.has(entry.local_path)) {
      claimed.add(entry.local_path);
      rows.push({
        key: `e:${entryIndex}`,
        kind: "paired",
        local_path: entry.local_path,
        entry,
        entryIndex,
      });
    } else {
      rows.push({
        key: `e:${entryIndex}`,
        kind: "virtual_only",
        local_path: null,
        entry,
        entryIndex,
      });
    }
  });
  for (const localPath of localPaths) {
    if (claimed.has(localPath)) continue;
    rows.push({ key: `l:${localPath}`, kind: "local_only", local_path: localPath, entry: null, entryIndex: -1 });
  }

  const sortPath = (row: WorkspaceRow): string => row.local_path ?? row.entry?.virtual_path ?? "";
  return rows.sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || sortPath(a).localeCompare(sortPath(b)),
  );
}

export function countByKind(rows: readonly WorkspaceRow[]): Record<RowKind, number> {
  const counts: Record<RowKind, number> = { paired: 0, local_only: 0, virtual_only: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}

export function filterRows(rows: readonly WorkspaceRow[], filter: RowFilter): WorkspaceRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => row.kind === filter);
}
