import { describe, expect, it } from "vitest";

import type { MappingEntry } from "./api";
import { buildWorkspaceRows, countByKind, filterRows } from "./join";

function entry(virtualPath: string, localPath: string): MappingEntry {
  return {
    virtual_path: virtualPath,
    local_path: localPath,
  };
}

describe("buildWorkspaceRows full outer join", () => {
  it("pairs entries with catalog local paths and keeps both unmatched sides", () => {
    const rows = buildWorkspaceRows(
      ["source/a.jpg", "source/unmapped.txt", "pack.rfg.zip!/x.bin"],
      [entry("dir/a-a.jpg", "source/a.jpg"), entry("v/gone.txt", "source/gone.txt")],
    );
    const byKind = {
      paired: rows.filter((row) => row.kind === "paired"),
      local_only: rows.filter((row) => row.kind === "local_only"),
      virtual_only: rows.filter((row) => row.kind === "virtual_only"),
    };
    // Paired: both columns filled.
    expect(byKind.paired).toHaveLength(1);
    expect(byKind.paired[0]?.local_path).toBe("source/a.jpg");
    expect(byKind.paired[0]?.entry?.virtual_path).toBe("dir/a-a.jpg");
    // Local unmapped: local column only, including the archive member.
    expect(new Set(byKind.local_only.map((row) => row.local_path))).toEqual(
      new Set(["source/unmapped.txt", "pack.rfg.zip!/x.bin"]),
    );
    expect(byKind.local_only.every((row) => row.entry === null)).toBe(true);
    // Missing local source: virtual column only.
    expect(byKind.virtual_only).toHaveLength(1);
    expect(byKind.virtual_only[0]?.local_path).toBeNull();
    expect(byKind.virtual_only[0]?.entry?.virtual_path).toBe("v/gone.txt");
  });

  it("keeps an entry virtual_only even when its local path never existed", () => {
    const rows = buildWorkspaceRows([], [entry("v/ghost.txt", "ghost/missing.bin")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("virtual_only");
  });

  it("consumes a catalog local path claimed by any entry (1:1 view)", () => {
    const rows = buildWorkspaceRows(["a.txt"], [entry("v/a.txt", "a.txt")]);
    expect(rows.filter((row) => row.kind === "local_only")).toHaveLength(0);
    expect(countByKind(rows)).toEqual({ paired: 1, local_only: 0, virtual_only: 0 });
  });

  it("handles the empty workspace", () => {
    expect(buildWorkspaceRows([], [])).toEqual([]);
  });
});

describe("countByKind / filterRows", () => {
  const rows = buildWorkspaceRows(
    ["a.txt", "b.txt"],
    [entry("v/a.txt", "a.txt"), entry("v/gone.txt", "gone.txt")],
  );

  it("counts every kind", () => {
    expect(countByKind(rows)).toEqual({ paired: 1, local_only: 1, virtual_only: 1 });
  });

  it("filters by kind and passes everything through for 'all'", () => {
    expect(filterRows(rows, "all")).toHaveLength(3);
    expect(filterRows(rows, "paired").map((row) => row.local_path)).toEqual(["a.txt"]);
    expect(filterRows(rows, "local_only").map((row) => row.local_path)).toEqual(["b.txt"]);
    expect(filterRows(rows, "virtual_only").map((row) => row.entry?.virtual_path)).toEqual([
      "v/gone.txt",
    ]);
  });
});
