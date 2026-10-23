import { disposeTrackerFixture, trackerFixture as fixture } from "../support/tracker-fixture.js";
import { expect, test } from "bun:test";
import { buildReportModels } from "../../src/reporting/build.js";
import { generateReport } from "../../src/reporting/artifacts.js";
import { renderReport } from "../../src/reporting/markdown.js";
import { TrackerStore } from "../../src/tracking/store.js";
import type { ReportSnapshot } from "../../src/tracking/models.js";

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
    disposeTrackerFixture({ directory, store });
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
    disposeTrackerFixture({ directory, store });
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
    disposeTrackerFixture({ directory, store });
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
    disposeTrackerFixture({ directory, store });
  }
});

test("builds the current document and one clipped multi-segment report-detail pass without writes", () => {
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
  expect(models.reportDetail).toMatchObject({
    status: "Active — closeout not observed",
    projectLabel: "project-a",
    selection: { bead: "bead-a", from: 15, to: 80 },
    durations: { activeMs: 65 },
    scale: { startAt: 15, endAt: 80, durationMs: 65 },
  });
  expect(models.reportDetail.passes).toHaveLength(2);
  expect(models.reportDetail.passes[0]).toMatchObject({
    passNumber: 1,
    phaseKey: "implementation",
    color: "#cfe8ff",
    activeMs: 45,
  });
  expect(models.reportDetail.passes[0]?.segments).toEqual([
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
  expect(models.reportDetail.repeats).toEqual([
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

test("report-detail warnings include incomplete/unmapped passes and exclude non-repeatable or single passes", () => {
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
  const reportDetail = buildReportModels(snapshot, {}, 40).reportDetail;
  expect(reportDetail.warnings).toContain("incomplete pass in session-a");
  expect(reportDetail.warnings).toContain("unmapped agent in session-a");
  expect(reportDetail.repeats).toEqual([]);
  expect(reportDetail.incomplete).toBe(true);
  expect(reportDetail.unmapped).toBe(true);
});
