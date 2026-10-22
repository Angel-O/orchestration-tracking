import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AttributionTransitions,
  validateAuthoritativeBead,
  type WbdShowRunner,
} from "../src/attribution.js";
import { parseOptions } from "../src/options.js";
import { TrackerPlugin } from "../src/plugin.js";
import { TrackerStore } from "../src/store.js";

function fixture(): { directory: string; store: TrackerStore } {
  const directory = mkdtempSync(join(tmpdir(), "tracker-attribution-"));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

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

describe("authoritative attribution transitions", () => {
  test("registers only the approved mutation tool surface", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-tools-"));
    const registered: { name: string }[] = [];
    const context = {
      options: { dataDir: directory },
      session: {
        hook: async () => ({ dispose: async () => undefined }),
        get: async () => ({ id: "root", parentID: undefined, agent: "orchestrator" }),
      },
      tool: {
        transform: async (callback: (tools: { add: (tool: { name: string }) => void }) => void) => {
          callback({ add: (tool) => registered.push(tool) });
          return { dispose: async () => undefined };
        },
      },
      event: {
        subscribe: async function* () {
          /* No lifecycle events in this registration test. */
        },
      },
    };
    const cleanup = await TrackerPlugin.setup(context as never);
    expect(registered.map((tool) => tool.name)).toEqual([
      "tracking_bead_created",
      "tracking_bead_select",
      "tracking_closeout",
    ]);
    if (typeof cleanup === "function") await cleanup();
    rmSync(directory, { recursive: true, force: true });
  });

  test("uses bounded argv validation and exact canonical matching", async () => {
    const calls: string[][] = [];
    const bead = await validateAuthoritativeBead("bead-alpha", async (argv) => {
      calls.push([...argv]);
      return JSON.stringify([{ id: "bead-alpha", issue_type: "task", parent: null }]);
    });
    expect(calls).toEqual([["show", "bead-alpha", "--json"]]);
    expect(bead).toEqual({ beadID: "bead-alpha", type: "task" });

    try {
      await validateAuthoritativeBead("bead-alpha", async () =>
        JSON.stringify([
          { id: "bead-alpha", issue_type: "task" },
          { id: "bead-other", issue_type: "task" },
        ]),
      );
      throw new Error("expected validation failure");
    } catch (error) {
      expect((error as Error).message).toBe("authoritative Bead validation failed");
    }
    try {
      await validateAuthoritativeBead("bead-alpha", async () =>
        JSON.stringify([{ id: "bead-alpha", issue_type: "todo" }]),
      );
      throw new Error("expected validation failure");
    } catch (error) {
      expect((error as Error).message).toBe("authoritative Bead validation failed");
    }
  });

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
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
    selected.store.close();
    rmSync(selected.directory, { recursive: true, force: true });

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
    closed.store.close();
    rmSync(closed.directory, { recursive: true, force: true });
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
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
