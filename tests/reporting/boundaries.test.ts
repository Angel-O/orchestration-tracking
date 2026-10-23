import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import type { ReportArtifactStore, ReportSnapshotReader } from "../../src/reporting/contracts.js";
import type { TrackerStore } from "../../src/tracking/store.js";

const reportingDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../src/reporting");

const snapshot = {
  sessions: [],
  actions: [],
  slices: [],
  beads: [],
  associations: [],
  closeouts: [],
  sourceHighWaterMark: 0,
};
const snapshotReader: ReportSnapshotReader = { readReportSnapshot: () => snapshot };
const artifactStore: ReportArtifactStore = {
  ...snapshotReader,
  dataDir: "/private/tracker",
  recordReport: (input) => ({ ...input, generatedAt: input.generatedAt ?? 0 }),
};
const acceptsSnapshotReader = (store: ReportSnapshotReader): ReportSnapshotReader => store;
const acceptsArtifactStore = (store: ReportArtifactStore): ReportArtifactStore => store;
const trackerStoreSatisfiesReportingContracts: (
  store: TrackerStore,
) => [ReportSnapshotReader, ReportArtifactStore] = (store) => [
  acceptsSnapshotReader(store),
  acceptsArtifactStore(store),
];

test("pure reporting modules do not acquire effect dependencies", () => {
  for (const file of ["models.ts", "build.ts", "markdown.ts", "html.ts"]) {
    const source = readFileSync(join(reportingDirectory, file), "utf8");
    expect(source).not.toMatch(/from ["']node:/u);
    expect(source).not.toMatch(/TrackerStore/u);
    expect(source).not.toMatch(/(?:readFile|writeFile|mkdir|createServer|spawn)/u);
  }
});

test("effectful reporting modules are isolated to the approved boundaries", () => {
  const artifacts = readFileSync(join(reportingDirectory, "artifacts.ts"), "utf8");
  const viewer = readFileSync(join(reportingDirectory, "viewer.ts"), "utf8");
  expect(artifacts).toContain('from "node:fs"');
  expect(artifacts).toContain("recordReport");
  expect(viewer).toContain('from "node:http"');
  expect(viewer).toContain("createServer");
});

test("reporting contracts expose only snapshot reading and artifact persistence", () => {
  expect(Object.keys(snapshotReader)).toEqual(["readReportSnapshot"]);
  expect(Object.keys(artifactStore)).toEqual(["readReportSnapshot", "dataDir", "recordReport"]);
  expect(typeof trackerStoreSatisfiesReportingContracts).toBe("function");
});
