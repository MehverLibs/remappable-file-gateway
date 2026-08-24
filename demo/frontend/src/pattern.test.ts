import { describe, expect, it } from "vitest";

import {
  DEFAULT_PATTERN,
  EXTENSION_TOKEN,
  FILENAME_TOKEN,
  countExtensionless,
  previewPathPattern,
  renderPathPattern,
} from "./pattern";

describe("renderPathPattern", () => {
  it("defaults to <文件名>.<扩展名>", () => {
    expect(DEFAULT_PATTERN).toBe(`${FILENAME_TOKEN}.${EXTENSION_TOKEN}`);
    expect(renderPathPattern(DEFAULT_PATTERN, "source/a.jpg")).toBe("a.jpg");
  });

  it("supports literal prefixes, suffixes, and folder prefixes", () => {
    expect(renderPathPattern("dir/a-<文件名>.<扩展名>", "source/a.jpg")).toBe("dir/a-a.jpg");
    expect(renderPathPattern("<文件名>-备份.<扩展名>", "x/report.tar.gz")).toBe(
      "report.tar-备份.gz",
    );
    expect(renderPathPattern("photos/2024/<文件名>.<扩展名>", "a/b/c.png")).toBe(
      "photos/2024/c.png",
    );
  });

  it("uses only the leaf name, never the local folders", () => {
    expect(renderPathPattern(DEFAULT_PATTERN, "deep/nested/file.txt")).toBe("file.txt");
  });

  it("reads the leaf of archive member logical paths", () => {
    expect(renderPathPattern(DEFAULT_PATTERN, "pack.rfg.zip!/inner/pic.png")).toBe("pic.png");
  });

  it("collapses the dot for files without an extension", () => {
    expect(renderPathPattern(DEFAULT_PATTERN, "docs/README")).toBe("README");
    expect(renderPathPattern(DEFAULT_PATTERN, ".gitignore")).toBe(".gitignore");
    expect(renderPathPattern("<文件名>-x", "docs/README")).toBe("README-x");
  });

  it("renders a bare extension token empty for extension-less files", () => {
    expect(renderPathPattern("<文件名><扩展名>", "docs/README")).toBe("README");
  });

  it("leaves unknown tokens and repeated tokens deterministic", () => {
    expect(renderPathPattern("<文件名>-<文件名>", "a.txt")).toBe("a-a");
    expect(renderPathPattern("<其他>/<文件名>", "a.txt")).toBe("<其他>/a");
  });
});

describe("previewPathPattern", () => {
  it("reports per-row path errors", () => {
    const previews = previewPathPattern("/absolute/<文件名>", ["a.txt", "b.txt"]);
    expect(previews).toHaveLength(2);
    expect(previews.every((preview) => preview.error !== null)).toBe(true);
  });

  it("flags collisions inside the batch on every colliding row", () => {
    const previews = previewPathPattern("fixed.txt", ["a.txt", "b.txt", "c.txt"]);
    expect(previews.every((preview) => preview.error?.includes("碰撞"))).toBe(true);
    const ok = previewPathPattern(DEFAULT_PATTERN, ["a.txt", "b.txt"]);
    expect(ok.every((preview) => preview.error === null)).toBe(true);
  });

  it("flags collisions against existing virtual paths", () => {
    const previews = previewPathPattern(DEFAULT_PATTERN, ["a.txt"], new Set(["a.txt"]));
    expect(previews[0]?.error).toContain("已存在");
    const clean = previewPathPattern(DEFAULT_PATTERN, ["b.txt"], new Set(["a.txt"]));
    expect(clean[0]?.error).toBeNull();
  });
});

describe("countExtensionless", () => {
  it("counts files whose leaf name has no extension", () => {
    expect(countExtensionless(["docs/README", "a.jpg", "pack.rfg.zip!/LICENSE", ".gitignore"]))
      .toBe(3);
    expect(countExtensionless(["a.jpg", "b.png"])).toBe(0);
  });
});
