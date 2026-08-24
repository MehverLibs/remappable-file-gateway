/**
 * Mapping-document draft helpers. The mapping document is frontend-owned;
 * the backend validates shape/path safety, enforces the virtual_path ↔
 * local_path one-to-one constraint, and persists atomically. A document is
 * just `{ entries: [...] }` — no schema marker, no entry ids, no enabled
 * flags, no source locator objects, no attributes, no revision.
 */

import type { HashAlgorithm, MappingDocument, MappingEntry } from "./api";

export const HASH_FIELDS: readonly HashAlgorithm[] = [
  "crc32",
  "md5",
  "sha256",
  "ahash",
  "dhash",
  "phash",
];

export const HASH_FIELD_LABELS: Record<HashAlgorithm, string> = {
  crc32: "CRC32",
  md5: "MD5",
  sha256: "SHA-256",
  ahash: "aHash",
  dhash: "dHash",
  phash: "pHash",
};

export function emptyMappingDocument(): MappingDocument {
  return { entries: [] };
}

/** The leaf filename of a local logical path (works across the `!/` boundary). */
export function leafNameOfLogicalPath(logicalPath: string): string {
  const slash = logicalPath.lastIndexOf("/");
  return slash < 0 ? logicalPath : logicalPath.slice(slash + 1);
}


/**
 * Split a filename into stem and extension (without the dot). A trailing or
 * leading dot does not make an extension: `"a.jpg"` → ("a", "jpg"),
 * `"archive.tar.gz"` → ("archive.tar", "gz"), `"README"` → ("README", ""),
 * `".gitignore"` → (".gitignore", "").
 */
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot + 1) };
}

/**
 * Client-side mirror of the backend safe-path rule for virtual paths.
 * Returns an error message, or null when the path is acceptable.
 */
export function validateVirtualPath(path: string): string | null {
  if (path === "") return "路径不能为空";
  if (path.includes("\0") || path.includes("\\")) return "路径不能包含 NUL 或反斜杠";
  if (path.startsWith("/")) return "路径必须是相对路径，不能以 / 开头";
  if (path.endsWith("/")) return "路径必须指向文件，不能以 / 结尾";
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") {
      return `路径包含不安全片段 ${part === "" ? "(空)" : part}`;
    }
  }
  return null;
}

/** Duplicate virtual/local paths inside a draft (saving would be rejected). */
export function duplicatePaths(entries: readonly MappingEntry[]): {
  virtualPaths: ReadonlySet<string>;
  localPaths: ReadonlySet<string>;
} {
  const seenVirtual = new Set<string>();
  const seenLocal = new Set<string>();
  const virtualPaths = new Set<string>();
  const localPaths = new Set<string>();
  for (const entry of entries) {
    if (seenVirtual.has(entry.virtual_path)) virtualPaths.add(entry.virtual_path);
    seenVirtual.add(entry.virtual_path);
    if (entry.local_path !== "") {
      if (seenLocal.has(entry.local_path)) localPaths.add(entry.local_path);
      seenLocal.add(entry.local_path);
    }
  }
  return { virtualPaths, localPaths };
}

/** Which hash values one entry currently carries (for table summaries). */
export function entryHashKeys(entry: MappingEntry): HashAlgorithm[] {
  return HASH_FIELDS.filter((field) => typeof entry[field] === "string" && entry[field] !== "");
}

/** Human/editable JSON form used by file export. */
export function serializeMapping(document: MappingDocument): string {
  return JSON.stringify(document, null, 2);
}

export type DraftParse =
  | { ok: true; document: MappingDocument }
  | { ok: false; error: string };

const ENTRY_FIELDS = ["virtual_path", "local_path", "size_bytes", ...HASH_FIELDS] as const;

function unknownFieldError(path: string, record: Record<string, unknown>, allowedFields: readonly string[]): string | null {
  const allowed = new Set<string>(allowedFields);
  const field = Object.keys(record).find((key) => !allowed.has(key));
  return field === undefined ? null : `${path} 包含未知字段 "${field}"`;
}

/**
 * Parse a current mapping document without changing its data. Detailed path
 * safety and field-value constraints remain enforced when the document is
 * saved by the backend.
 */
export function parseMappingDraft(text: string): DraftParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "映射文档必须是 JSON 对象" };
  }
  const document = value as Record<string, unknown>;
  const rootFieldError = unknownFieldError("根对象", document, ["entries"]);
  if (rootFieldError !== null) return { ok: false, error: rootFieldError };
  if (!Array.isArray(document.entries)) {
    return { ok: false, error: "映射文档必须包含 entries 数组" };
  }

  for (let index = 0; index < document.entries.length; index += 1) {
    const item = document.entries[index];
    const path = `entries[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${path} 必须是对象` };
    }
    const entry = item as Record<string, unknown>;
    const entryFieldError = unknownFieldError(path, entry, ENTRY_FIELDS);
    if (entryFieldError !== null) return { ok: false, error: entryFieldError };
    for (const field of ["virtual_path", "local_path"] as const) {
      if (!(field in entry)) return { ok: false, error: `${path}.缺少 ${field}` };
      if (typeof entry[field] !== "string") {
        return { ok: false, error: `${path}.${field} 必须是字符串` };
      }
    }
    if ("size_bytes" in entry && typeof entry.size_bytes !== "number" && entry.size_bytes !== null) {
      return { ok: false, error: `${path}.size_bytes 类型无效` };
    }
    for (const field of HASH_FIELDS) {
      if (field in entry && typeof entry[field] !== "string" && entry[field] !== null) {
        return { ok: false, error: `${path}.${field} 类型无效` };
      }
    }
  }

  return { ok: true, document: value as MappingDocument };
}
