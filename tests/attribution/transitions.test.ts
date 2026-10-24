import { disposeTrackerFixture, trackerFixture as fixture } from "../support/tracker-fixture.js";
import { expect, test } from "bun:test";
import { AttributionTransitions } from "../../src/attribution/transitions.js";
import {
  validateAuthoritativeBead,
  type WbdShowRunner,
} from "../../src/attribution/authoritative-bead.js";
import { generateReport } from "../../src/reporting/artifacts.js";

function runner(records: Record<string, unknown>[]): {
  run: WbdShowRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv) => {
      calls.push([...argv]);
      const beadID = argv[1];
      return JSON.stringify(records.filter((record) => record.id === beadID));
    },
  };
}

test("includes only same-root preceding activity for standalone creation", async () => {
  const { directory, store } = fixture();
  const source = runner([{ id: "bead-alpha", issue_type: "task" }]);
  const transitions = new AttributionTransitions(store, (beadID) =>
    validateAuthoritativeBead(beadID, source.run),
  );
  store.recordSession({ sessionID: "root", observedAt: 100 });
  store.startAction({ sessionID: "root", actionID: "old", startedAt: 100 });
  store.endAction({
    eventID: "end-old",
    aggregateID: "root-actions",
    sequence: 1,
    sessionID: "root",
    actionID: "old",
    outcome: "completed",
    endedAt: 150,
  });
  store.startAction({ sessionID: "root", actionID: "create", startedAt: 200 });

  expect(
    await transitions.beadCreated("bead-alpha", {
      sessionID: "root",
      receiptID: "create-receipt",
      observedAt: 250,
    }),
  ).toEqual({ ok: true, changed: true });
  store.endAction({
    eventID: "end-create",
    aggregateID: "root-actions",
    sequence: 2,
    sessionID: "root",
    actionID: "create",
    outcome: "completed",
    endedAt: 300,
  });
  expect(
    store
      .listActivitySlices()
      .map(({ beadID, startedAt, endedAt }) => [beadID, startedAt, endedAt]),
  ).toEqual([
    ["bead-alpha", 100, 150],
    ["bead-alpha", 200, 300],
  ]);
  expect(source.calls).toEqual([["show", "bead-alpha", "--json"]]);
  disposeTrackerFixture({ directory, store });
});

test("recursively attributes pre-creation delegated activity in the generated report", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "bead-pre", type: "feature", validatedAt: 1 });
    store.recordSession({ sessionID: "root", observedAt: 100 });
    store.recordSession({ sessionID: "investigator", parentSessionID: "root", observedAt: 110 });
    store.recordSession({
      sessionID: "architect",
      parentSessionID: "investigator",
      observedAt: 120,
    });
    store.startAction({ sessionID: "root", actionID: "root-scope", startedAt: 100 });
    store.endAction({
      eventID: "root-scope-end",
      aggregateID: "root",
      sequence: 1,
      sessionID: "root",
      actionID: "root-scope",
      outcome: "completed",
      endedAt: 130,
    });
    store.startAction({
      sessionID: "investigator",
      actionID: "investigate",
      observedRole: "investigator",
      startedAt: 110,
    });
    store.endAction({
      eventID: "investigate-end",
      aggregateID: "investigator",
      sequence: 1,
      sessionID: "investigator",
      actionID: "investigate",
      outcome: "completed",
      endedAt: 160,
    });
    store.startAction({
      sessionID: "architect",
      actionID: "plan",
      observedRole: "architect",
      startedAt: 120,
    });
    store.endAction({
      eventID: "plan-end",
      aggregateID: "architect",
      sequence: 1,
      sessionID: "architect",
      actionID: "plan",
      outcome: "completed",
      endedAt: 170,
    });

    store.recordAssociation({
      receiptID: "create-pre",
      sessionID: "root",
      beadID: "bead-pre",
      source: "creation",
      observedAt: 200,
    });

    const report = generateReport(store, { bead: "bead-pre" }, 300).report;
    expect(report.metrics.activeMs).toBe(130);
    expect(report.phaseTotals.scoping).toEqual({ activeMs: 130, actionCount: 3 });
    expect(report.phaseTotals.coordination).toEqual({ activeMs: 0, actionCount: 0 });
    expect(report.sessions?.map(({ sessionID }) => sessionID)).toEqual([
      "architect",
      "investigator",
      "root",
    ]);
    expect(report.actions?.map(({ sessionID, actionID }) => [sessionID, actionID])).toEqual([
      ["root", "root-scope"],
      ["investigator", "investigate"],
      ["architect", "plan"],
    ]);
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});

