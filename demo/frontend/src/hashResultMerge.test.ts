import { describe, expect, it } from "vitest";

import { type HashResult, type MappingEntry } from "./api";
import { createHashMergeConsumer } from "./hashResultMerge";
import { sourceFactsByPath, type SourceFacts } from "./sourceCatalog";

const result: HashResult = {
  local_path: "a.txt", algorithm: "md5", profile: null, status: "succeeded", value: "digest", code: "computed", detail: null, error: null,
};

describe("createHashMergeConsumer", () => {
  it("binds hash completion to the catalog facts current at completion time", () => {
    let currentFacts: SourceFacts = sourceFactsByPath([{ local_path: "a.txt", size_bytes: 10 }]);
    let entries: MappingEntry[] = [{ virtual_path: "v.txt", local_path: "a.txt", size_bytes: 10 }];
    const consumer = createHashMergeConsumer(() => currentFacts, (updater) => { entries = updater(entries); });

    currentFacts = sourceFactsByPath([{ local_path: "a.txt", size_bytes: 25 }]);
    consumer(result);

    expect(entries).toEqual([{ virtual_path: "v.txt", local_path: "a.txt", size_bytes: 25, md5: "digest" }]);
  });
});
