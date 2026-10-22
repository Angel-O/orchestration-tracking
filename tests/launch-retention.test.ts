import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import { LAUNCH_METADATA_KEY, TrackerPlugin } from "../src/plugin.js";
import { TrackerStore, UNASSIGNED_RETENTION_MS } from "../src/store.js";

function fixture(): { directory: string; store: TrackerStore } {
  const directory = mkdtempSync(join(tmpdir(), "tracker-launch-retention-"));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

function dispose(directory: string, store: TrackerStore): void {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

function fakeWbd(directory: string, output: string, status = 0): void {
  const command = join(directory, "wbd");
  writeFileSync(command, `#!/bin/sh\nprintf '%s' '${output}'\nexit ${status}\n`);
  chmodSync(command, 0o700);
}

async function observePrompt(
  directory: string,
  session: { id: string; metadata: Record<string, unknown> },
): Promise<void> {
  let promptHook: ((event: { sessionID: string; messageID: string }) => Promise<void>) | undefined;
  const context = {
    options: { dataDir: directory },
    session: {
      hook: async (_name: string, callback: typeof promptHook) => {
        promptHook = callback;
        return { dispose: async () => undefined };
      },
      get: async () => session,
    },
    event: { subscribe: async function* () {} },
  };
  const cleanup = await TrackerPlugin.setup(context as never);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    if (!promptHook) throw new Error("prompt hook was not registered");
    await promptHook({ sessionID: session.id, messageID: "message-1" });
  } finally {
    console.warn = originalWarn;
    if (typeof cleanup === "function") cleanup();
  }
}

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
    dispose(directory, store);
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
    dispose(directory, store);
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
    dispose(directory, store);
  }
});

test("admits a valid exact-session descriptor before the first action", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-plugin-launch-"));
  fakeWbd(directory, '{"id":"bead-launch","issue_type":"task"}');
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ""}`;

  const session = {
    id: "child",
    metadata: {
      keep: "value",
      [LAUNCH_METADATA_KEY]: { version: 1, targetSessionID: "child", beadID: "bead-launch" },
    } as Record<string, unknown>,
  };
  let promptHook: ((event: { sessionID: string; messageID: string }) => Promise<void>) | undefined;
  const updates: Array<Record<string, unknown>> = [];
  const context = {
    options: { dataDir: directory },
    session: {
      hook: async (_name: string, callback: typeof promptHook) => {
        promptHook = callback;
        return { dispose: async () => undefined };
      },
      get: async () => session,
      update: async ({ metadata }: { metadata: Record<string, unknown> }) => {
        updates.push(metadata);
        session.metadata = metadata;
      },
    },
    event: { subscribe: async function* () {} },
  };
  const cleanup = await TrackerPlugin.setup(context as never);
  try {
    if (!promptHook) throw new Error("prompt hook was not registered");
    await promptHook({ sessionID: "child", messageID: "message-1" });
    expect(updates).toEqual([{ keep: "value" }]);
  } finally {
    process.env.PATH = originalPath;
    if (typeof cleanup === "function") cleanup();
    const store = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(
      store.listActivitySlices().map(({ sessionID, beadID, associationSource }) => ({
        sessionID,
        beadID,
        associationSource,
      })),
    ).toEqual([
      { sessionID: "child", beadID: "bead-launch", associationSource: "launch-descriptor" },
    ]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaves recording unassociated when authoritative Hub validation is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-plugin-unavailable-"));
  fakeWbd(directory, "", 1);
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  const session = {
    id: "child",
    metadata: {
      [LAUNCH_METADATA_KEY]: { version: 1, targetSessionID: "child", beadID: "bead-unavailable" },
    },
  };
  try {
    await observePrompt(directory, session);
    const store = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(store.listActivitySlices().map(({ beadID }) => beadID)).toEqual([null]);
    store.close();
    expect(Object.hasOwn(session.metadata, LAUNCH_METADATA_KEY)).toBe(true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaves recording unassociated when authoritative topology conflicts locally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-plugin-conflict-"));
  const store = TrackerStore.open(parseOptions({ dataDir: directory }));
  store.recordTopology({ beadID: "bead-conflict", type: "task", validatedAt: 1 });
  store.close();
  fakeWbd(directory, '{"id":"bead-conflict","issue_type":"feature"}');
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  const session = {
    id: "child",
    metadata: {
      [LAUNCH_METADATA_KEY]: { version: 1, targetSessionID: "child", beadID: "bead-conflict" },
    },
  };
  try {
    await observePrompt(directory, session);
    const reopened = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(reopened.listActivitySlices().map(({ beadID }) => beadID)).toEqual([null]);
    reopened.close();
    expect(Object.hasOwn(session.metadata, LAUNCH_METADATA_KEY)).toBe(true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignores invalid descriptors without removing metadata or blocking recording", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-plugin-invalid-"));
  const session = {
    id: "child",
    metadata: { [LAUNCH_METADATA_KEY]: { version: 1, targetSessionID: "other", beadID: "bead" } },
  };
  let promptHook: ((event: { sessionID: string; messageID: string }) => Promise<void>) | undefined;
  const context = {
    options: { dataDir: directory },
    session: {
      hook: async (_name: string, callback: typeof promptHook) => {
        promptHook = callback;
        return { dispose: async () => undefined };
      },
      get: async () => session,
    },
    event: { subscribe: async function* () {} },
  };
  const cleanup = await TrackerPlugin.setup(context as never);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    if (!promptHook) throw new Error("prompt hook was not registered");
    await promptHook({ sessionID: "child", messageID: "message-1" });
  } finally {
    console.warn = originalWarn;
    if (typeof cleanup === "function") cleanup();
    const store = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(
      store.listActivitySlices().map(({ sessionID, beadID }) => ({ sessionID, beadID })),
    ).toEqual([{ sessionID: "child", beadID: null }]);
    store.close();
    expect(warnings.join(" ")).toContain("launch descriptor ignored; delivery continues");
    expect(warnings.join(" ")).not.toContain("bead");
    expect(Object.prototype.hasOwnProperty.call(session.metadata, LAUNCH_METADATA_KEY)).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
