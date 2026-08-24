/**
 * Batch mapping creation for unmapped local files: one path pattern with
 * `<文件名>` / `<扩展名>` tokens (default `<文件名>.<扩展名>`), live preview,
 * and collision/legality reporting. Everything stays a frontend draft —
 * nothing is created until the workspace mapping is saved.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { MappingEntry } from "../api";
import {
  DEFAULT_PATTERN,
  EXTENSION_TOKEN,
  FILENAME_TOKEN,
  countExtensionless,
  previewPathPattern,
} from "../pattern";
import { LogicalPath } from "../react/LogicalPath";

const PREVIEW_LIMIT = 8;

interface BatchMapModalProps {
  /** Selected unmapped local logical paths. */
  readonly localPaths: readonly string[];
  /** Virtual paths already present in the draft (collision targets). */
  readonly existingVirtualPaths: ReadonlySet<string>;
  readonly onConfirm: (entries: MappingEntry[]) => void;
  readonly onClose: () => void;
}

export function BatchMapModal({ localPaths, existingVirtualPaths, onConfirm, onClose }: BatchMapModalProps) {
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const previews = useMemo(
    () => previewPathPattern(pattern, localPaths, existingVirtualPaths),
    [pattern, localPaths, existingVirtualPaths],
  );
  const errorCount = previews.filter((preview) => preview.error !== null).length;
  const creatable = previews.length - errorCount;
  const extensionlessCount = useMemo(() => countExtensionless(localPaths), [localPaths]);
  const extensionTokenIsEmpty = pattern.includes(EXTENSION_TOKEN) && extensionlessCount > 0;

  const insertToken = (token: string) => {
    const input = inputRef.current;
    if (!input) {
      setPattern((previous) => previous + token);
      return;
    }
    const start = input.selectionStart ?? pattern.length;
    const end = input.selectionEnd ?? pattern.length;
    const next = pattern.slice(0, start) + token + pattern.slice(end);
    setPattern(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const confirm = () => {
    if (errorCount > 0 || previews.length === 0) return;
    onConfirm(
      previews.map((preview) => ({
        virtual_path: preview.virtualPath,
        local_path: preview.localPath,
      })),
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-map-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="batch-map-title">批量创建映射</h2>
          <button type="button" className="btn" aria-label="关闭批量创建映射对话框" onClick={onClose}>
            关闭
          </button>
        </header>
        <p className="muted">
          为选中的 {localPaths.length} 个未映射本地文件统一生成工作区虚拟路径；生成结果先进入草稿，保存后生效。
        </p>
        <div className="pattern-editor" aria-label="虚拟路径生成表达式">
          <div className="pattern-editor-label">
            <strong>虚拟路径表达式</strong>
            <span className="muted">在光标处插入占位符</span>
          </div>
          <input
            ref={inputRef}
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            aria-label="路径表达式"
            spellCheck={false}
          />
          <div className="token-row" role="group" aria-label="插入路径占位符">
            <button type="button" className="btn" onClick={() => insertToken(FILENAME_TOKEN)}>
              插入 {FILENAME_TOKEN}
            </button>
            <button type="button" className="btn" onClick={() => insertToken(EXTENSION_TOKEN)}>
              插入 {EXTENSION_TOKEN}
            </button>
            <span className="muted">示例：dir/a-{FILENAME_TOKEN}.{EXTENSION_TOKEN}</span>
          </div>
          {extensionTokenIsEmpty && (
            <p className="muted warn-text" role="status">
              {EXTENSION_TOKEN} 对 {extensionlessCount} 个无扩展名文件会渲染为空；请以预览中的实际生成路径为准。
            </p>
          )}
        </div>
        <div className="preview-box" aria-live="polite">
          <p className={errorCount > 0 ? "preview-summary warn-text" : "preview-summary"}>
            预计创建 {creatable} 条映射
            {errorCount > 0 ? `；${errorCount} 条存在碰撞或非法路径` : ""}
          </p>
          <div className="preview-columns" aria-hidden="true">
            <span>本地来源文件</span><span>生成的虚拟路径</span>
          </div>
          <ul className="preview-list preview-path-list">
            {previews.slice(0, PREVIEW_LIMIT).map((preview) => (
              <li key={preview.localPath} className={preview.error !== null ? "bad" : ""}>
                <span className="preview-local"><LogicalPath path={preview.localPath} /></span>
                <code title={preview.virtualPath}>{preview.virtualPath || "(空路径)"}</code>
                {preview.error !== null && <span className="tag bad">{preview.error}</span>}
              </li>
            ))}
          </ul>
          {previews.length > PREVIEW_LIMIT && (
            <p className="muted">…以及另外 {previews.length - PREVIEW_LIMIT} 条。</p>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-accent"
            disabled={previews.length === 0 || errorCount > 0}
            title={errorCount > 0 ? "存在碰撞或非法路径，修正表达式后才能创建" : undefined}
            onClick={confirm}
          >
            创建 {creatable} 条映射
          </button>
        </footer>
      </div>
    </div>
  );
}