test("prunes attributed branches and preserves unrelated or non-null slices", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "bead-new", type: "feature", validatedAt: 1 });
    store.recordTopology({ beadID: "bead-old", type: "bug", validatedAt: 1 });
    store.recordTopology({ beadID: "bead-blocked", type: "task", validatedAt: 1 });
    store.recordSession({ sessionID: "root", observedAt: 100 });
    store.recordSession({ sessionID: "eligible", parentSessionID: "root", observedAt: 110 });
    store.recordSession({ sessionID: "nested", parentSessionID: "eligible", observedAt: 120 });
    store.recordSession({ sessionID: "mixed", parentSessionID: "root", observedAt: 110 });
    store.recordSession({ sessionID: "blocked", parentSessionID: "root", observedAt: 110 });
    store.recordSession({
      sessionID: "blocked-nested",
      parentSessionID: "blocked",
      observedAt: 120,
    });
    store.recordSession({ sessionID: "other-root", observedAt: 100 });

    store.startAction({ sessionID: "eligible", actionID: "eligible-work", startedAt: 110 });
    store.endAction({
      eventID: "eligible-end",
      aggregateID: "eligible",
      sequence: 1,
      sessionID: "eligible",
      actionID: "eligible-work",
      outcome: "completed",
      endedAt: 120,
    });
    store.startAction({ sessionID: "nested", actionID: "nested-work", startedAt: 120 });
    store.endAction({
      eventID: "nested-end",
      aggregateID: "nested",
      sequence: 1,
      sessionID: "nested",
      actionID: "nested-work",
      outcome: "completed",
      endedAt: 130,
    });

    store.recordAssociation({
      receiptID: "mixed-old",
      sessionID: "mixed",
      beadID: "bead-old",
      source: "selection",
      observedAt: 115,
    });
    store.startAction({ sessionID: "mixed", actionID: "old-work", startedAt: 115 });
    store.endAction({
      eventID: "old-work-end",
      aggregateID: "mixed",
      sequence: 1,
      sessionID: "mixed",
      actionID: "old-work",
      outcome: "completed",
      endedAt: 125,
    });
    store.recordCloseout({
      receiptID: "mixed-close",
      beadID: "bead-old",
      sessionID: "mixed",
      closedAt: 130,
    });
    store.startAction({ sessionID: "mixed", actionID: "new-work", startedAt: 140 });
    store.endAction({
      eventID: "new-work-end",
      aggregateID: "mixed",
      sequence: 2,
      sessionID: "mixed",
      actionID: "new-work",
      outcome: "completed",
      endedAt: 150,
    });

    store.recordAssociation({
      receiptID: "blocked-old",
      sessionID: "blocked",
      beadID: "bead-blocked",
      source: "selection",
      observedAt: 115,
    });
    store.startAction({ sessionID: "blocked-nested", actionID: "blocked-work", startedAt: 120 });
    store.endAction({
      eventID: "blocked-end",
      aggregateID: "blocked-nested",
      sequence: 1,
      sessionID: "blocked-nested",
      actionID: "blocked-work",
      outcome: "completed",
      endedAt: 130,
    });
    store.startAction({ sessionID: "other-root", actionID: "other-work", startedAt: 100 });
    store.endAction({
      eventID: "other-end",
      aggregateID: "other-root",
      sequence: 1,
      sessionID: "other-root",
      actionID: "other-work",
      outcome: "completed",
      endedAt: 130,
    });

    store.recordAssociation({
      receiptID: "create-new",
      sessionID: "root",
      beadID: "bead-new",
      source: "creation",
      observedAt: 200,
    });

    expect(
      store
        .listActivitySlices()
        .filter((slice) => slice.sessionID === "mixed")
        .map(({ beadID, associationSource, startedAt, endedAt }) => [
          beadID,
          associationSource,
          startedAt,
          endedAt,
        ]),
    ).toEqual([
      ["bead-old", "selection", 115, 125],
      ["bead-new", "inherited-lane", 140, 150],
    ]);
    expect(
      store
        .listActivitySlices()
        .filter((slice) => ["eligible", "nested"].includes(slice.sessionID))
        .every((slice) => slice.beadID === "bead-new"),
    ).toBe(true);
    expect(
      store
        .listActivitySlices()
        .filter((slice) => ["blocked", "blocked-nested", "other-root"].includes(slice.sessionID))
        .every((slice) => slice.beadID === null),
    ).toBe(true);
    expect(
      store
        .listAssociationReceipts()
        .map(({ sessionID }) => sessionID)
        .sort(),
    ).toEqual(["blocked", "eligible", "mixed", "mixed", "nested", "root"].sort());
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});

