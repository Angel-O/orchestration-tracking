import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { TrackerPlugin } from "../src/plugin.js";
import {
  DEFAULT_PHASE_MAPPINGS,
  mappingFor,
  parseOptions,
} from "../src/options.js";
import { TrackerStore } from "../src/store.js";

const WorkerConstructor = (globalThis as any).Worker as new (url: string, options: { type: "module" }) => {
  onmessage: ((event: MessageEvent<{ type: string; value?: unknown }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(value: unknown): void;
  terminate(): void;
};

function temporaryStore(): { store: TrackerStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "orchestration-tracker-"));
  const store = TrackerStore.open(parseOptions({ dataDir: directory }));
  return { store, directory };
}

function session(sessionID = "session-1", parentID?: string) {
  return {
    sessionID,
    parentID,
    projectID: "project-1",
    workspaceID: "workspace-1",
    projectLabel: "workspace-safe",
  };
}

describe("options and plugin compatibility", () => {
  test("exports a source-loadable V2 Promise plugin", () => {
    expect(TrackerPlugin.id).toBe("orchestration-tracking");
    expect(typeof TrackerPlugin.setup).toBe("function");
  });

  test("invalid configuration is inert at the plugin boundary", async () => {
    const setup = await TrackerPlugin.setup({ options: { dataDir: "relative" } } as never);
    expect(setup).toBeUndefined();
  });

  test("preserves the approved default mapping contract", () => {
    const options = parseOptions({ dataDir: "/private/tracker" });
    expect(options.schemaVersion).toBe(1);
    expect(options.phaseMappings).toEqual(DEFAULT_PHASE_MAPPINGS);
    expect(mappingFor(options, "plan").phaseKey).toBe("planning");
    expect(mappingFor(options, "planner").phaseKey).toBe("architecture-decomposition");
    expect(mappingFor(options, "architect").phaseKey).toBe("architecture-decomposition");
    expect(mappingFor(options, "investigator")).toMatchObject({ phaseKey: "investigation", phaseLabel: "Investigation" });
    expect(mappingFor(options, "worker")).toMatchObject({ phaseKey: "implementation", phaseLabel: "Implementation" });
    expect(mappingFor(options, "reviewer")).toMatchObject({ phaseKey: "review", phaseLabel: "Review" });
    expect(mappingFor(options, "integration")).toMatchObject({ phaseKey: "integration", phaseLabel: "Integration validation" });
    expect(mappingFor(options, "build")).toMatchObject({ phaseKey: "build-direct", phaseLabel: "Build (Direct)" });
    expect(mappingFor(options, "orchestrator").repeatEligible).toBe(false);
    expect(mappingFor(options, "unlisted-agent").phaseKey).toBe("unmapped");
  });

  test("rejects invalid schema and relative storage paths", () => {
    expect(() => parseOptions({ schemaVersion: 2 })).toThrow();
    expect(() => parseOptions({ dataDir: "relative" })).toThrow();
    expect(() => parseOptions({ phaseMappings: {
      orchestrator: { phaseKey: "coordination", phaseLabel: "Coordination", repeatEligible: true },
    } })).toThrow();
  });
});

