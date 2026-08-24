import type { HashAlgorithm } from "./api";

/** Session-only hash results owned by the browser queue. */
export interface CachedHashes {
  values: Partial<Record<HashAlgorithm, string>>;
  failures: Partial<Record<HashAlgorithm, string>>;
}

export type HashCache = Map<string, CachedHashes>;
