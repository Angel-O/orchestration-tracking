import { disposeTrackerFixture, trackerFixture as fixture } from "../support/tracker-fixture.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { generateReport } from "../../src/reporting/artifacts.js";
import { renderReport } from "../../src/reporting/markdown.js";
import { TrackerStore } from "../../src/tracking/store.js";

function end(
  store: TrackerStore,
  sessionID: string,
  actionID: string,
  endedAt: number,
  sequence: number,
): void {
  store.endAction({
    eventID: `${actionID}-end`,
    aggregateID: sessionID,
    sequence,
    sessionID,
    actionID,
    outcome: "completed",
    endedAt,
  });
}

test("regenerates one stable private artifact atomically and excludes source content", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "bead-1", type: "feature", validatedAt: 1 });
    store.recordSession({ sessionID: "session-1", observedAt: 10 });
    store.recordAssociation({
      receiptID: "association-1",
      sessionID: "session-1",
      beadID: "bead-1",
      source: "selection",
      observedAt: 10,
    });
    store.startAction({
      sessionID: "session-1",
      actionID: "action-1",
      observedRole: "worker",
      startedAt: 10,
    });
    end(store, "session-1", "action-1", 20, 1);

    const first = generateReport(store, { bead: "bead-1" }, 30);
    const firstBytes = readFileSync(first.artifactPath, "utf8");
    const firstRenderedBytes = readFileSync(first.renderedArtifactPath, "utf8");
    expect(first.sourceHighWaterMark).toBe(store.readReportSnapshot().sourceHighWaterMark);
    const second = generateReport(store, { bead: "bead-1" }, 30);
    expect(second.reportID).toBe(first.reportID);
    expect(second.artifactPath).toBe(first.artifactPath);
    expect(readFileSync(second.artifactPath, "utf8")).toBe(firstBytes);
    expect(second.renderedArtifactKey).toBe(`reports/${first.reportID}.md`);
    expect(readFileSync(second.renderedArtifactPath, "utf8")).toBe(firstRenderedBytes);
    expect(firstRenderedBytes).toBe(renderReport(first.report));
    expect(store.listReports()).toHaveLength(1);
    expect(statSync(second.artifactPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(directory, "reports"))).toBe(true);
    expect(firstBytes).not.toMatch(/prompt|response|transcript|context|token|git|\/Users\//i);

    store.startAction({
      sessionID: "session-1",
      actionID: "action-2",
      observedRole: "worker",
      startedAt: 40,
    });
    end(store, "session-1", "action-2", 50, 2);
    const regenerated = generateReport(store, { bead: "bead-1" }, 60);
    expect(regenerated.reportID).toBe(first.reportID);
    expect(regenerated.sourceHighWaterMark > first.sourceHighWaterMark).toBe(true);
    expect(regenerated.report.metrics.activeMs).toBe(20);
    expect(store.listReports()).toHaveLength(1);
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});
