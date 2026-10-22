import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import { generateReport } from "../src/report.js";
import { TrackerStore } from "../src/store.js";

function fixture(): { directory: string; store: TrackerStore } {
  const directory = mkdtempSync(join(tmpdir(), "tracker-report-"));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

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

test("classifies fixed phases and separates direct, child, active, and elapsed metrics", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "epic-1", type: "epic", validatedAt: 1 });
    store.recordTopology({
      beadID: "child-1",
      type: "task",
      parentBeadID: "epic-1",
      validatedAt: 1,
    });
    store.recordSession({ sessionID: "epic-session", observedAt: 10 });
    store.recordAssociation({
      receiptID: "epic-association",
      sessionID: "epic-session",
      beadID: "epic-1",
      source: "selection",
      observedAt: 10,
    });
    store.startAction({
      sessionID: "epic-session",
      actionID: "scope",
      observedRole: "architect",
      startedAt: 10,
    });
    end(store, "epic-session", "scope", 110, 1);
    store.startAction({
      sessionID: "epic-session",
      actionID: "coordinate",
      observedRole: "orchestrator",
      startedAt: 120,
    });
    end(store, "epic-session", "coordinate", 170, 2);

    store.recordSession({ sessionID: "child-session", observedAt: 20 });
    store.recordAssociation({
      receiptID: "child-association",
      sessionID: "child-session",
      beadID: "child-1",
      source: "selection",
      observedAt: 20,
    });
    store.startAction({
      sessionID: "child-session",
      actionID: "implement",
      observedRole: "worker",
      startedAt: 20,
    });
    end(store, "child-session", "implement", 220, 1);
    store.startAction({
      sessionID: "child-session",
      actionID: "review",
      observedRole: "reviewer",
      startedAt: 230,
    });
    end(store, "child-session", "review", 280, 2);
    store.startAction({
      sessionID: "child-session",
      actionID: "unknown",
      observedRole: "unknown",
      startedAt: 300,
    });
    end(store, "child-session", "unknown", 350, 3);
    store.startAction({
      sessionID: "child-session",
      actionID: "open",
      observedRole: "worker",
      startedAt: 400,
    });

    const child = generateReport(store, { bead: "child-1" }, 500).report;
    expect(child.kind).toBe("child");
    expect(child.phaseTotals.implementation.activeMs).toBe(200);
    expect(child.phaseTotals.review.activeMs).toBe(50);
    expect(child.phaseTotals.scoping.activeMs).toBe(0);
    expect(child.phaseTotals.unclassified.activeMs).toBe(50);
    expect(child.metrics.activeMs).toBe(300);
    expect(child.metrics.elapsedMs).toBe(480);
    expect(child.metrics.outcomes).toEqual({
      open: 1,
      completed: 3,
      failed: 0,
      interrupted: 0,
      incomplete: 0,
    });
    expect(child.warnings).toContain("unclassified activity is present");
    expect(child.warnings).toContain("open or incomplete actions have zero active time");

    const epic = generateReport(store, { bead: "epic-1" }, 500).report;
    expect(epic.kind).toBe("epic");
    expect(epic.metrics.directActiveMs).toBe(150);
    expect(epic.metrics.summedChildActiveMs).toBe(300);
    expect(epic.metrics.combinedActiveMs).toBe(450);
    expect(epic.metrics.initiativeElapsedMs).toBe(490);
    expect(epic.elapsed.open).toBe(true);
    expect(epic.warnings).toContain("unclassified activity is present");
    expect(epic.notices).toEqual([
      "Summed active time includes concurrent lanes and can exceed elapsed time.",
      "Lifecycle values are observed tracker states, not authoritative Hub status.",
    ]);
    expect(epic.children?.map((summary) => [summary.beadID, summary.metrics.activeMs])).toEqual([
      ["child-1", 300],
    ]);
    expect(epic.actions).toBeUndefined();

    store.recordCloseout({ receiptID: "epic-closeout", beadID: "epic-1", closedAt: 300 });
    const closedEpic = generateReport(store, { bead: "epic-1" }, 500).report;
    expect(closedEpic.elapsed).toEqual({ startAt: 10, endAt: 300, durationMs: 290, open: false });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("classifies same-root creation history as standalone scoping without inference", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "standalone-1", type: "feature", validatedAt: 1 });
    store.recordSession({ sessionID: "root-1", observedAt: 10 });
    store.startAction({
      sessionID: "root-1",
      actionID: "before-create",
      observedRole: "worker",
      startedAt: 10,
    });
    end(store, "root-1", "before-create", 20, 1);
    store.startAction({
      sessionID: "root-1",
      actionID: "create",
      observedRole: "orchestrator",
      startedAt: 30,
    });
    store.recordAssociation({
      receiptID: "creation-1",
      sessionID: "root-1",
      beadID: "standalone-1",
      source: "creation",
      observedAt: 40,
    });
    end(store, "root-1", "create", 50, 2);
    store.startAction({
      sessionID: "root-1",
      actionID: "after-create",
      observedRole: "worker",
      startedAt: 60,
    });
    end(store, "root-1", "after-create", 80, 3);

    const report = generateReport(store, { bead: "standalone-1" }, 90).report;
    expect(report.kind).toBe("standalone");
    expect(report.phaseTotals.scoping.activeMs).toBe(30);
    expect(report.phaseTotals.implementation.activeMs).toBe(20);
    expect(report.metrics.activeMs).toBe(50);
    expect(report.warnings).toEqual([]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    expect(first.sourceHighWaterMark).toBe(store.readReportSnapshot().sourceHighWaterMark);
    const second = generateReport(store, { bead: "bead-1" }, 30);
    expect(second.reportID).toBe(first.reportID);
    expect(second.artifactPath).toBe(first.artifactPath);
    expect(readFileSync(second.artifactPath, "utf8")).toBe(firstBytes);
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
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
