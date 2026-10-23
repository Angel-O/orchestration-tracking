import { disposeTrackerFixture, trackerFixture as fixture } from "../support/tracker-fixture.js";
import { expect, test } from "bun:test";

test("keeps immutable topology and splits activity at an association receipt", () => {
  const { directory, store } = fixture();
  store.recordTopology({ beadID: "epic-1", type: "epic", validatedAt: 1 });
  store.recordTopology({
    beadID: "child-1",
    type: "task",
    parentBeadID: "epic-1",
    validatedAt: 2,
  });
  expect(
    store.recordTopology({
      beadID: "child-1",
      type: "task",
      parentBeadID: "epic-1",
      validatedAt: 3,
    }),
  ).toEqual({ beadID: "child-1", type: "task", parentBeadID: "epic-1", validatedAt: 2 });
  expect(() =>
    store.recordTopology({ beadID: "child-1", type: "bug", parentBeadID: "epic-1" }),
  ).toThrow(/conflicts/);

  store.recordSession({ sessionID: "session-1", observedAt: 100 });
  store.startAction({
    sessionID: "session-1",
    actionID: "message-1",
    observedRole: "worker",
    startedAt: 100,
  });
  expect(
    store.recordAssociation({
      receiptID: "association-1",
      sessionID: "session-1",
      beadID: "child-1",
      source: "selection",
      observedAt: 150,
    }),
  ).toBe(true);
  expect(
    store.recordAssociation({
      receiptID: "association-1",
      sessionID: "session-1",
      beadID: "child-1",
      source: "selection",
      observedAt: 150,
    }),
  ).toBe(false);
  store.endAction({
    eventID: "event-1",
    aggregateID: "action-stream",
    sequence: 1,
    sessionID: "session-1",
    actionID: "message-1",
    outcome: "completed",
    endedAt: 200,
  });
  expect(store.listActivitySlices()).toEqual([
    {
      sliceID: 1,
      actionID: "message-1",
      sessionID: "session-1",
      beadID: null,
      associationSource: null,
      startedAt: 100,
      endedAt: 150,
    },
    {
      sliceID: 2,
      actionID: "message-1",
      sessionID: "session-1",
      beadID: "child-1",
      associationSource: "selection",
      startedAt: 150,
      endedAt: 200,
    },
  ]);
  disposeTrackerFixture({ directory, store });
});

test("makes closeout and report metadata replay-safe without storing prohibited content", () => {
  const { directory, store } = fixture();
  store.recordTopology({ beadID: "bead-1", type: "feature", validatedAt: 1 });
  const closeout = store.recordCloseout({
    receiptID: "closeout-1",
    beadID: "bead-1",
    closedAt: 300,
  });
  expect(
    store.recordCloseout({ receiptID: "different-receipt", beadID: "bead-1", closedAt: 999 }),
  ).toEqual(closeout);
  store.recordReport({
    reportID: "report-1",
    artifactPath: "reports/beads/bead-1/report.html",
    selectorFingerprint: "fingerprint-1",
    policyVersion: "session-attribution-v1",
    sourceHighWaterMark: 4,
    generatedAt: 400,
  });
  store.recordReport({
    reportID: "report-1",
    artifactPath: "reports/beads/bead-1/report.html",
    selectorFingerprint: "fingerprint-1",
    policyVersion: "session-attribution-v1",
    sourceHighWaterMark: 5,
    generatedAt: 401,
  });
  expect(store.listCloseouts()).toHaveLength(1);
  expect(store.listReports()).toHaveLength(1);
  const encoded = JSON.stringify({
    sessions: store.listSessions(),
    actions: store.listActions(),
    slices: store.listActivitySlices(),
    receipts: store.listLifecycleReceipts(),
    closeouts: store.listCloseouts(),
    reports: store.listReports(),
  });
  expect(encoded).not.toMatch(/prompt|response|transcript|token|tool_payload|git|\/Users\//i);
  disposeTrackerFixture({ directory, store });
});

test("resets only the invoking session after concrete closeout", () => {
  const { directory, store } = fixture();
  store.recordTopology({ beadID: "bead-1", type: "task", validatedAt: 1 });
  store.recordSession({ sessionID: "session-1", observedAt: 100 });
  store.recordAssociation({
    receiptID: "association-1",
    sessionID: "session-1",
    beadID: "bead-1",
    source: "selection",
    observedAt: 100,
  });
  store.startAction({ sessionID: "session-1", actionID: "message-1", startedAt: 100 });
  store.recordCloseout({
    receiptID: "closeout-1",
    beadID: "bead-1",
    sessionID: "session-1",
    closedAt: 200,
  });
  expect(() =>
    store.recordAssociation({
      receiptID: "association-2",
      sessionID: "session-1",
      beadID: "bead-1",
      source: "selection",
      observedAt: 201,
    }),
  ).toThrow(/closed/);
  store.startAction({ sessionID: "session-1", actionID: "message-2", startedAt: 300 });
  expect(store.listActivitySlices().map((slice) => [slice.beadID, slice.startedAt])).toEqual([
    ["bead-1", 100],
    [null, 200],
    [null, 300],
  ]);
  disposeTrackerFixture({ directory, store });
});
