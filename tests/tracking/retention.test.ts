import { disposeTrackerFixture, trackerFixture as fixture } from "../support/tracker-fixture.js";
import { expect, test } from "bun:test";
import { UNASSIGNED_RETENTION_MS } from "../../src/tracking/store.js";

test("does not admit a launch descriptor after the first action", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "bead-late", type: "task", validatedAt: 1 });
    store.recordSession({ sessionID: "session", observedAt: 10 });
    store.startAction({ sessionID: "session", actionID: "first", startedAt: 10 });
    expect(
      store.recordAssociation({
        receiptID: "late-launch",
        sessionID: "session",
        beadID: "bead-late",
        source: "launch-descriptor",
        observedAt: 20,
      }),
    ).toBe(false);
    expect(store.listActivitySlices().map(({ beadID }) => beadID)).toEqual([null]);
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});

test("inherits attribution once and permits a later explicit override", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "bead-a", type: "task", validatedAt: 1 });
    store.recordTopology({ beadID: "bead-b", type: "task", validatedAt: 1 });
    store.recordSession({ sessionID: "parent", observedAt: 10 });
    store.recordAssociation({
      receiptID: "parent-a",
      sessionID: "parent",
      beadID: "bead-a",
      source: "selection",
      observedAt: 20,
    });
    store.recordSession({ sessionID: "child", parentSessionID: "parent", observedAt: 30 });
    store.recordAssociation({
      receiptID: "parent-b",
      sessionID: "parent",
      beadID: "bead-b",
      source: "selection",
      observedAt: 40,
    });
    store.startAction({ sessionID: "child", actionID: "child-action", startedAt: 50 });
    store.recordAssociation({
      receiptID: "child-b",
      sessionID: "child",
      beadID: "bead-b",
      source: "selection",
      observedAt: 60,
    });
    store.endAction({
      eventID: "child-end",
      aggregateID: "child",
      sequence: 1,
      sessionID: "child",
      actionID: "child-action",
      outcome: "completed",
      endedAt: 70,
    });

    expect(
      store.listActivitySlices().map(({ sessionID, beadID, associationSource, startedAt }) => ({
        sessionID,
        beadID,
        associationSource,
        startedAt,
      })),
    ).toEqual([
      { sessionID: "child", beadID: "bead-a", associationSource: "inherited-lane", startedAt: 50 },
      { sessionID: "child", beadID: "bead-b", associationSource: "selection", startedAt: 60 },
    ]);
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});

