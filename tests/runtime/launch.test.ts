import { fakeWbd } from "../support/fake-wbd.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseOptions } from "../../src/config/options.js";
import { LAUNCH_METADATA_KEY, TrackerPlugin } from "../../src/plugin.js";
import { TrackerStore } from "../../src/store.js";

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
