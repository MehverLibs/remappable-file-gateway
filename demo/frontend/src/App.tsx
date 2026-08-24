/**
 * RemappableFileGateway mapping workspace.
 *
 * Header owns brand, API connectivity, local-catalog refresh, and mapping
 * save / import / export. The main area is the single full-outer-join table
 * (local catalog × mapping draft) plus a browser-local hash queue. All
 * edits live in a frontend draft; only 保存映射 (PUT /api/v1/meta/map)
 * persists anything.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  RFG_PRODUCT_NAME,
  browserApiCallLog,
  createRfgClient,
  describeError,
  isAbortError,
  resolveApiBase,
} from "./api";
import {
  parseMappingDraft,
  serializeMapping,
} from "./mapping";
import { useApiStatus } from "./react/useApiStatus";
import { useMappingDraft } from "./react/useMappingDraft";
import { MappingWorkspace } from "./components/MappingWorkspace";
import { ApiLogPanel } from "./components/ApiLogPanel";

type Notice = { tone: "ok" | "warn" | "error"; text: string };

const STATUS_PILL_LABELS = { checking: "API 检测中…", online: "API 在线", offline: "API 不可达" } as const;

export function App() {
  const apiLog = useMemo(() => browserApiCallLog, []);
  const client = useMemo(() => createRfgClient(resolveApiBase(window.location.search), apiLog), [apiLog]);
  const apiStatus = useApiStatus(client);
  const draft = useMappingDraft(client);
  const [localFiles, setLocalFiles] = useState<import("./api").LocalFile[] | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [message, setMessage] = useState(
    "就绪。刷新本地目录只读取本地文件列表，绝不修改映射文档。",
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);

  const refreshLocal = useCallback(
    async (signal?: AbortSignal) => {
      setLocalLoading(true);
      try {
        const files = await client.getLocalFiles(signal);
        setLocalFiles(files);
        setMessage(`本地目录已刷新：${files.length} 个本地文件（含当前目录大小）。`);
      } catch (error) {
        if (isAbortError(error)) return;
        setNotice({ tone: "error", text: `本地目录刷新失败：${describeError(error)}` });
      } finally {
        setLocalLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshLocal(controller.signal);
    return () => controller.abort();
  }, [refreshLocal]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const saved = await draft.save();
      setNotice({
        tone: "ok",
        text: `已保存 ${saved.entries.length} 条映射（PUT /api/v1/meta/map 整体替换），立即生效。`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: `保存失败：${describeError(error)}` });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    draft.discard();
    setNotice(null);
    setMessage("已放弃未保存的更改，恢复为服务器上的映射文档。");
  };

  const exportJson = () => {
    const blob = new Blob([serializeMapping({ entries: draft.entries })], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "rfg-mapping.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    void file.text().then((text) => {
      const parsed = parseMappingDraft(text);
      if (!parsed.ok) {
        setNotice({ tone: "error", text: `导入失败：${parsed.error}` });
        return;
      }
      draft.setEntries(parsed.document.entries);
      setNotice({
        tone: "ok",
        text: `已载入 ${parsed.document.entries.length} 条映射；保存后生效。`,
      });
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            RFG
          </span>
          <div className="brand-text">
            <h1>RemappableFileGateway</h1>
            <p className="brand-sub">映射工作台 · 完整面板</p>
          </div>
        </div>
        <div className="header-side">
          <button
            type="button"
            className={`status-pill ${apiStatus.status}`}
            onClick={apiStatus.recheck}
            title={`GET ${client.base}/api/v1/health（点击重新检测）`}
          >
            <span className="dot" aria-hidden="true" />
            {STATUS_PILL_LABELS[apiStatus.status]}
          </button>
          {apiStatus.product !== null && apiStatus.product !== RFG_PRODUCT_NAME && (
            <span className="tag warn" title="健康检查响应的 product 不是 RemappableFileGateway">
              未知服务：{apiStatus.product}
            </span>
          )}
          <div className="header-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void refreshLocal()}
              disabled={localLoading}
              title="GET /api/v1/meta/local（同时刷新后端目录）"
            >
              {localLoading ? "刷新中…" : "刷新本地目录"}
            </button>
            <label className="import-label">
              导入 JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) importJson(file);
                  event.target.value = "";
                }}
              />
            </label>
            <button type="button" className="btn" onClick={exportJson}>
              导出 JSON
            </button>
            <button type="button" className="btn" onClick={discard} disabled={!draft.dirty}>
              放弃更改
            </button>
            <button
              type="button"
              className="btn-accent"
              disabled={saving || !draft.dirty}
              title="PUT /api/v1/meta/map：以当前草稿整体替换服务器映射（无修订概念，保存即生效）"
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存映射"}
            </button>
          </div>
        </div>
      </header>

      {notice !== null && (
        <p className={`action-result ${notice.tone}`} role="status">
          <span>{notice.text}</span>
        </p>
      )}

      <main className="app-main">
        <MappingWorkspace
          client={client}
          localFiles={localFiles ?? []}
          localLoading={localLoading && localFiles === null}
          draft={draft}
          onMessage={setMessage}
          onNotice={setNotice}
        />
        <ApiLogPanel log={apiLog} />
      </main>

      <footer className="statusbar" role="status" aria-live="polite">
        {message}
      </footer>
    </div>
  );
}
