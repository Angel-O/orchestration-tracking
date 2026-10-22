import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import { buildReportModels, generateReport, renderReport } from "../src/report.js";
import { TrackerStore, type ReportSnapshot } from "../src/store.js";

function fixture(): { directory: string; store: TrackerStore } {
  const directory = mkdtempSync(join(tmpdir(), "tracker-report-"));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

function emptySnapshot(): ReportSnapshot {
  return {
    sessions: [],
    actions: [],
    slices: [],
    beads: [],
    associations: [],
    closeouts: [],
    sourceHighWaterMark: 0,
  };
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
    const childView = renderReport(child);
    expect(childView).not.toContain("| Scoping |");
    expect(childView.indexOf("| Implementation |") < childView.indexOf("| Review |")).toBe(true);
    expect(childView.indexOf("| Review |") < childView.indexOf("| Unclassified |")).toBe(true);
    expect(childView).toContain("## Shared-clock lane timeline");
    expect(childView).toContain("child-session");
    expect(childView).toContain("| 400 | open | child-session | open |");

    const epic = generateReport(store, { bead: "epic-1" }, 500).report;
    expect(epic.kind).toBe("epic");
    expect(epic.metrics.directActiveMs).toBe(150);
    expect(epic.metrics.summedChildActiveMs).toBe(300);
    expect(epic.metrics.combinedActiveMs).toBe(450);
    expect(epic.metrics.initiativeElapsedMs).toBe(490);
    expect(epic.initiativeState).toBe("open");
    expect(epic.elapsed.open).toBe(true);
    expect(epic.warnings).toContain("unclassified activity is present");
    expect(epic.notices).toEqual([
      "Summed active time includes concurrent lanes and can exceed elapsed time.",
      "Lifecycle values are observed tracker states, not authoritative Hub status.",
    ]);
    expect(epic.children?.map((summary) => [summary.beadID, summary.metrics.activeMs])).toEqual([
      ["child-1", 300],
    ]);
    const epicModels = buildReportModels(store.readReportSnapshot(), { bead: "epic-1" }, 500);
    expect(epicModels.legacyDetail.passes.map((pass) => pass.actionID)).toEqual([
      "scope",
      "implement",
      "coordinate",
      "review",
      "unknown",
      "open",
    ]);
    expect(epicModels.legacyDetail.durations.activeMs).toBe(450);
    expect(epic.actions).toBeUndefined();
    const epicView = renderReport(epic);
    expect(epicView).toContain("## Metric cards");
    expect(epicView).toContain("| Direct epic active time | 150 ms |");
    expect(epicView).toContain("## Initiative window");
    expect(epicView).toContain("| First direct activity | 10 |");
    expect(epicView).toContain("| End (generation-time boundary) | 500 |");
    expect(epicView).toContain("## Direct phase totals");
    expect(epicView).toContain("## Child summary");
    expect(epicView).toContain("child-1");
    expect(epicView).not.toContain("child-session");
    expect(epicView).not.toContain("## Shared-clock lane timeline");

    store.recordCloseout({ receiptID: "epic-closeout", beadID: "epic-1", closedAt: 300 });
    const closedEpic = generateReport(store, { bead: "epic-1" }, 500).report;
    expect(closedEpic.initiativeState).toBe("closeout-bounded");
    expect(closedEpic.elapsed).toEqual({ startAt: 10, endAt: 300, durationMs: 290, open: false });
    const closedEpicView = renderReport(closedEpic);
    expect(closedEpicView).toContain("| End (successful epic closeout) | 300 |");
    expect(closedEpicView).not.toContain("generation-time boundary");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renders a published child as not started without child scoping", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "epic-1", type: "epic", validatedAt: 1 });
    store.recordTopology({
      beadID: "child-1",
      type: "task",
      parentBeadID: "epic-1",
      validatedAt: 1,
    });

    const child = generateReport(store, { bead: "child-1" }, 100).report;
    expect(child.kind).toBe("child");
    expect(child.lifecycleState).toBe("Not started");
    expect(child.phaseTotals.scoping.activeMs).toBe(0);
    expect(child.phaseTotals["scoping-decomposition"].activeMs).toBe(0);
    expect(child.metrics.activeMs).toBe(0);
    expect(child.actions).toEqual([]);
    expect(child.sessions).toEqual([]);

    const epic = generateReport(store, { bead: "epic-1" }, 100).report;
    expect(epic.initiativeState).toBe("not-started");
    expect(epic.elapsed).toEqual({ startAt: null, endAt: null, durationMs: 0, open: false });
    expect(epic.children?.[0]).toMatchObject({
      beadID: "child-1",
      lifecycleState: "Not started",
      metrics: { activeMs: 0 },
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renders incomplete action ends as unknown rather than open", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "bead-1", type: "task", validatedAt: 1 });
    store.recordSession({ sessionID: "session-1", observedAt: 1 });
    store.recordAssociation({
      receiptID: "association-1",
      sessionID: "session-1",
      beadID: "bead-1",
      source: "selection",
      observedAt: 1,
    });
    store.startAction({
      sessionID: "session-1",
      actionID: "stale",
      observedRole: "worker",
      startedAt: 10,
      receiptID: "stale-start",
    });
    store.recoverStaleActions([{ sessionID: "session-1", actionID: "stale" }], {
      eventID: "session-deleted",
      aggregateID: "session-1",
      sequence: 1,
      eventType: "session.deleted",
      observedAt: 20,
    });

    const view = renderReport(generateReport(store, { bead: "bead-1" }, 30).report);
    expect(view).toContain("| 10 | unknown | session-1 | stale |");
    expect(view).not.toContain("| 10 | open | session-1 | stale |");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps epic output to direct metrics and child summaries", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "epic-1", type: "epic", validatedAt: 1 });
    store.recordTopology({
      beadID: "child-1",
      type: "task",
      parentBeadID: "epic-1",
      validatedAt: 1,
    });
    store.recordSession({ sessionID: "epic-session", observedAt: 1 });
    store.recordAssociation({
      receiptID: "epic-association",
      sessionID: "epic-session",
      beadID: "epic-1",
      source: "selection",
      observedAt: 1,
    });
    store.startAction({
      sessionID: "epic-session",
      actionID: "direct",
      observedRole: "orchestrator",
      startedAt: 10,
    });
    end(store, "epic-session", "direct", 110, 1);
    store.recordSession({ sessionID: "child-session", observedAt: 1 });
    store.recordAssociation({
      receiptID: "child-association",
      sessionID: "child-session",
      beadID: "child-1",
      source: "selection",
      observedAt: 1,
    });
    store.startAction({
      sessionID: "child-session",
      actionID: "child-work",
      observedRole: "worker",
      startedAt: 20,
    });
    end(store, "child-session", "child-work", 220, 1);

    const report = generateReport(store, { bead: "epic-1" }, 300).report;
    expect(report.metrics).toMatchObject({
      activeMs: 100,
      directActiveMs: 100,
      summedChildActiveMs: 200,
      combinedActiveMs: 300,
    });
    expect(report.phaseTotals.coordination.activeMs).toBe(100);
    expect(report.phaseTotals.implementation.activeMs).toBe(0);
    expect(report.elapsed.durationMs).toBe(290);
    expect(report.metrics.combinedActiveMs! > report.elapsed.durationMs).toBe(true);
    expect(report.children?.[0].metrics.activeMs).toBe(200);
    expect(report.actions).toBeUndefined();
    expect(report.sessions).toBeUndefined();
    expect(JSON.stringify(report.children)).not.toContain("child-session");
    expect(JSON.stringify(report.children)).not.toContain("child-work");
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
    const view = renderReport(report);
    expect(view).toContain("# Standalone detailed report");
    expect(view).toContain("| Scoping | 30 ms | 2 |");
    expect(view.indexOf("| Scoping |") < view.indexOf("| Implementation |")).toBe(true);
    expect(view).toContain("## Shared-clock lane timeline");
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
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds the current document and one clipped multi-segment legacy pass without writes", () => {
  const snapshot: ReportSnapshot = {
    sessions: [
      {
        sessionID: "session-a",
        parentSessionID: null,
        projectLabel: "project-a",
        firstObservedAt: 1,
        lastObservedAt: 100,
      },
    ],
    actions: [
      {
        sessionID: "session-a",
        actionID: "pass-a",
        passNumber: 1,
        observedRole: "worker",
        phaseKey: "implementation",
        phaseLabel: "Implementation",
        repeatEligible: true,
        startedAt: 10,
        endedAt: 100,
        outcome: "completed",
        startReceiptID: null,
      },
      {
        sessionID: "session-a",
        actionID: "pass-b",
        passNumber: 2,
        observedRole: "worker",
        phaseKey: "implementation",
        phaseLabel: "Implementation",
        repeatEligible: true,
        startedAt: 60,
        endedAt: 80,
        outcome: "completed",
        startReceiptID: null,
      },
    ],
    slices: [
      {
        sliceID: 1,
        actionID: "pass-a",
        sessionID: "session-a",
        beadID: "bead-a",
        associationSource: "selection",
        startedAt: 10,
        endedAt: 20,
      },
      {
        sliceID: 2,
        actionID: "pass-a",
        sessionID: "session-a",
        beadID: "bead-a",
        associationSource: "selection",
        startedAt: 40,
        endedAt: 100,
      },
      {
        sliceID: 3,
        actionID: "pass-b",
        sessionID: "session-a",
        beadID: "bead-a",
        associationSource: "selection",
        startedAt: 60,
        endedAt: 80,
      },
    ],
    beads: [{ beadID: "bead-a", type: "feature", parentBeadID: null, validatedAt: 1 }],
    associations: [
      {
        receiptID: "association-a",
        sessionID: "session-a",
        beadID: "bead-a",
        source: "selection",
        observedAt: 1,
        sourceReceiptID: null,
      },
    ],
    closeouts: [],
    sourceHighWaterMark: 100,
  };

  const models = buildReportModels(snapshot, { bead: "bead-a", from: 15, to: 80 }, 120);
  expect(models.report).toMatchObject({
    kind: "standalone",
    selector: { bead: "bead-a", from: 15, to: 80 },
    metrics: { activeMs: 65, actionCount: 2 },
  });
  expect(models.legacyDetail).toMatchObject({
    status: "Active — closeout not observed",
    projectLabel: "project-a",
    selection: { bead: "bead-a", from: 15, to: 80 },
    durations: { activeMs: 65 },
    scale: { startAt: 15, endAt: 80, durationMs: 65 },
  });
  expect(models.legacyDetail.passes).toHaveLength(2);
  expect(models.legacyDetail.passes[0]).toMatchObject({
    passNumber: 1,
    phaseKey: "implementation",
    color: "#cfe8ff",
    activeMs: 45,
  });
  expect(models.legacyDetail.passes[0]?.segments).toEqual([
    {
      sliceID: 1,
      startedAt: 15,
      endedAt: 20,
      activeMs: 5,
      startPercent: 0,
      endPercent: (5 / 65) * 100,
      widthPercent: (5 / 65) * 100,
    },
    {
      sliceID: 2,
      startedAt: 40,
      endedAt: 80,
      activeMs: 40,
      startPercent: (25 / 65) * 100,
      endPercent: 100,
      widthPercent: 100 - (25 / 65) * 100,
    },
  ]);
  expect(models.legacyDetail.repeats).toEqual([
    {
      sessionID: "session-a",
      agent: "worker",
      phaseLabel: "Implementation",
      passes: 2,
      repeated: true,
      passNumbers: [1, 2],
      count: 2,
      repeatCount: 1,
    },
  ]);
});

test("the pure builder validates selector shape while preserving explicit empty and unknown sessions", () => {
  const empty = emptySnapshot();
  expect(buildReportModels(empty, { sessions: [] }, 1).report.selector).toEqual({ sessions: [] });
  expect(
    buildReportModels(empty, { sessions: ["missing-session"] }, 1).report.metrics,
  ).toMatchObject({
    sessionCount: 0,
    actionCount: 0,
  });
  expect(() => buildReportModels(empty, { unsupported: true } as never, 1)).toThrow(
    /report selector contains unsupported keys/u,
  );
  expect(() => buildReportModels(empty, { sessions: "session-a" } as never, 1)).toThrow(
    /report session selector is invalid/u,
  );
  expect(() => buildReportModels(empty, { sessions: [1] } as never, 1)).toThrow(
    /report session selector is invalid/u,
  );
});

test("legacy warnings include incomplete/unmapped passes and exclude non-repeatable or single passes", () => {
  const snapshot: ReportSnapshot = {
    sessions: [
      {
        sessionID: "session-a",
        parentSessionID: null,
        projectLabel: "project-a",
        firstObservedAt: 1,
        lastObservedAt: 30,
      },
    ],
    actions: [
      {
        sessionID: "session-a",
        actionID: "incomplete-pass",
        passNumber: 1,
        observedRole: "worker",
        phaseKey: "implementation",
        phaseLabel: "Implementation",
        repeatEligible: true,
        startedAt: 10,
        endedAt: null,
        outcome: "incomplete",
        startReceiptID: "receipt-a",
      },
      {
        sessionID: "session-a",
        actionID: "unmapped-pass",
        passNumber: 2,
        observedRole: "worker",
        phaseKey: "unmapped",
        phaseLabel: "Unmapped",
        repeatEligible: false,
        startedAt: 20,
        endedAt: 30,
        outcome: "completed",
        startReceiptID: null,
      },
    ],
    slices: [
      {
        sliceID: 1,
        actionID: "incomplete-pass",
        sessionID: "session-a",
        beadID: null,
        associationSource: null,
        startedAt: 10,
        endedAt: null,
      },
      {
        sliceID: 2,
        actionID: "unmapped-pass",
        sessionID: "session-a",
        beadID: null,
        associationSource: null,
        startedAt: 20,
        endedAt: 30,
      },
    ],
    beads: [],
    associations: [],
    closeouts: [],
    sourceHighWaterMark: 30,
  };
  const legacy = buildReportModels(snapshot, {}, 40).legacyDetail;
  expect(legacy.warnings).toContain("incomplete pass in session-a");
  expect(legacy.warnings).toContain("unmapped agent in session-a");
  expect(legacy.repeats).toEqual([]);
  expect(legacy.incomplete).toBe(true);
  expect(legacy.unmapped).toBe(true);
});
