/**
 * Automatic re-matching: a boolean expression builder (AND / OR / NOT over
 * 文件大小, CRC32, MD5, SHA256, aHash, dHash, pHash) evaluated
 * between unmapped local candidates and virtual entries whose local source
 * is missing. Only bidirectionally unique matches are auto-accepted;
 * ambiguous pairs are listed for a human and never silently bound. Preview
 * first, confirm to write the draft.
 */

import { useEffect, useMemo, useState } from "react";

import type { HashAlgorithm, MappingEntry } from "../api";
import {
  MATCH_FIELDS,
  MATCH_FIELD_LABELS,
  autoRematch,
  buildRematchUpdates,
  requiredAlgorithms,
  requiresSize,
  type CandidateInfo,
  type Connector,
  type MatchPredicate,
  type RematchOutcome,
} from "../matching";

interface RematchModalProps {
  /** Selected unmapped local files with their session-cached values. */
  readonly candidates: readonly CandidateInfo[];
  /** Selected virtual entries whose local source is missing. */
  readonly missingEntries: readonly { entry: MappingEntry; entryIndex: number }[];
  /** True while a candidate hash request is in flight. */
  readonly pending: boolean;
  readonly onRequestHashes: (algorithms: HashAlgorithm[], localPaths: string[]) => void;
  readonly onApply: (updates: ReadonlyMap<number, MappingEntry>) => void;
  readonly onClose: () => void;
}

const FIRST_PREDICATE: MatchPredicate = { connector: "AND", negate: false, field: "md5" };

