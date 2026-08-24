import { describe, expect, it } from "vitest";

import type { LocalFile, MappingEntry } from "./api";
import { bindCurrentSourceFacts, missingZipMemberCrcRequests, sourceFactsByPath } from "./sourceCatalog";

describe("source catalog facts", () => {
  const catalog: LocalFile[] = [{ local_path: "ordinary.bin", size_bytes: 12 }, { local_path: "archive.rfg.zip!/member", size_bytes: 34 }];

  it("uses current catalog sizes for display and bindings while preserving the flat mapping schema", () => {
    const facts = sourceFactsByPath(catalog);
    expect(facts.get("ordinary.bin")?.size_bytes).toBe(12);
    expect(bindCurrentSourceFacts({ virtual_path: "v", local_path: "ordinary.bin", md5: "old" }, facts)).toEqual({ virtual_path: "v", local_path: "ordinary.bin", size_bytes: 12, md5: "old" });
  });

  it("updates size on rebind from the current catalog without treating it as a hash", () => {
    const facts = sourceFactsByPath(catalog);
    const entry: MappingEntry = { virtual_path: "v", local_path: "missing", size_bytes: 1, crc32: "keep" };
    expect(bindCurrentSourceFacts({ ...entry, local_path: "archive.rfg.zip!/member" }, facts)).toEqual({ ...entry, local_path: "archive.rfg.zip!/member", size_bytes: 34 });
  });

  it("automatically requests CRC only for catalog ZIP members that lack CRC, never ordinary sizes", () => {
    const facts = sourceFactsByPath(catalog);
    expect(missingZipMemberCrcRequests([
      { virtual_path: "ordinary", local_path: "ordinary.bin" },
      { virtual_path: "member", local_path: "archive.rfg.zip!/member" },
      { virtual_path: "already", local_path: "archive.rfg.zip!/member", crc32: "present" },
    ], facts)).toEqual([{ local_path: "archive.rfg.zip!/member", algorithm: "crc32" }]);
  });
});
