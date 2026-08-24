/**
 * The single full-outer-join workspace table: local source files on the
 * left, workspace virtual paths on the right. Paired rows fill both columns;
 * unmapped local files leave the virtual column empty; entries whose local
 * source is missing from the current catalog leave the local column empty
 * and are flagged 本地来源缺失. Row state is shown as glyph + text badge,
 * never by color alone; long editable values have a hover/focus full-value
 * preview and accessible name.
 */

import type { MappingEntry } from "../api";
import type { HashCache } from "../hashCache";
import { ROW_KIND_GLYPHS, ROW_KIND_LABELS, type WorkspaceRow } from "../join";
import {
  leafNameOfLogicalPath,
  validateVirtualPath,
} from "../mapping";
import { formatBytes } from "../paths";
import { CandidateHashChips, EntryHashChips } from "../react/HashChips";
import { LogicalPath } from "../react/LogicalPath";
import { MappingDetailsModal } from "../react/MappingDetailsModal";
import { ReviewableValueInput } from "../react/ReviewableValueInput";
import { useState } from "react";

const ROW_BADGE_CLASS: Record<WorkspaceRow["kind"], string> = {
  paired: "tag ok",
  local_only: "tag info",
  virtual_only: "tag warn",
};

const EMPTY_CELL_LABEL: Record<WorkspaceRow["kind"], string> = {
  paired: "—",
  local_only: "未创建虚拟路径",
  virtual_only: "当前目录未发现本地文件",
};

function RowBadge({ kind, title }: { readonly kind: WorkspaceRow["kind"]; readonly title?: string }) {
  return (
    <span className={`${ROW_BADGE_CLASS[kind]} row-badge`} title={title}>
      <span className="glyph" aria-hidden="true">
        {ROW_KIND_GLYPHS[kind]}
      </span>
      {ROW_KIND_LABELS[kind]}
    </span>
  );
}

interface WorkspaceTableProps {
  readonly rows: readonly WorkspaceRow[];
  readonly unfilteredCount: number;
  readonly selection: ReadonlySet<string>;
  readonly onToggleRow: (key: string, checked: boolean) => void;
  readonly onToggleAll: (checked: boolean) => void;
  readonly duplicateVirtualPaths: ReadonlySet<string>;
  readonly cache: HashCache;
  readonly catalogSizes: ReadonlyMap<string, number>;
  readonly onEditEntry: (entryIndex: number, patch: Partial<MappingEntry>) => void;
  readonly loading: boolean;
  readonly error: string | null;
}

export function WorkspaceTable({
  rows,
  unfilteredCount,
  selection,
  onToggleRow,
  onToggleAll,
  duplicateVirtualPaths,
  cache,
  catalogSizes,
  onEditEntry,
  loading,
  error,
}: WorkspaceTableProps) {
  const [reviewEntry, setReviewEntry] = useState<MappingEntry | null>(null);
  const allSelected = rows.length > 0 && rows.every((row) => selection.has(row.key));
  const someSelected = rows.some((row) => selection.has(row.key));

  return (
    <div className="join-table-wrap">
      <table className="join-table">
        <thead>
          <tr>
            <th scope="col" className="col-check">
              <input
                type="checkbox"
                aria-label="选择当前全部行"
                checked={allSelected}
                ref={(input) => {
                  if (input) input.indeterminate = !allSelected && someSelected;
                }}
                onChange={(event) => onToggleAll(event.target.checked)}
              />
            </th>
            <th scope="col" className="col-status">状态</th>
            <th scope="col" className="col-local">本地来源文件</th>
            <th scope="col" className="col-virtual">工作区虚拟路径</th>
            <th scope="col" className="col-size">大小</th>
            <th scope="col" className="col-hashes">哈希</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const entry = row.entry;
            const selected = selection.has(row.key);
            const recordedLocalMissing = row.kind === "virtual_only" && entry !== null;
            const virtualError =
              entry !== null
                ? validateVirtualPath(entry.virtual_path) ??
                  (duplicateVirtualPaths.has(entry.virtual_path) ? "虚拟路径重复" : null)
                : null;
            // The catalog is authoritative for rows whose local source exists.
            // A virtual-only draft retains its persisted size for re-matching.
            const sizeValue = row.local_path !== null
              ? catalogSizes.get(row.local_path) ?? entry?.size_bytes
              : entry?.size_bytes;
            return (
              <tr key={row.key} className={selected ? "selected" : undefined} data-kind={row.kind}>
                <td className="col-check">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.local_path ?? entry?.virtual_path ?? row.key}`}
                    checked={selected}
                    onChange={(event) => onToggleRow(row.key, event.target.checked)}
                  />
                </td>
                <td className="col-status">
                  <RowBadge
                    kind={row.kind}
                    title={
                      recordedLocalMissing && entry !== null
                        ? `记录的本地路径（当前目录缺失）：${entry.local_path}`
                        : undefined
                    }
                  />
                </td>
                <td className="col-local">
                  {row.local_path !== null ? (
                    <LogicalPath path={row.local_path} />
                  ) : (
                    <span
                      className="empty-cell"
                      title={entry ? `记录的本地路径：${entry.local_path}` : undefined}
                    >
                      <span aria-hidden="true">!</span>无本地文件
                    </span>
                  )}
                </td>
                <td className="col-virtual">
                  {entry !== null ? (
                    <span className="virtual-cell">
                       <ReviewableValueInput
                        id={`virtual-path-${row.entryIndex}`}
                        label="虚拟路径"
                        value={entry.virtual_path}
                        invalid={virtualError !== null}
                         onChange={(value) => onEditEntry(row.entryIndex, { virtual_path: value })}
                       />
                       <button type="button" className="btn-text mapping-review-action" onClick={() => setReviewEntry(entry)}>
                         查看完整映射
                       </button>
                      {recordedLocalMissing && entry !== null && (
                        <small className="muted lost-local" title="该条目记录的本地路径（当前目录缺失）">
                          原本地：{entry.local_path}
                        </small>
                      )}
                    </span>
                  ) : (
                    <span className="empty-cell"><span aria-hidden="true">○</span>{EMPTY_CELL_LABEL[row.kind]}</span>
                  )}
                </td>
                <td className="col-size">
                  {sizeValue != null ? (
                    formatBytes(sizeValue)
                  ) : (
                    <span className="empty-cell"><span aria-hidden="true">?</span>未记录</span>
                  )}
                </td>
                <td className="col-hashes">
                  {entry !== null ? (
                    <EntryHashChips entry={entry} />
                  ) : row.local_path !== null ? (
                    <CandidateHashChips localPath={row.local_path} cache={cache} />
                  ) : (
                    <span className="empty-cell"><span aria-hidden="true">?</span>无本地候选</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {loading && unfilteredCount === 0 && <p className="empty">正在载入本地目录与映射…</p>}
      {!loading && error !== null && <p className="inline-error">映射载入失败：{error}</p>}
      {!loading && error === null && unfilteredCount === 0 && (
        <p className="empty">
          工作区为空。点击「刷新本地目录」载入本地文件列表；也可以从页眉「导入
          JSON」载入已有映射。
        </p>
      )}
      {!loading && error === null && unfilteredCount > 0 && rows.length === 0 && (
        <p className="empty">当前过滤条件下没有行。</p>
      )}
      {reviewEntry !== null && (
        <MappingDetailsModal entry={reviewEntry} onClose={() => setReviewEntry(null)} />
      )}
    </div>
  );
}
