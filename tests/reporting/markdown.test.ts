import { disposeTrackerFixture, trackerFixture as fixture } from "../support/tracker-fixture.js";
import { expect, test } from "bun:test";
import { buildReportModels, generateReport, renderReport } from "../../src/report.js";
import { TrackerStore } from "../../src/store.js";

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
    expect(epicModels.reportDetail.passes.map((pass) => pass.actionID)).toEqual([
      "scope",
      "implement",
      "coordinate",
      "review",
      "unknown",
      "open",
    ]);
    expect(epicModels.reportDetail.durations.activeMs).toBe(450);
    expect(epicModels.reportDetail.metrics).toMatchObject({
      directActiveMs: 150,
      summedChildActiveMs: 300,
      combinedActiveMs: 450,
    });
    expect(epicModels.reportDetail.phaseTotals.coordination.activeMs).toBe(50);
    expect(
      epicModels.reportDetail.children?.map((child) => [child.beadID, child.metrics.activeMs]),
    ).toEqual([["child-1", 300]]);
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
    disposeTrackerFixture({ directory, store });
  }
});
