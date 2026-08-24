/**
 * A deliberate, always-invoked review surface for a mapping entry. Table
 * inputs remain compact editors; this dialog exposes the complete persisted
 * values without relying on clipping, hover, or focus tooltips.
 */

import { useEffect, useRef } from "react";

import type { MappingEntry } from "../api";
import { HASH_FIELDS, HASH_FIELD_LABELS } from "../mapping";
import { formatBytes } from "../paths";

interface MappingDetailsModalProps {
  readonly entry: MappingEntry;
  readonly onClose: () => void;
}

export function MappingDetailsModal({ entry, onClose }: MappingDetailsModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const hashes = HASH_FIELDS.filter((field) => {
    const value = entry[field];
    return typeof value === "string" && value !== "";
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <section
        className="modal mapping-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mapping-details-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="mapping-details-title">完整映射详情</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn"
            aria-label="关闭完整映射详情"
            onClick={onClose}
          >
            关闭详情
          </button>
        </header>
        <p className="muted">以下内容为当前映射草稿的完整值，可直接选择和复制后复核。</p>
        <dl className="mapping-details-list">
          <div>
            <dt>本地来源路径</dt>
            <dd><code>{entry.local_path || "（空）"}</code></dd>
          </div>
          <div>
            <dt>工作区虚拟路径</dt>
            <dd><code>{entry.virtual_path || "（空）"}</code></dd>
          </div>
          <div>
            <dt>文件大小</dt>
            <dd>{entry.size_bytes == null ? "未记录" : `${formatBytes(entry.size_bytes)}（${entry.size_bytes} B）`}</dd>
          </div>
          <div>
            <dt>校验值</dt>
            <dd>
              {hashes.length === 0 ? (
                "未记录哈希"
              ) : (
                <ul className="mapping-hash-list">
                  {hashes.map((field) => (
                    <li key={field}>
                      <strong>{HASH_FIELD_LABELS[field]}</strong>
                      <code>{entry[field] as string}</code>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>关闭详情</button>
        </footer>
      </section>
    </div>
  );
}