export function RematchModal({
  candidates,
  missingEntries,
  pending,
  onRequestHashes,
  onApply,
  onClose,
}: RematchModalProps) {
  const [predicates, setPredicates] = useState<MatchPredicate[]>([FIRST_PREDICATE]);
  const [outcome, setOutcome] = useState<RematchOutcome | null>(null);
  const [outcomeInputKey, setOutcomeInputKey] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A review is valid only for the exact expression, candidates, and missing
  // entries it evaluated. Refreshed hashes or selection changes require a
  // fresh review before anything can be applied.
  const inputKey = useMemo(
    () => JSON.stringify({ predicates, candidates, missingEntries }),
    [predicates, candidates, missingEntries],
  );
  useEffect(() => {
    setOutcome(null);
    setOutcomeInputKey(null);
  }, [inputKey]);

  const hashAlgorithms = useMemo(() => requiredAlgorithms(predicates), [predicates]);
  const needSize = requiresSize(predicates);
  // Size is supplied by the catalog; a hash request is needed only for hashes.
  const neededAlgorithms: HashAlgorithm[] =
    hashAlgorithms;
  const missingPaths = useMemo(
    () =>
      candidates
        .filter(
          (candidate) =>
            hashAlgorithms.some((algorithm) => candidate.values[algorithm] === undefined) ||
            (needSize && candidate.size_bytes === undefined),
        )
        .map((candidate) => candidate.local_path),
    [candidates, hashAlgorithms, needSize],
  );

  const updatePredicate = (index: number, patch: Partial<MatchPredicate>) => {
    setPredicates((previous) =>
      previous.map((predicate, at) => (at === index ? { ...predicate, ...patch } : predicate)),
    );
  };

  const removePredicate = (index: number) => {
    setPredicates((previous) => previous.filter((_, at) => at !== index));
  };

  const addPredicate = () => {
    setPredicates((previous) => [...previous, { connector: "AND", negate: false, field: "md5" }]);
  };

  const run = () => {
    const result = autoRematch(predicates, candidates, missingEntries);
    setOutcome(result);
    setOutcomeInputKey(inputKey);
  };

  const applyReviewedMatches = () => {
    if (outcome === null || outcomeInputKey !== inputKey) return;
    const updates = buildRematchUpdates(outcome, candidates, missingEntries);
    if (updates.size > 0) onApply(updates);
  };

  const virtualPathOf = (entryIndex: number): string =>
    missingEntries.find((item) => item.entryIndex === entryIndex)?.entry.virtual_path ??
    `#${entryIndex}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rematch-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="rematch-title">自动重新匹配</h2>
          <button type="button" className="btn" aria-label="关闭自动重新匹配对话框" onClick={onClose}>
            关闭
          </button>
        </header>
        <p className="muted">
          在 {candidates.length} 个本地未映射文件与 {missingEntries.length}
          个本地来源缺失的虚拟条目之间按表达式精确匹配；只有一对一且双向唯一的结果会被自动接受，歧义结果只列出、不绑定。
        </p>

        <div className="expr-builder" aria-label="匹配表达式">
          {predicates.map((predicate, index) => (
            <div key={index} className="expr-row">
              {index === 0 ? (
                <span className="expr-connector muted">当</span>
              ) : (
                <select
                  className="expr-connector"
                  value={predicate.connector}
                  aria-label={`第 ${index + 1} 条连接符`}
                  onChange={(event) =>
                    updatePredicate(index, { connector: event.target.value as Connector })
                  }
                >
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
              )}
              <label className="check expr-not">
                <input
                  type="checkbox"
                  checked={predicate.negate}
                  onChange={(event) => updatePredicate(index, { negate: event.target.checked })}
                />
                NOT
              </label>
              <div className="expr-comparison">
                <select
                  value={predicate.field}
                  aria-label={`第 ${index + 1} 条字段`}
                  onChange={(event) =>
                    updatePredicate(index, { field: event.target.value as MatchPredicate["field"] })
                  }
                >
                  {MATCH_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {MATCH_FIELD_LABELS[field]}
                    </option>
                  ))}
                </select>
                <span className="expr-equals">本地候选值 = 虚拟文件记录值</span>
              </div>
              <button
                type="button"
                className="btn-text"
                aria-label={`删除第 ${index + 1} 条匹配条件`}
                title="删除此匹配条件"
                onClick={() => removePredicate(index)}
              >
                ✕
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn" onClick={addPredicate}>
              + 添加条件
            </button>
          </div>
        </div>
        <p className="muted expression-note">
          任一配对缺少表达式所需字段时直接不参与（NOT 也不会把缺值当作真）。
        </p>

        <div className="rematch-steps" aria-label="自动重新匹配步骤">
          <button
            type="button"
            className="btn"
            disabled={pending || missingPaths.length === 0 || neededAlgorithms.length === 0}
            title={
              neededAlgorithms.length === 0
                ? "表达式只读取目录大小，无需计算"
                : missingPaths.length === 0
                  ? "所需候选哈希已全部缓存"
                  : `对 ${missingPaths.length} 个候选计算 ${neededAlgorithms.join("、")}`
            }
            onClick={() => onRequestHashes(neededAlgorithms, missingPaths)}
          >
            {pending
              ? "候选哈希计算中…"
              : missingPaths.length > 0
                ? `① 计算候选缺失哈希（${missingPaths.length} 个文件）`
                : "① 候选哈希已就绪"}
          </button>
          <button
            type="button"
            className="btn-accent"
            disabled={pending || predicates.length === 0}
            title={pending ? "等待候选哈希计算完成" : undefined}
            onClick={run}
          >
            ② 评估双向唯一匹配
          </button>
          <span className="step-assurance">歧义结果会保留给人工处理，不会绑定</span>
        </div>
        {neededAlgorithms.length > 0 && missingPaths.length > 0 && (
          <p className="muted">
            将对 {missingPaths.length} 个候选计算：{neededAlgorithms.join("、")}
            ；非图片文件请求图片哈希会以 unsupported_image 明确失败。
          </p>
        )}

        {outcome !== null && (
          <div className="rematch-result" aria-live="polite">
            <p className="preview-summary">
              可应用 {outcome.accepted.length} 对双向唯一匹配；歧义 {outcome.ambiguous.length} 对（未绑定）。
            </p>
            {outcome.accepted.length > 0 && (
              <ul className="preview-list">
                {outcome.accepted.map((pair) => (
                  <li key={`${pair.local_path}->${pair.entryIndex}`}>
                    <code className="preview-local">{pair.local_path}</code>
                    <span className="preview-arrow">→</span>
                    <code>{virtualPathOf(pair.entryIndex)}</code>
                    <span className="tag ok">待确认写入草稿</span>
                  </li>
                ))}
              </ul>
            )}
            {outcome.ambiguous.length > 0 && (
              <ul className="preview-list">
                {outcome.ambiguous.map((pair) => (
                  <li key={`${pair.local_path}~>${pair.entryIndex}`} className="bad">
                    <code className="preview-local">{pair.local_path}</code>
                    <span className="preview-arrow">↔</span>
                    <code>{virtualPathOf(pair.entryIndex)}</code>
                    <span className="tag warn">
                      歧义：
                      {pair.candidateMatches > 1 ? `候选匹配 ${pair.candidateMatches} 个条目` : ""}
                      {pair.candidateMatches > 1 && pair.entryMatches > 1 ? "；" : ""}
                      {pair.entryMatches > 1 ? `条目被 ${pair.entryMatches} 个候选匹配` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          {outcome !== null && outcomeInputKey === inputKey && outcome.accepted.length > 0 && (
            <button
              type="button"
              className="btn-accent"
              onClick={applyReviewedMatches}
              title="写入会覆盖本地路径及所有可用的候选哈希"
            >
              确认应用 {outcome.accepted.length} 对唯一匹配
            </button>
          )}
        </footer>
        {outcome !== null && outcomeInputKey === inputKey && outcome.accepted.length > 0 && (
          <p className="muted">
            确认后将覆盖这些条目的 local_path 和全部可用候选哈希；在确认前草稿不会被修改。
          </p>
        )}
      </div>
    </div>
  );
}