test("prunes old unassigned slices without deleting associated evidence", () => {
  const { directory, store } = fixture();
  try {
    const now = UNASSIGNED_RETENTION_MS + 10_000;
    store.recordTopology({ beadID: "bead-kept", type: "feature", validatedAt: 1 });
    store.recordSession({ sessionID: "unassigned", observedAt: 1 });
    store.startAction({
      sessionID: "unassigned",
      actionID: "old",
      startedAt: 1,
      receiptID: "old-start",
    });
    store.endAction({
      eventID: "old-end",
      aggregateID: "unassigned",
      sequence: 1,
      sessionID: "unassigned",
      actionID: "old",
      outcome: "completed",
      endedAt: 2,
    });

    store.recordSession({ sessionID: "mixed", observedAt: 1 });
    store.startAction({
      sessionID: "mixed",
      actionID: "mixed-action",
      startedAt: 1,
      receiptID: "mixed-start",
    });
    store.recordAssociation({
      receiptID: "mixed-association",
      sessionID: "mixed",
      beadID: "bead-kept",
      source: "selection",
      observedAt: 5,
    });
    store.endAction({
      eventID: "mixed-end",
      aggregateID: "mixed",
      sequence: 1,
      sessionID: "mixed",
      actionID: "mixed-action",
      outcome: "completed",
      endedAt: 6,
    });

    expect(store.cleanupUnassigned(now, 100)).toEqual({ slicesPruned: 2, sessionsPruned: 1 });
    expect(store.listLifecycleReceipts().map(({ eventID }) => eventID)).toEqual([
      "mixed-end",
      "mixed-start",
    ]);
    expect(store.listSessions().map((session) => session.sessionID)).toEqual(["mixed"]);
    expect(
      store.listActivitySlices().map(({ sessionID, beadID, associationSource }) => ({
        sessionID,
        beadID,
        associationSource,
      })),
    ).toEqual([{ sessionID: "mixed", beadID: "bead-kept", associationSource: "selection" }]);
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});

test("prunes expired deleted-session incomplete activity without inventing an end", () => {
  const { directory, store } = fixture();
  try {
    const now = UNASSIGNED_RETENTION_MS + 10_000;
    store.recordTopology({ beadID: "bead-kept", type: "feature", validatedAt: 1 });

    store.recordSession({ sessionID: "deleted", observedAt: 1 });
    store.startAction({
      sessionID: "deleted",
      actionID: "old",
      startedAt: 1,
      receiptID: "old-start",
    });
    store.recoverStaleActions([{ sessionID: "deleted", actionID: "old" }], {
      eventID: "deleted-receipt",
      aggregateID: "deleted",
      sequence: 1,
      eventType: "session.deleted",
      observedAt: 2,
    });

    store.recordSession({ sessionID: "mixed-incomplete", observedAt: 1 });
    store.startAction({
      sessionID: "mixed-incomplete",
      actionID: "mixed-action",
      startedAt: 1,
      receiptID: "mixed-start",
    });
    store.recordAssociation({
      receiptID: "mixed-association",
      sessionID: "mixed-incomplete",
      beadID: "bead-kept",
      source: "selection",
      observedAt: 5,
    });
    store.recoverStaleActions([{ sessionID: "mixed-incomplete", actionID: "mixed-action" }], {
      eventID: "mixed-deleted",
      aggregateID: "mixed-incomplete",
      sequence: 1,
      eventType: "session.deleted",
      observedAt: 6,
    });

    store.recordSession({ sessionID: "associated-incomplete", observedAt: 1 });
    store.recordAssociation({
      receiptID: "associated-selection",
      sessionID: "associated-incomplete",
      beadID: "bead-kept",
      source: "selection",
      observedAt: 1,
    });
    store.startAction({
      sessionID: "associated-incomplete",
      actionID: "associated-action",
      startedAt: 1,
      receiptID: "associated-start",
    });
    store.recoverStaleActions(
      [{ sessionID: "associated-incomplete", actionID: "associated-action" }],
      {
        eventID: "associated-deleted",
        aggregateID: "associated-incomplete",
        sequence: 1,
        eventType: "session.deleted",
        observedAt: 2,
      },
    );

    expect(store.listActions().find(({ sessionID }) => sessionID === "deleted")).toMatchObject({
      outcome: "incomplete",
      endedAt: null,
    });
    expect(store.listActivitySlices().filter(({ sessionID }) => sessionID === "deleted")).toEqual([
      {
        sliceID: 1,
        actionID: "old",
        sessionID: "deleted",
        beadID: null,
        associationSource: null,
        startedAt: 1,
        endedAt: null,
      },
    ]);

    expect(store.cleanupUnassigned(now, 100)).toEqual({ slicesPruned: 2, sessionsPruned: 1 });
    expect(
      store
        .listActions()
        .map(({ sessionID, outcome, endedAt }) => ({ sessionID, outcome, endedAt })),
    ).toEqual([
      { sessionID: "associated-incomplete", outcome: "incomplete", endedAt: null },
      { sessionID: "mixed-incomplete", outcome: "incomplete", endedAt: null },
    ]);
    expect(
      store
        .listActivitySlices()
        .filter(({ sessionID }) => sessionID !== "deleted")
        .map(({ sessionID, beadID, endedAt }) => ({ sessionID, beadID, endedAt })),
    ).toEqual([
      { sessionID: "mixed-incomplete", beadID: "bead-kept", endedAt: null },
      { sessionID: "associated-incomplete", beadID: "bead-kept", endedAt: null },
    ]);
    const lifecycleIDs = store.listLifecycleReceipts().map(({ eventID }) => eventID);
    expect(lifecycleIDs).not.toContain("old-start");
    expect(lifecycleIDs).toContain("mixed-start");
    expect(lifecycleIDs).toContain("associated-start");
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});
