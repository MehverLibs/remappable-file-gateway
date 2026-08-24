/**
 * A local logical path with the `!/` archive boundary visually marked.
 * Long paths truncate with an ellipsis; the full value is always in `title`.
 */

import { splitZipLogicalPath } from "../paths";

export function LogicalPath({
  path,
  className = "pathcell",
}: {
  readonly path: string;
  readonly className?: string;
}) {
  const split = splitZipLogicalPath(path);
  if (split === null) {
    return (
      <span className={className} title={path}>
        {path}
      </span>
    );
  }
  return (
    <span className={className} title={path}>
      <span className="dir">{split.container}</span>
      <span className="zipmark">!/</span>
      {split.entry}
    </span>
  );
}
