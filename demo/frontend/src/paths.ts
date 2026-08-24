/**
 * Pure display helpers for logical paths and byte sizes. A logical path is
 * the flat, folder-expanded location of a local file; members of a
 * `.rfg.zip` container use the `container.rfg.zip!/entry/path` form.
 */

/** Split a logical path at the ZIP virtual-entry marker, if present. */
export function splitZipLogicalPath(
  logicalPath: string,
): { container: string; entry: string } | null {
  const marker = logicalPath.indexOf("!/");
  if (marker < 0) return null;
  const container = logicalPath.slice(0, marker);
  const entry = logicalPath.slice(marker + 2);
  // The marker itself is not sufficient: it may occur in an ordinary logical
  // filename. Catalog ZIP members always use a .rfg.zip container and a leaf.
  if (
    !container.toLowerCase().endsWith(".rfg.zip") ||
    entry === "" || entry.includes("\\") ||
    entry.split("/").some((part) => part === "" || part === "." || part === "..")
  ) return null;
  return { container, entry };
}

/** True only for the archive-member logical paths emitted by the catalog. */
export function isZipArchiveMemberPath(logicalPath: string): boolean {
  return splitZipLogicalPath(logicalPath) !== null;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)) - 1, units.length - 1);
  const value = size / 1024 ** (index + 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

/** Short HH:MM:SS clock for timestamps; falls back to the raw string. */
export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
}
