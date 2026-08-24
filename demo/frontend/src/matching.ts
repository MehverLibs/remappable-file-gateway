/**
 * Frontend-owned re-matching aid. The backend exposes NO matching endpoint:
 * candidates are local files whose recorded mapping entry lost its local
 * source, and expressions compare each candidate's transient computed values
 * against each virtual entry's persisted values with exact equality.
 *
 * Semantics that matter:
 *
 * - Every predicate is candidate-value === entry-value for one field.
 * - A pair where EITHER side lacks a predicate's field does not participate:
 *   the predicate is neither true nor false, and NOT never turns a missing
 *   value into a truth. A pair can match only when the whole expression
 *   evaluates to true.
 * - Only bidirectionally unique candidate↔entry matches are auto-accepted;
 *   everything else is reported as ambiguous and left for a human.
 * - A completed re-match overwrites the entry's local_path and copies every
 *   candidate value (size and all
 *   computed hashes), not just the fields the expression used.
 */

import type { HashAlgorithm, MappingEntry } from "./api";

export type MatchField =
  | "size_bytes"
  | "crc32"
  | "md5"
  | "sha256"
  | "ahash"
  | "dhash"
  | "phash";

export const MATCH_FIELDS: readonly MatchField[] = [
  "size_bytes",
  "crc32",
  "md5",
  "sha256",
  "ahash",
  "dhash",
  "phash",
];

export const MATCH_FIELD_LABELS: Record<MatchField, string> = {
  size_bytes: "文件大小",
  crc32: "CRC32",
  md5: "MD5",
  sha256: "SHA-256",
  ahash: "aHash",
  dhash: "dHash",
  phash: "pHash",
};

export type Connector = "AND" | "OR";

export interface MatchPredicate {
  /** How this predicate chains onto the previous one; ignored on the first. */
  connector: Connector;
  /** NOT: invert the comparison; missing values stay non-true either way. */
  negate: boolean;
  field: MatchField;
}

/** Hash algorithms an expression needs computed for its candidates. */
export function requiredAlgorithms(predicates: readonly MatchPredicate[]): HashAlgorithm[] {
  const needed = new Set<HashAlgorithm>();
  for (const predicate of predicates) {
    if (
      predicate.field === "crc32" ||
      predicate.field === "md5" ||
      predicate.field === "sha256" ||
      predicate.field === "ahash" ||
      predicate.field === "dhash" ||
      predicate.field === "phash"
    ) {
      needed.add(predicate.field);
    }
  }
  return [...needed];
}

/** True when the expression reads size_bytes (which arrives with any item). */
export function requiresSize(predicates: readonly MatchPredicate[]): boolean {
  return predicates.some((predicate) => predicate.field === "size_bytes");
}

/**
 * One local candidate's transient knowledge: whatever hash requests
 * already returned for this local path in this session. Missing fields are
 * simply absent — never fabricated.
 */
export interface CandidateInfo {
  readonly local_path: string;
  readonly size_bytes?: number;
  readonly values: Partial<Record<HashAlgorithm, string>>;
}

function normalized(value: string | number, field: MatchField): string | number {
  if (typeof value === "string") return value.toLowerCase();
  return value;
}

function candidateValue(candidate: CandidateInfo, field: MatchField): string | number | null {
  if (field === "size_bytes") return candidate.size_bytes ?? null;
  return candidate.values[field] ?? null;
}