test("attributes later actions and lets post-creation children inherit normally", () => {
  const { directory, store } = fixture();
  try {
    store.recordTopology({ beadID: "bead-running", type: "feature", validatedAt: 1 });
    store.recordSession({ sessionID: "root", observedAt: 100 });
    store.recordSession({ sessionID: "running", parentSessionID: "root", observedAt: 110 });
    store.recordAssociation({
      receiptID: "create-running",
      sessionID: "root",
      beadID: "bead-running",
      source: "creation",
      observedAt: 200,
    });
    store.startAction({ sessionID: "running", actionID: "later-work", startedAt: 220 });
    store.endAction({
      eventID: "later-end",
      aggregateID: "running",
      sequence: 1,
      sessionID: "running",
      actionID: "later-work",
      outcome: "completed",
      endedAt: 240,
    });
    store.recordSession({
      sessionID: "after-child",
      parentSessionID: "running",
      observedAt: 250,
    });
    store.startAction({ sessionID: "after-child", actionID: "inherited-work", startedAt: 260 });
    store.endAction({
      eventID: "inherited-end",
      aggregateID: "after-child",
      sequence: 1,
      sessionID: "after-child",
      actionID: "inherited-work",
      outcome: "completed",
      endedAt: 270,
    });

    expect(
      store
        .listActivitySlices()
        .filter((slice) => ["running", "after-child"].includes(slice.sessionID))
        .map(({ sessionID, beadID, associationSource }) => [sessionID, beadID, associationSource]),
    ).toEqual([
      ["running", "bead-running", "inherited-lane"],
      ["after-child", "bead-running", "inherited-lane"],
    ]);
    expect(store.listAssociationReceipts()).toEqual([
      {
        receiptID: "create-running",
        sessionID: "root",
        beadID: "bead-running",
        source: "creation",
        observedAt: 200,
        sourceReceiptID: null,
      },
      {
        receiptID: "inherit:running",
        sessionID: "running",
        beadID: "bead-running",
        source: "inherited-lane",
        observedAt: 200,
        sourceReceiptID: "create-running",
      },
      {
        receiptID: "inherit:after-child",
        sessionID: "after-child",
        beadID: "bead-running",
        source: "inherited-lane",
        observedAt: 250,
        sourceReceiptID: "inherit:running",
      },
    ]);
  } finally {
    disposeTrackerFixture({ directory, store });
  }
});

