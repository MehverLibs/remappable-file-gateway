import { useEffect, useState } from "react";

import type { ApiCallLog } from "../api";

interface Props { log: ApiCallLog; }

/** Live view of the browser-local RFG request history (resource URLs are not requests). */
export function ApiLogPanel({ log }: Props) {
  const [, redraw] = useState(0);
  useEffect(() => log.subscribe(() => redraw((version) => version + 1)), [log]);
  const entries = log.snapshot();
  return <aside className="api-log-panel card" aria-label="API 调用日志">
    <div className="api-log-heading">
      <div><h2>API 调用日志</h2><p className="muted">本浏览器会话 · {entries.length} 条</p></div>
      <button type="button" className="btn" onClick={() => log.clear()} disabled={entries.length === 0}>清空</button>
    </div>
    <ol className="api-log-list" aria-live="polite">
      {entries.length === 0 && <li className="api-log-empty">尚无 API 请求。</li>}
      {entries.map((entry) => <li key={entry.id} className={`api-log-entry ${entry.outcome}`}>
        <div className="api-log-meta"><time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</time><code>{entry.method}</code><code>{entry.route}</code></div>
        <div className="api-log-request">{entry.requestDescription}</div>
        <div className="api-log-result"><span>{entry.outcome === "pending" ? "进行中" : entry.status === null ? entry.outcome : `HTTP ${entry.status}`}</span><span>{entry.resultDescription}</span><span>{entry.outcome === "pending" ? "—" : `${entry.durationMs} ms`}</span></div>
      </li>)}
    </ol>
  </aside>;
}
