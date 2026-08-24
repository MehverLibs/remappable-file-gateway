import { type HashResult, type MappingEntry } from "./api";
import { bindCurrentSourceFacts, type SourceFacts } from "./sourceCatalog";

type SetEntries = (updater: (previous: MappingEntry[]) => MappingEntry[]) => void;

/** Creates a completion handler that reads catalog facts when it runs, not when queued. */
export function createHashMergeConsumer(getCurrentSourceFacts: () => SourceFacts, setEntries: SetEntries): (result: HashResult) => void {
  return (result) => {
    if (result.status !== "succeeded") return;
    setEntries((previous) => previous.map((entry) => entry.local_path === result.local_path
      ? bindCurrentSourceFacts({ ...entry, [result.algorithm]: result.value }, getCurrentSourceFacts())
      : entry));
  };
}
