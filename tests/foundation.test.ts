import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseOptions } from "../src/options.js";
import { TrackerPlugin } from "../src/plugin.js";
import { DATABASE_FILENAME, TrackerStore } from "../src/store.js";

function fixture(): { directory: string; store: TrackerStore } {
  const directory = mkdtempSync(join(tmpdir(), "tracker-foundation-"));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

function cleanup(directory: string, store: TrackerStore): void {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

describe("clean-break private tracker foundation", () => {
  test("creates only the new protected schema and never opens the legacy file", () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-schema-"));
    writeFileSync(join(directory, "tracker-v2.sqlite"), "legacy prompt response transcript");
    const store = TrackerStore.open(parseOptions({ dataDir: directory }));
    const databasePath = join(directory, DATABASE_FILENAME);
    expect(existsSync(databasePath)).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    expect(
      database.query<{ journal_mode: string }>("PRAGMA journal_mode").get()?.journal_mode,
    ).toBe("wal");
    expect(database.query("PRAGMA foreign_key_list(actions)").all()).not.toHaveLength(0);
    expect(
      database.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version,
    ).toBe(1);
    const tables = database
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "actions",
      "activity_slices",
      "association_receipts",
      "beads",
      "closeouts",
      "lifecycle_receipts",
      "reports",
      "session_attributions",
      "sessions",
      "sqlite_sequence",
    ]);
    database.close();
    expect(readFileSync(join(directory, "tracker-v2.sqlite"), "utf8")).toContain("legacy prompt");
    cleanup(directory, { close: () => undefined } as TrackerStore);
  });

  test("replays actions and terminal receipts without duplication", () => {
    const { directory, store } = fixture();
    store.recordSession({ sessionID: "session-1", observedAt: 100 });
    const first = store.startAction({
      sessionID: "session-1",
      actionID: "message-1",
      observedRole: "worker",
      startedAt: 100,
    });
    const replay = store.startAction({
      sessionID: "session-1",
      actionID: "message-1",
      observedRole: "reviewer",
      startedAt: 101,
    });
    expect(replay).toEqual(first);
    expect(
      store.endAction({
        eventID: "event-1",
        aggregateID: "action-stream",
        sequence: 1,
        sessionID: "session-1",
        actionID: "message-1",
        outcome: "completed",
        endedAt: 200,
      }),
    ).toBe(true);
    expect(
      store.endAction({
        eventID: "event-1",
        aggregateID: "action-stream",
        sequence: 1,
        sessionID: "session-1",
        actionID: "message-1",
        outcome: "failed",
        endedAt: 201,
      }),
    ).toBe(false);
    expect(store.listActions()).toEqual([
      {
        sessionID: "session-1",
        actionID: "message-1",
        passNumber: 1,
        observedRole: "worker",
        phaseKey: "implementation",
        phaseLabel: "Implementation",
        repeatEligible: true,
        startedAt: 100,
        endedAt: 200,
        outcome: "completed",
        startReceiptID: null,
      },
    ]);
    expect(store.listActivitySlices()).toEqual([
      {
        sliceID: 1,
        actionID: "message-1",
        sessionID: "session-1",
        beadID: null,
        associationSource: null,
        startedAt: 100,
        endedAt: 200,
      },
    ]);
    cleanup(directory, store);
  });

  test("does not recover a live action when a second store opens", () => {
    const { directory, store } = fixture();
    store.startAction({
      sessionID: "session-1",
      actionID: "message-1",
      startedAt: 100,
      receiptID: "start-1",
    });
    const second = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(second.listActions()[0]).toEqual({
      sessionID: "session-1",
      actionID: "message-1",
      passNumber: 1,
      observedRole: "unknown",
      phaseKey: "unmapped",
      phaseLabel: "Unmapped",
      repeatEligible: false,
      startedAt: 100,
      endedAt: null,
      outcome: "open",
      startReceiptID: "start-1",
    });
    second.close();
    cleanup(directory, store);
  });

  test("captures privacy-safe session labels and first-observation fact snapshots", () => {
    const { directory, store } = fixture();
    const initial = parseOptions({
      dataDir: directory,
      phaseMappings: {
        worker: { phaseKey: "custom-work", phaseLabel: "Custom work", repeatEligible: false },
      },
    });
    store.close();
    const configured = TrackerStore.open(initial);
    configured.recordSession({
      sessionID: "session-1",
      observedAt: 100,
      projectLabel: "project-one",
    });
    expect(
      configured.recordSession({
        sessionID: "session-1",
        observedAt: 200,
        projectLabel: "project-two",
      }),
    ).toMatchObject({ projectLabel: "project-one" });
    const first = configured.startAction({
      sessionID: "session-1",
      actionID: "message-1",
      observedRole: "worker",
      startedAt: 100,
    });
    const second = configured.startAction({
      sessionID: "session-1",
      actionID: "message-2",
      observedRole: "unknown-agent",
      startedAt: 200,
    });
    const replay = configured.startAction({
      sessionID: "session-1",
      actionID: "message-1",
      observedRole: "reviewer",
      startedAt: 300,
    });
    expect(first).toMatchObject({
      passNumber: 1,
      phaseKey: "custom-work",
      phaseLabel: "Custom work",
      repeatEligible: false,
    });
    expect(second).toMatchObject({
      passNumber: 2,
      phaseKey: "unmapped",
      phaseLabel: "Unmapped",
      repeatEligible: false,
    });
    expect(replay).toEqual(first);
    expect(configured.readReportSnapshot()).toMatchObject({
      sessions: [{ sessionID: "session-1", projectLabel: "project-one" }],
      actions: [
        { actionID: "message-1", passNumber: 1, phaseKey: "custom-work" },
        { actionID: "message-2", passNumber: 2, phaseKey: "unmapped" },
      ],
    });
    expect(() =>
      configured.recordSession({
        sessionID: "session-2",
        projectLabel: "/private/project",
        observedAt: 1,
      }),
    ).toThrow(/private label/);
    configured.close();

    const changed = TrackerStore.open(
      parseOptions({
        dataDir: directory,
        phaseMappings: {
          worker: { phaseKey: "changed-work", phaseLabel: "Changed work", repeatEligible: true },
        },
      }),
    );
    const later = changed.startAction({
      sessionID: "session-1",
      actionID: "message-3",
      observedRole: "worker",
      startedAt: 400,
    });
    expect(later).toMatchObject({
      passNumber: 3,
      phaseKey: "changed-work",
      phaseLabel: "Changed work",
      repeatEligible: true,
    });
    expect(changed.listActions()[0]).toMatchObject({
      actionID: "message-1",
      phaseKey: "custom-work",
      repeatEligible: false,
    });
    cleanup(directory, changed);
  });

  test("recovers only explicitly identified stale actions with host receipts", () => {
    const { directory, store } = fixture();
    store.startAction({
      sessionID: "session-1",
      actionID: "message-1",
      startedAt: 100,
      receiptID: "start-1",
    });
    expect(
      store.recoverStaleActions([{ sessionID: "session-1", actionID: "message-1" }], {
        eventID: "deleted-1",
        aggregateID: "session-1",
        sequence: 1,
        eventType: "session.deleted",
        observedAt: 200,
      }),
    ).toBe(1);
    expect(store.listActions()[0]).toMatchObject({ outcome: "incomplete", endedAt: null });
    expect(
      store.listLifecycleReceipts().find((receipt) => receipt.eventID === "deleted-1"),
    ).toEqual({
      eventID: "deleted-1",
      aggregateID: "session-1",
      sequence: 1,
      eventType: "session.deleted",
      observedAt: 200,
    });
    expect(
      store.recoverStaleActions([{ sessionID: "session-1", actionID: "message-1" }], {
        eventID: "deleted-1",
        aggregateID: "session-1",
        sequence: 1,
        eventType: "session.deleted",
        observedAt: 201,
      }),
    ).toBe(0);
    cleanup(directory, store);
  });

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
    cleanup(directory, store);
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
    cleanup(directory, store);
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
    cleanup(directory, store);
  });

  test("observes prompt actions through the plugin without persisting host payloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-plugin-"));
    let promptHook:
      | ((event: { readonly sessionID: string; readonly messageID: string }) => Promise<void>)
      | undefined;
    let releaseEvent!: (event: unknown) => void;
    const context = {
      options: { dataDir: directory },
      location: {
        directory: "/private/project-worktree",
        project: { directory: "/private/project-worktree" },
      },
      session: {
        hook: async (
          _name: string,
          callback: (event: { sessionID: string; messageID: string }) => Promise<void>,
        ) => {
          promptHook = callback;
          return { dispose: async () => undefined };
        },
        get: async () => ({ id: "session-1", agent: "worker" }),
      },
      event: {
        subscribe: async function* () {
          yield await new Promise<unknown>((resolve) => {
            releaseEvent = resolve;
          });
        },
      },
    };
    const cleanupPlugin = await TrackerPlugin.setup(context as never);
    if (!promptHook) throw new Error("prompt hook was not registered");
    await promptHook({ sessionID: "session-1", messageID: "message-1" });
    releaseEvent({
      id: "deleted-1",
      type: "session.deleted",
      created: 200,
      data: { sessionID: "session-1" },
      durable: { aggregateID: "session-1", seq: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const store = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(store.listActions()).toHaveLength(1);
    expect(store.listSessions()[0]?.projectLabel).toBe("project-worktree");
    expect(store.listActions()[0]?.observedRole).toBe("worker");
    expect(store.listActions()[0]?.outcome).toBe("incomplete");
    expect(store.listActions()[0]?.endedAt).toBe(null);
    expect(
      store.listLifecycleReceipts().find((receipt) => receipt.eventID === "deleted-1"),
    ).toEqual({
      eventID: "deleted-1",
      aggregateID: "session-1",
      sequence: 1,
      eventType: "session.deleted",
      observedAt: 200,
    });
    store.close();
    if (typeof cleanupPlugin === "function") cleanupPlugin();
    rmSync(directory, { recursive: true, force: true });
  });
});
