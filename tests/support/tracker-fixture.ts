import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../../src/config/options.js";
import { TrackerStore } from "../../src/store.js";

export type TrackerFixture = {
  readonly directory: string;
  readonly store: TrackerStore;
};

export function trackerFixture(prefix = "tracker-test-"): TrackerFixture {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

export function disposeTrackerFixture({ directory, store }: TrackerFixture): void {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
