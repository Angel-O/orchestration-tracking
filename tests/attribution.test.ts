import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { generateReport } from "../src/report.js";
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

function fakeWbd(directory: string, output: string): void {
  const command = join(directory, "wbd");
  writeFileSync(command, `#!/bin/sh\nprintf '%s' '${output}'\n`);
  chmodSync(command, 0o700);
}

describe("authoritative attribution transitions", () => {
  test("registers only the approved tracker tool surface", async () => {
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
      "tracking_report",
    ]);
    if (typeof cleanup === "function") await cleanup();
    rmSync(directory, { recursive: true, force: true });
  });

  test("regenerates reports through the real closeout tool path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-closeout-report-"));
    fakeWbd(directory, '{"id":"bead-close","issue_type":"task"}');
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    let promptHook:
      | ((event: { readonly sessionID: string; readonly messageID: string }) => Promise<void>)
      | undefined;
    const registered: Array<{
      readonly name: string;
      readonly execute?: (args: unknown, context: unknown) => Promise<{ output: unknown }>;
    }> = [];
    const context = {
      options: { dataDir: directory },
      session: {
        hook: async (
          _name: string,
          callback: (event: { sessionID: string; messageID: string }) => Promise<void>,
        ) => {
          promptHook = callback;
          return { dispose: async () => undefined };
        },
        get: async () => ({ id: "root", parentID: undefined, agent: "orchestrator" }),
      },
      tool: {
        transform: async (
          callback: (tools: { add: (tool: (typeof registered)[number]) => void }) => void,
        ) => {
          callback({ add: (tool) => registered.push(tool) });
          return { dispose: async () => undefined };
        },
      },
      event: { subscribe: async function* () {} },
      reportViewerOptions: { launch: () => false },
    };
    const cleanup = await TrackerPlugin.setup(context as never);
    try {
      if (!promptHook) throw new Error("prompt hook was not registered");
      await promptHook({ sessionID: "root", messageID: "message-1" });
      const closeout = registered.find((tool) => tool.name === "tracking_closeout");
      if (!closeout?.execute) throw new Error("closeout tool was not registered");
      const result = await closeout.execute(
        { beadID: "bead-close" },
        { sessionID: "root", toolCallID: "closeout-call" },
      );
      const firstOutput = result.output as {
        ok: boolean;
        changed: boolean;
        viewer: { url: string; expiresAt: number; browserOpened: boolean };
      };
      expect(firstOutput.ok).toBe(true);
      expect(firstOutput.changed).toBe(true);
      expect(firstOutput.viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/report\//u);
      expect(typeof firstOutput.viewer.expiresAt).toBe("number");
      expect(firstOutput.viewer.browserOpened).toBe(false);
      const viewerURL = firstOutput.viewer.url;
      expect(await (await fetch(viewerURL)).text()).toContain("bead-close");
      const replay = await closeout.execute(
        { beadID: "bead-close" },
        { sessionID: "root", toolCallID: "closeout-replay" },
      );
      const replayOutput = replay.output as {
        ok: boolean;
        changed: boolean;
        viewer: { url: string; browserOpened: boolean };
      };
      expect(replayOutput.ok).toBe(true);
      expect(replayOutput.changed).toBe(false);
      expect(replayOutput.viewer.browserOpened).toBe(false);
      expect(await (await fetch(replayOutput.viewer.url)).text()).toContain("bead-close");
      expect(existsSync(join(directory, "reports"))).toBe(true);
      const files = readdirSync(join(directory, "reports"));
      expect(files).toHaveLength(2);
      expect(files.some((file) => file.endsWith(".json"))).toBe(true);
      expect(files.some((file) => file.endsWith(".md"))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (typeof cleanup === "function") cleanup();
      const store = TrackerStore.open(parseOptions({ dataDir: directory }));
      expect(store.listCloseouts().map(({ beadID, kind }) => [beadID, kind])).toEqual([
        ["bead-close", "concrete"],
      ]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("continues delivery when closeout report regeneration fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-closeout-report-failure-"));
    fakeWbd(directory, '{"id":"bead-fail","issue_type":"task"}');
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    let promptHook:
      | ((event: { readonly sessionID: string; readonly messageID: string }) => Promise<void>)
      | undefined;
    const registered: Array<{
      readonly name: string;
      readonly execute?: (args: unknown, context: unknown) => Promise<{ output: unknown }>;
    }> = [];
    const context = {
      options: { dataDir: directory },
      session: {
        hook: async (
          _name: string,
          callback: (event: { sessionID: string; messageID: string }) => Promise<void>,
        ) => {
          promptHook = callback;
          return { dispose: async () => undefined };
        },
        get: async () => ({ id: "root", parentID: undefined, agent: "orchestrator" }),
      },
      tool: {
        transform: async (
          callback: (tools: { add: (tool: (typeof registered)[number]) => void }) => void,
        ) => {
          callback({ add: (tool) => registered.push(tool) });
          return { dispose: async () => undefined };
        },
      },
      event: { subscribe: async function* () {} },
      reportViewerOptions: { launch: () => false },
    };
    const cleanup = await TrackerPlugin.setup(context as never);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      if (!promptHook) throw new Error("prompt hook was not registered");
      await promptHook({ sessionID: "root", messageID: "message-1" });
      writeFileSync(join(directory, "reports"), "not-a-directory");
      const closeout = registered.find((tool) => tool.name === "tracking_closeout");
      if (!closeout?.execute) throw new Error("closeout tool was not registered");
      const result = await closeout.execute(
        { beadID: "bead-fail" },
        { sessionID: "root", toolCallID: "closeout-call" },
      );
      const output = result.output as {
        ok: boolean;
        changed: boolean;
        viewer: { url: string; browserOpened: boolean };
      };
      expect(output.ok).toBe(true);
      expect(output.changed).toBe(true);
      expect(output.viewer.browserOpened).toBe(false);
      expect((await fetch(output.viewer.url)).status).toBe(200);
      expect(warnings.join(" ")).toContain(
        "closeout report regeneration failed; delivery continues",
      );
      expect(warnings.join(" ")).not.toContain("bead-fail");
      expect(warnings.join(" ")).not.toContain(directory);
    } finally {
      console.warn = originalWarn;
      process.env.PATH = originalPath;
      if (typeof cleanup === "function") cleanup();
      const store = TrackerStore.open(parseOptions({ dataDir: directory }));
      expect(store.listCloseouts().map(({ beadID, kind }) => [beadID, kind])).toEqual([
        ["bead-fail", "concrete"],
      ]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
      store.close();
      rmSync(directory, { recursive: true, force: true });
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
      store.close();
      rmSync(directory, { recursive: true, force: true });
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
          .map(({ sessionID, beadID, associationSource }) => [
            sessionID,
            beadID,
            associationSource,
          ]),
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
      store.close();
      rmSync(directory, { recursive: true, force: true });
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