function entryValue(entry: MappingEntry, field: MatchField): string | number | null {
  if (field === "size_bytes") return entry.size_bytes ?? null;
  const value = entry[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Three-valued predicate: null when either side lacks the field. */
function predicateState(
  predicate: MatchPredicate,
  candidate: CandidateInfo,
  entry: MappingEntry,
): boolean | null {
  const left = candidateValue(candidate, predicate.field);
  const right = entryValue(entry, predicate.field);
  if (left === null || right === null) return null;
  const equal = normalized(left, predicate.field) === normalized(right, predicate.field);
  return predicate.negate ? !equal : equal;
}

/**
 * Evaluate the whole predicate chain left-to-right in three-valued logic:
 * AND is false-dominant, OR is true-dominant, and unknown propagates
 * otherwise. Only a definitive TRUE matches — a pair that cannot fully
 * evaluate does not participate.
 */
export function evaluateExpression(
  predicates: readonly MatchPredicate[],
  candidate: CandidateInfo,
  entry: MappingEntry,
): boolean {
  if (predicates.length === 0) return false;
  let acc: boolean | null = null;
  for (let index = 0; index < predicates.length; index += 1) {
    const predicate = predicates[index];
    const value = predicateState(predicate, candidate, entry);
    if (index === 0) {
      acc = value;
    } else if (predicate.connector === "AND") {
      acc = acc === false || value === false ? false : acc === null || value === null ? null : true;
    } else {
      acc = acc === true || value === true ? true : acc === null || value === null ? null : false;
    }
  }
  return acc === true;
}

export interface RematchPair {
  readonly local_path: string;
  readonly entryIndex: number;
}

export interface AmbiguousPair extends RematchPair {
  /** How many entries this candidate matched (always ≥ 1). */
  readonly candidateMatches: number;
  /** How many candidates matched this entry (always ≥ 1). */
  readonly entryMatches: number;
}

export interface RematchOutcome {
  /** Bidirectionally unique matches, safe to apply automatically. */
  readonly accepted: readonly RematchPair[];
  /** Matches that are not one-to-one; a human must resolve these. */
  readonly ambiguous: readonly AmbiguousPair[];
}

/**
 * Match every candidate against every missing-local entry and keep only the
 * bidirectionally unique pairs: the candidate matches exactly one entry AND
 * no other candidate matches that entry.
 */
export function autoRematch(
  predicates: readonly MatchPredicate[],
  candidates: readonly CandidateInfo[],
  entries: readonly { entry: MappingEntry; entryIndex: number }[],
): RematchOutcome {
  const matchesByCandidate = new Map<string, number[]>();
  const matchesByEntry = new Map<number, string[]>();
  for (const candidate of candidates) {
    for (const { entry, entryIndex } of entries) {
      if (!evaluateExpression(predicates, candidate, entry)) continue;
      matchesByCandidate.set(candidate.local_path, [
        ...(matchesByCandidate.get(candidate.local_path) ?? []),
        entryIndex,
      ]);
      matchesByEntry.set(entryIndex, [
        ...(matchesByEntry.get(entryIndex) ?? []),
        candidate.local_path,
      ]);
    }
  }
  const accepted: RematchPair[] = [];
  const ambiguous: AmbiguousPair[] = [];
  for (const [localPath, entryIndexes] of matchesByCandidate) {
    for (const entryIndex of entryIndexes) {
      const candidateMatches = entryIndexes.length;
      const entryMatches = (matchesByEntry.get(entryIndex) ?? []).length;
      if (candidateMatches === 1 && entryMatches === 1) {
        accepted.push({ local_path: localPath, entryIndex });
      } else {
        ambiguous.push({ local_path: localPath, entryIndex, candidateMatches, entryMatches });
      }
    }
  }
  return { accepted, ambiguous };
}

/**
 * Apply a re-match: re-attach the local path and copy every computed hash
 * over the entry's persisted hashes. Candidate-missing
 * fields keep the entry's previous values untouched.
 */
export function applyRematchValues(entry: MappingEntry, candidate: CandidateInfo): MappingEntry {
  const next: MappingEntry = {
    ...entry,
    local_path: candidate.local_path,
  };
  if (candidate.size_bytes !== undefined) next.size_bytes = candidate.size_bytes;
  for (const [algorithm, value] of Object.entries(candidate.values)) {
    if (typeof value === "string" && value !== "") {
      next[algorithm as HashAlgorithm] = value;
    }
  }
  return next;
}

/**
 * Turn a REVIEWED outcome into draft updates: only bidirectionally unique
 * (accepted) pairs are converted — ambiguous pairs never produce updates.
 * Callers must ensure the outcome was computed from exactly these candidates
 * and entries (preview-then-confirm).
 */
export function buildRematchUpdates(
  outcome: RematchOutcome,
  candidates: readonly CandidateInfo[],
  missingEntries: readonly { entry: MappingEntry; entryIndex: number }[],
): Map<number, MappingEntry> {
  const updates = new Map<number, MappingEntry>();
  for (const pair of outcome.accepted) {
    const candidate = candidates.find((item) => item.local_path === pair.local_path);
    const target = missingEntries.find((item) => item.entryIndex === pair.entryIndex);
    if (candidate && target) {
      updates.set(pair.entryIndex, applyRematchValues(target.entry, candidate));
    }
  }
  return updates;
}