test("registers child publication without changing epic attribution", async () => {
  const { directory, store } = fixture();
  const source = runner([
    { id: "epic-alpha", issue_type: "epic" },
    { id: "child-alpha", issue_type: "task", parent: "epic-alpha" },
  ]);
  const transitions = new AttributionTransitions(store, (beadID) =>
    validateAuthoritativeBead(beadID, source.run),
  );
  store.recordSession({ sessionID: "planner", observedAt: 100 });
  expect(
    await transitions.beadCreated("epic-alpha", {
      sessionID: "planner",
      receiptID: "epic-receipt",
      observedAt: 100,
    }),
  ).toEqual({ ok: true, changed: true });
  store.startAction({ sessionID: "planner", actionID: "publish", startedAt: 110 });
  expect(
    await transitions.beadCreated("child-alpha", {
      sessionID: "planner",
      receiptID: "child-receipt",
      observedAt: 120,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(store.listBeads().find((bead) => bead.beadID === "child-alpha")).toMatchObject({
    beadID: "child-alpha",
    type: "task",
    parentBeadID: "epic-alpha",
  });
  expect(store.listActivitySlices().map((slice) => slice.beadID)).toEqual(["epic-alpha"]);
  disposeTrackerFixture({ directory, store });
});

test("selects forward-only slices and makes repeats harmless", async () => {
  const { directory, store } = fixture();
  const source = runner([
    { id: "bead-alpha", issue_type: "task" },
    { id: "bead-beta", issue_type: "bug" },
  ]);
  const transitions = new AttributionTransitions(store, (beadID) =>
    validateAuthoritativeBead(beadID, source.run),
  );
  store.recordSession({ sessionID: "root", observedAt: 100 });
  store.startAction({ sessionID: "root", actionID: "work", startedAt: 100 });
  expect(
    await transitions.beadSelected("bead-alpha", {
      sessionID: "root",
      receiptID: "select-alpha",
      observedAt: 150,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(
    await transitions.beadSelected("bead-alpha", {
      sessionID: "root",
      receiptID: "select-alpha",
      observedAt: 160,
    }),
  ).toEqual({ ok: true, changed: false });
  expect(
    await transitions.beadSelected("bead-alpha", {
      sessionID: "root",
      receiptID: "select-alpha-replay",
      observedAt: 170,
    }),
  ).toEqual({ ok: true, changed: false });
  expect(
    await transitions.beadSelected("bead-beta", {
      sessionID: "root",
      receiptID: "select-beta",
      observedAt: 200,
    }),
  ).toEqual({ ok: true, changed: true });
  store.endAction({
    eventID: "end-work",
    aggregateID: "root-actions",
    sequence: 1,
    sessionID: "root",
    actionID: "work",
    outcome: "completed",
    endedAt: 300,
  });
  expect(
    store
      .listActivitySlices()
      .map(({ beadID, startedAt, endedAt }) => [beadID, startedAt, endedAt]),
  ).toEqual([
    [null, 100, 150],
    ["bead-alpha", 150, 200],
    ["bead-beta", 200, 300],
  ]);
  disposeTrackerFixture({ directory, store });
});

test("rejects an authoritative topology conflict without rewriting registration", async () => {
  const { directory, store } = fixture();
  let validationCount = 0;
  const transitions = new AttributionTransitions(store, async () => {
    validationCount += 1;
    return { beadID: "bead-alpha", type: validationCount === 1 ? "task" : "bug" };
  });
  store.recordSession({ sessionID: "root", observedAt: 100 });
  expect(
    await transitions.beadSelected("bead-alpha", {
      sessionID: "root",
      receiptID: "first-select",
      observedAt: 100,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(
    await transitions.beadSelected("bead-alpha", {
      sessionID: "root",
      receiptID: "conflicting-select",
      observedAt: 200,
    }),
  ).toEqual({ ok: false, changed: false });
  expect(store.listBeads().find((bead) => bead.beadID === "bead-alpha")).toMatchObject({
    beadID: "bead-alpha",
    type: "task",
  });
  disposeTrackerFixture({ directory, store });
});

test("records concrete and epic closeout effects without cross-workstream changes", async () => {
  const { directory, store } = fixture();
  const source = runner([
    { id: "epic-alpha", issue_type: "epic" },
    { id: "child-alpha", issue_type: "task", parent: "epic-alpha" },
    { id: "bead-alpha", issue_type: "feature" },
  ]);
  const transitions = new AttributionTransitions(store, (beadID) =>
    validateAuthoritativeBead(beadID, source.run),
  );
  store.recordSession({ sessionID: "root", observedAt: 100 });
  await transitions.beadCreated("epic-alpha", {
    sessionID: "root",
    receiptID: "epic-create",
    observedAt: 100,
  });
  await transitions.beadCreated("child-alpha", {
    sessionID: "root",
    receiptID: "child-create",
    observedAt: 110,
  });
  await transitions.beadSelected("bead-alpha", {
    sessionID: "root",
    receiptID: "bead-select",
    observedAt: 120,
  });
  store.startAction({ sessionID: "root", actionID: "close-work", startedAt: 150 });
  expect(
    await transitions.closeout("bead-alpha", {
      sessionID: "root",
      receiptID: "bead-close",
      observedAt: 200,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(store.listActivitySlices().at(-1)?.beadID).toBe(null);
  expect(
    await transitions.closeout("bead-alpha", {
      sessionID: "root",
      receiptID: "bead-close",
      observedAt: 201,
    }),
  ).toEqual({ ok: true, changed: false });
  expect(
    await transitions.closeout("epic-alpha", {
      sessionID: "root",
      receiptID: "epic-close",
      observedAt: 300,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(store.listCloseouts().map(({ beadID, kind }) => [beadID, kind])).toEqual([
    ["bead-alpha", "concrete"],
    ["epic-alpha", "epic"],
  ]);
  disposeTrackerFixture({ directory, store });
});

test("registers an authoritative parent for fresh child selection and closeout", async () => {
  const source = runner([
    { id: "epic-alpha", issue_type: "epic" },
    { id: "child-alpha", issue_type: "task", parent: "epic-alpha" },
  ]);
  const selected = fixture();
  const selectTransitions = new AttributionTransitions(selected.store, (beadID) =>
    validateAuthoritativeBead(beadID, source.run),
  );
  selected.store.recordSession({ sessionID: "root", observedAt: 100 });
  expect(
    await selectTransitions.beadSelected("child-alpha", {
      sessionID: "root",
      receiptID: "child-select",
      observedAt: 100,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(selected.store.listBeads().map(({ beadID, type }) => [beadID, type])).toEqual([
    ["child-alpha", "task"],
    ["epic-alpha", "epic"],
  ]);
  expect(selected.store.listAssociationReceipts().map(({ beadID }) => beadID)).toEqual([
    "child-alpha",
  ]);
  disposeTrackerFixture(selected);

  const closed = fixture();
  const closeTransitions = new AttributionTransitions(closed.store, (beadID) =>
    validateAuthoritativeBead(beadID, source.run),
  );
  closed.store.recordSession({ sessionID: "root", observedAt: 100 });
  expect(
    await closeTransitions.closeout("child-alpha", {
      sessionID: "root",
      receiptID: "child-close",
      observedAt: 100,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(closed.store.listCloseouts().map(({ beadID, kind }) => [beadID, kind])).toEqual([
    ["child-alpha", "concrete"],
  ]);
  expect(closed.store.listAssociationReceipts()).toEqual([]);
  disposeTrackerFixture(closed);
});

test("repeated creation is a no-op and cannot claim another root", async () => {
  const { directory, store } = fixture();
  const source = runner([{ id: "bead-alpha", issue_type: "task" }]);
  const transitions = new AttributionTransitions(store, (beadID) =>
    validateAuthoritativeBead(beadID, source.run),
  );
  store.recordSession({ sessionID: "root-one", observedAt: 100 });
  store.recordSession({ sessionID: "root-two", observedAt: 100 });
  store.startAction({ sessionID: "root-one", actionID: "create-one", startedAt: 100 });
  store.startAction({ sessionID: "root-two", actionID: "create-two", startedAt: 100 });
  expect(
    await transitions.beadCreated("bead-alpha", {
      sessionID: "root-one",
      receiptID: "create-one-receipt",
      observedAt: 150,
    }),
  ).toEqual({ ok: true, changed: true });
  expect(
    await transitions.beadCreated("bead-alpha", {
      sessionID: "root-two",
      receiptID: "create-two-receipt",
      observedAt: 200,
    }),
  ).toEqual({ ok: true, changed: false });
  expect(
    store
      .listActivitySlices()
      .filter((slice) => slice.sessionID === "root-two")
      .map(({ beadID }) => beadID),
  ).toEqual([null]);
  expect(store.listAssociationReceipts().map(({ sessionID }) => sessionID)).toEqual(["root-one"]);
  disposeTrackerFixture({ directory, store });
});
