import { describe, expect, it } from "vitest";

import { parseMappingDraft } from "./mapping";

describe("parseMappingDraft", () => {
  it("accepts a current mapping document without altering its entries", () => {
    const text = JSON.stringify({
      entries: [{
        virtual_path: "docs/readme.txt",
        local_path: "sources/readme.txt",
        size_bytes: null,
        crc32: "1234abcd",
        md5: "abc123",
        sha256: null,
        ahash: "hash-a",
        dhash: null,
        phash: "hash-p",
      }],
    });

    expect(parseMappingDraft(text)).toEqual({
      ok: true,
      document: {
        entries: [{
          virtual_path: "docs/readme.txt",
          local_path: "sources/readme.txt",
          size_bytes: null,
          crc32: "1234abcd",
          md5: "abc123",
          sha256: null,
          ahash: "hash-a",
          dhash: null,
          phash: "hash-p",
        }],
      },
    });
  });

  it("rejects an extra root field", () => {
    const result = parseMappingDraft(JSON.stringify({ entries: [], extra: true }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('根对象 包含未知字段 "extra"');
  });

  it("rejects an extra entry field", () => {
    const result = parseMappingDraft(JSON.stringify({
      entries: [{ virtual_path: "v", local_path: "l", extra: true }],
    }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('entries[0] 包含未知字段 "extra"');
  });

  it.each([null, [], "entry", 1])("rejects a malformed entry object: %j", (entry) => {
    const result = parseMappingDraft(JSON.stringify({ entries: [entry] }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("entries[0] 必须是对象");
  });

  it.each([
    [{ local_path: "l" }, "缺少 virtual_path"],
    [{ virtual_path: "v" }, "缺少 local_path"],
    [{ virtual_path: 1, local_path: "l" }, "virtual_path 必须是字符串"],
    [{ virtual_path: "v", local_path: null }, "local_path 必须是字符串"],
  ])("rejects missing or non-string required fields", (entry, expectedError) => {
    const result = parseMappingDraft(JSON.stringify({ entries: [entry] }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(`entries[0].${expectedError}`);
  });

  it.each([
    ["size_bytes", "12"],
    ["md5", 12],
    ["sha256", false],
    ["crc32", {}],
    ["ahash", []],
    ["dhash", 0],
    ["phash", true],
  ])("rejects an invalid optional %s value", (field, value) => {
    const result = parseMappingDraft(JSON.stringify({
      entries: [{ virtual_path: "v", local_path: "l", [field]: value }],
    }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(`entries[0].${field} 类型无效`);
  });
});