describe("SQLite lifecycle core", () => {
  test("migrates, enables required pragmas, and rejects newer schemas", () => {
    const { store, directory } = temporaryStore();
    const db = new Database(join(directory, "tracker.sqlite"), { readonly: true });
    expect(db.query<{ journal_mode: string }>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query("PRAGMA foreign_key_list(passes)").all()).not.toHaveLength(0);
    expect(db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version).toBe(3);
    db.close();
    store.close();

    const newerDirectory = mkdtempSync(join(tmpdir(), "orchestration-tracker-newer-"));
    const newer = new Database(join(newerDirectory, "tracker.sqlite"));
    newer.exec("PRAGMA user_version = 99");
    newer.close();
    expect(() => TrackerStore.open(parseOptions({ dataDir: newerDirectory }))).toThrow(/newer/);

    rmSync(directory, { recursive: true, force: true });
    rmSync(newerDirectory, { recursive: true, force: true });
  });

  test("snapshots mappings and keeps duplicate prompt admission idempotent", () => {
    const { store, directory } = temporaryStore();
    const first = store.admit({ ...session(), messageID: "message-1", agent: "plan", startedAt: 100 });
    const replay = store.admit({ ...session(), messageID: "message-1", agent: "worker", startedAt: 101 });
    const second = store.admit({ ...session(), messageID: "message-2", agent: "planner", startedAt: 102 });
    const unknown = store.admit({ ...session(), messageID: "message-3", agent: "new-agent", startedAt: 103 });

    expect(replay.id).toBe(first.id);
    expect(first.phaseKey).toBe("planning");
    expect(second.phaseKey).toBe("architecture-decomposition");
    expect(unknown.phaseKey).toBe("unmapped");
    expect(store.listPasses()).toHaveLength(3);
    expect(store.listPasses()[0]?.startedAt).toBe(100);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("deduplicates and orders durable execution receipts", () => {
    const { store, directory } = temporaryStore();
    store.admit({ ...session(), messageID: "message-1", agent: "worker", startedAt: 100 });
    expect(store.closeExecution({
      eventID: "event-2",
      aggregateID: "aggregate-1",
      sequence: 2,
      sessionID: "session-1",
      outcome: "completed",
      endedAt: 200,
    })).toBe(true);
    expect(store.closeExecution({
      eventID: "event-2",
      aggregateID: "aggregate-1",
      sequence: 2,
      sessionID: "session-1",
      outcome: "failed",
      endedAt: 201,
    })).toBe(false);
    store.admit({ ...session(), messageID: "message-2", agent: "worker", startedAt: 300 });
    expect(store.closeExecution({
      eventID: "old-event",
      aggregateID: "aggregate-1",
      sequence: 1,
      sessionID: "session-1",
      outcome: "failed",
      endedAt: 301,
    })).toBe(false);
    expect(store.listPasses()[1]?.outcome).toBe("open");
    expect(store.closeExecution({
      eventID: "event-3",
      aggregateID: "aggregate-1",
      sequence: 3,
      sessionID: "session-1",
      outcome: "interrupted",
      endedAt: 400,
    })).toBe(true);
    expect(store.listPasses()[1]?.outcome).toBe("interrupted");
    expect(store.listReceipts()).toHaveLength(2);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a delayed earlier terminal event cannot close a later pass", () => {
    const { store, directory } = temporaryStore();
    store.admit({ ...session(), messageID: "message-1", agent: "worker", startedAt: 100 });
    store.admit({ ...session(), messageID: "message-2", agent: "worker", startedAt: 300 });

    expect(store.closeExecution({
      eventID: "delayed-event-1",
      aggregateID: "aggregate-1",
      sequence: 1,
      sessionID: "session-1",
      outcome: "completed",
      endedAt: 200,
    })).toBe(true);
    expect(store.listPasses().map((pass) => pass.outcome)).toEqual(["completed", "open"]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("recovery marks open passes incomplete without inventing an end time", () => {
    const { store, directory } = temporaryStore();
    store.admit({ ...session(), messageID: "message-1", agent: "worker", startedAt: 100 });
    expect(store.recoverOpenPasses()).toBe(1);
    expect(store.listPasses()[0]).toMatchObject({ outcome: "incomplete", endedAt: null });
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("serializes concurrent receipt writers and stores no prohibited content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orchestration-tracker-concurrent-"));
    const options = parseOptions({ dataDir: directory });
    const store = TrackerStore.open(options);
    store.admit({ ...session(), messageID: "message-1", agent: "worker", startedAt: 100 });
    store.close();

    const barrier = new SharedArrayBuffer(8);
    const control = new Int32Array(barrier);
    const startWorker = (sequence: number) => {
      const worker = new WorkerConstructor(new URL("./concurrent-receipt.worker.ts", import.meta.url).href, { type: "module" });
      let ready!: () => void;
      let done!: (value: unknown) => void;
      let fail!: (error: unknown) => void;
      const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
      const donePromise = new Promise<unknown>((resolve, reject) => { done = resolve; fail = reject; });
      worker.onmessage = (event) => {
        if (event.data.type === "ready") ready();
        if (event.data.type === "done") done(event.data.value);
      };
      worker.onerror = fail;
      worker.postMessage({ directory, sequence, barrier });
      return { worker, readyPromise, donePromise };
    };
    // Open the connections one at a time; only the terminal writes are synchronized.
    // This isolates receipt interleaving from one-time WAL setup.
    const firstWorker = startWorker(1);
    await firstWorker.readyPromise;
    const secondWorker = startWorker(2);
    await secondWorker.readyPromise;
    const workers = [firstWorker, secondWorker];
    Atomics.store(control, 1, 1);
    Atomics.notify(control, 1, 2);
    await Promise.all(workers.map(({ donePromise }) => donePromise));
    for (const { worker } of workers) worker.terminate();

    const reader = TrackerStore.open(options);
    expect(reader.listPasses()).toHaveLength(1);
    const sessions = reader.listSessions();
    expect(JSON.stringify(sessions)).not.toContain(directory);
    expect(JSON.stringify(sessions)).not.toMatch(/prompt|response|transcript|token|tool_payload|git/i);
    expect([1, 2]).toContain(reader.listReceipts().length);
    expect(reader.listPasses()[0]?.outcome).toBe("completed");
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
