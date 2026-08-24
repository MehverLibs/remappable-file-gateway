import { describe, expect, it } from "vitest";

import { formatBytes, isZipArchiveMemberPath, splitZipLogicalPath } from "./paths";

describe("splitZipLogicalPath", () => {
  it("splits container and entry identities at the !/ marker", () => {
    expect(splitZipLogicalPath("packs/a.rfg.zip!/x/one.txt")).toEqual({
      container: "packs/a.rfg.zip",
      entry: "x/one.txt",
    });
    expect(splitZipLogicalPath("packs/a.rfg.zip!/two.txt")).toEqual({
      container: "packs/a.rfg.zip",
      entry: "two.txt",
    });
  });

  it("returns null for ordinary files", () => {
    expect(splitZipLogicalPath("docs/a.txt")).toBeNull();
    expect(splitZipLogicalPath("notes!/a.txt")).toBeNull();
    expect(splitZipLogicalPath("archive.rfg.zip!/")).toBeNull();
    expect(splitZipLogicalPath("archive.rfg.zip!/../outside")).toBeNull();
    expect(isZipArchiveMemberPath("archive.rfg.zip!/member")).toBe(true);
  });
});

describe("formatBytes", () => {
  it("formats binary sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MiB");
    expect(formatBytes(10 * 1024 ** 2)).toBe("10 MiB");
    expect(formatBytes(-1)).toBe("—");
  });
});
