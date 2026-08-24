/**
 * Batch-mapping path patterns: a `<文件名>.<扩展名>` template rendered per
 * selected local file into a new virtual path. Tokens may be mixed with
 * literal prefixes/suffixes and folder prefixes, e.g.
 * `dir/a-<文件名>.<扩展名>`. Rendering and validation are pure frontend
 * work — the generated entries only become real when the mapping draft is
 * saved.
 */

import { leafNameOfLogicalPath, splitFileName, validateVirtualPath } from "./mapping";

export const FILENAME_TOKEN = "<文件名>";
export const EXTENSION_TOKEN = "<扩展名>";
export const DEFAULT_PATTERN = `${FILENAME_TOKEN}.${EXTENSION_TOKEN}`;

/**
 * Render one local logical path through the pattern. The tokens are the
 * file's stem and extension; when the file has no extension, a literal
 * `.<扩展名>` collapses cleanly (no dangling dot) and a bare `<扩展名>`
 * renders empty.
 */
export function renderPathPattern(pattern: string, localPath: string): string {
  const { stem, extension } = splitFileName(leafNameOfLogicalPath(localPath));
  // A file without an extension collapses a literal `.<扩展名>` cleanly.
  const prepared = extension === "" ? pattern.replaceAll(`.${EXTENSION_TOKEN}`, "") : pattern;
  // Single pass: substituted file names are never rescanned for tokens.
  return prepared.replace(/<文件名>|<扩展名>/g, (token) =>
    token === FILENAME_TOKEN ? stem : extension,
  );
}

export interface PatternPreview {
  readonly localPath: string;
  readonly virtualPath: string;
  readonly error: string | null;
}

/**
 * Preview one pattern against many local paths: per-row path-safety errors,
 * collisions inside the batch, and collisions against existing virtual
 * paths are all reported (never silently skipped).
 */
export function previewPathPattern(
  pattern: string,
  localPaths: readonly string[],
  existingVirtualPaths: ReadonlySet<string> = new Set(),
): PatternPreview[] {
  const previews = localPaths.map((localPath) => {
    const virtualPath = renderPathPattern(pattern, localPath);
    return { localPath, virtualPath, error: validateVirtualPath(virtualPath) };
  });
  const occurrences = new Map<string, number>();
  for (const preview of previews) {
    occurrences.set(preview.virtualPath, (occurrences.get(preview.virtualPath) ?? 0) + 1);
  }
  return previews.map((preview) => {
    if (preview.error !== null) return preview;
    if ((occurrences.get(preview.virtualPath) ?? 0) > 1) {
      return { ...preview, error: "碰撞：多个本地文件生成了相同的虚拟路径" };
    }
    if (existingVirtualPaths.has(preview.virtualPath)) {
      return { ...preview, error: "碰撞：该虚拟路径已存在于映射中" };
    }
    return preview;
  });
}

/** How many of the given local paths have no filename extension. */
export function countExtensionless(localPaths: readonly string[]): number {
  return localPaths.filter((path) => splitFileName(leafNameOfLogicalPath(path)).extension === "")
    .length;
}
