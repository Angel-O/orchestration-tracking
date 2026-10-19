import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import { LAUNCH_METADATA_KEY, TrackerPlugin } from "../src/plugin.js";
import { TrackerStore } from "../src/store.js";

type TestSession = {
  id: string;
  parentID?: string;
  projectID: string;
  agent?: string;
  metadata?: Record<string, unknown>;
};

async function fixture(initial: Record<string, TestSession> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tracker-launch-descriptor-"));
  const sessions = { ...initial };
  const registered: any[] = [];
  const updates: Array<{ sessionID: string; metadata: Record<string, unknown> }> = [];
  let updateFails = false;
  let promptHook: ((event: { sessionID: string; messageID: string }) => Promise<void>) | undefined;
  const context = {
    options: { dataDir: directory },
    location: { directory: "/safe/workspace", project: { id: "project-safe" }, workspaceID: "workspace-safe" },
    session: {
      hook: async (_name: string, callback: (event: { sessionID: string; messageID: string }) => Promise<void>) => {
        promptHook = callback;
        return { dispose: async () => undefined };
      },
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
      update: async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => {
        if (updateFails) throw new Error("metadata update failed");
        updates.push({ sessionID, metadata });
        sessions[sessionID]!.metadata = metadata;
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
        callback({ add: (tool) => registered.push(tool) });
        return { dispose: async () => undefined };
      },
    },
    event: { subscribe: async function* () { /* no lifecycle events in this contract test */ } },
  };
  const cleanup = await TrackerPlugin.setup(context as never);
  const prompt = async (sessionID: string, messageID = `message-${sessionID}`) => {
    if (!promptHook) throw new Error("prompt hook was not registered");
    await promptHook({ sessionID, messageID });
  };
  const startRun = (beadID: string, sessionID = "root") => registered[0].execute({ beadID }, { sessionID });
  const closeout = (beadID: string) => registered[2].execute({ beadID }, {});
  return { directory, sessions, updates, setUpdateFailure: (value: boolean) => { updateFails = value; }, startRun, closeout, prompt, cleanup };
}

function readAssociations(directory: string, runID: string) {
  const store = TrackerStore.open(parseOptions({ dataDir: directory }));
  const result = { associations: store.listRunSessions(runID), passes: store.listPasses() };
  store.close();
  return result;
}

async function dispose(testFixture: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  if (typeof testFixture.cleanup === "function") await testFixture.cleanup();
  rmSync(testFixture.directory, { recursive: true, force: true });
}

const primary = (descriptor: unknown): TestSession => ({
  id: "primary",
  projectID: "project-safe",
  agent: "worker",
  metadata: { keep: "this", [LAUNCH_METADATA_KEY]: descriptor },
});

describe("deterministic primary launch descriptors", () => {
  test("attaches the exact session using its fetched agent and removes only the descriptor", async () => {
    const testFixture = await fixture({
      root: { id: "root", projectID: "project-safe", agent: "orchestrator" },
      primary: primary({ version: 1, targetSessionID: "primary", beadID: "bead-valid" }),
    });
    try {
      const run = await testFixture.startRun("bead-valid");
      await testFixture.prompt("primary");
      expect(testFixture.sessions.primary?.metadata).toEqual({ keep: "this" });
      expect(testFixture.updates).toHaveLength(1);
      const result = readAssociations(testFixture.directory, run.output.runID);
      expect(result.associations.some((item) => item.sessionID === "primary" && item.source === "explicit-primary")).toBe(true);
      expect(result.passes.find((pass) => pass.sessionID === "primary")?.observedAgent).toBe("worker");
    } finally {
      await dispose(testFixture);
    }
  });

  test("is idempotent when the same prompt is observed twice", async () => {
    const testFixture = await fixture({
      root: { id: "root", projectID: "project-safe", agent: "orchestrator" },
      primary: primary({ version: 1, targetSessionID: "primary", beadID: "bead-duplicate" }),
    });
    try {
      const run = await testFixture.startRun("bead-duplicate");
      await testFixture.prompt("primary", "same-message");
      await testFixture.prompt("primary", "same-message");
      const result = readAssociations(testFixture.directory, run.output.runID);
      expect(result.associations.filter((item) => item.sessionID === "primary")).toEqual([{ sessionID: "primary", source: "explicit-primary" }]);
      expect(result.passes.filter((pass) => pass.sessionID === "primary")).toHaveLength(1);
      expect(testFixture.updates).toHaveLength(1);
    } finally {
      await dispose(testFixture);
    }
  });

  async function expectConsumed(descriptor: unknown): Promise<void> {
    const testFixture = await fixture({ root: { id: "root", projectID: "project-safe", agent: "orchestrator" }, primary: primary(descriptor) });
    try {
      await testFixture.prompt("primary");
      expect(testFixture.sessions.primary?.metadata).toEqual({ keep: "this" });
      expect(readAssociations(testFixture.directory, "missing-run").passes).toHaveLength(1);
    } finally {
      await dispose(testFixture);
    }
  }

  test("consumes malformed descriptors without blocking pass recording", async () => {
    await expectConsumed({ version: 1, targetSessionID: "primary", beadID: "bead-malformed", extra: true });
  });

  test("consumes unsupported descriptors without blocking pass recording", async () => {
    await expectConsumed({ version: 2, targetSessionID: "primary", beadID: "bead-unsupported" });
  });

  test("removes mismatched inherited metadata while retaining parent-chain association", async () => {
    const testFixture = await fixture({
      root: { id: "root", projectID: "project-safe", agent: "orchestrator" },
      child: { ...primary({ version: 1, targetSessionID: "root", beadID: "bead-inherited" }), id: "child", parentID: "root", agent: "planner" },
    });
    try {
      const run = await testFixture.startRun("bead-inherited");
      await testFixture.prompt("child");
      expect(testFixture.sessions.child?.metadata).toEqual({ keep: "this" });
      expect(readAssociations(testFixture.directory, run.output.runID).associations.some((item) => item.sessionID === "child" && item.source === "parent-chain")).toBe(true);
    } finally {
      await dispose(testFixture);
    }
  });

  test("does not explicitly attach a non-target session", async () => {
    const testFixture = await fixture({
      root: { id: "root", projectID: "project-safe", agent: "orchestrator" },
      primary: primary({ version: 1, targetSessionID: "another-session", beadID: "bead-mismatch" }),
    });
    try {
      const run = await testFixture.startRun("bead-mismatch");
      await testFixture.prompt("primary");
      const result = readAssociations(testFixture.directory, run.output.runID);
      expect(result.associations.some((item) => item.sessionID === "primary")).toBe(false);
      expect(testFixture.sessions.primary?.metadata).toEqual({ keep: "this" });
    } finally {
      await dispose(testFixture);
    }
  });

  test("requires the fetched session agent before explicit attachment", async () => {
    const testFixture = await fixture({
      root: { id: "root", projectID: "project-safe", agent: "orchestrator" },
      primary: { ...primary({ version: 1, targetSessionID: "primary", beadID: "bead-no-agent" }), agent: undefined },
    });
    try {
      const run = await testFixture.startRun("bead-no-agent");
      await testFixture.prompt("primary");
      const result = readAssociations(testFixture.directory, run.output.runID);
      expect(result.associations.some((item) => item.sessionID === "primary")).toBe(false);
      expect(result.passes.find((pass) => pass.sessionID === "primary")?.observedAgent).toBe(null);
      expect(testFixture.sessions.primary?.metadata).toEqual({ keep: "this" });
    } finally {
      await dispose(testFixture);
    }
  });

  test("consumes missing-run and finalized-run descriptors", async () => {
    const missing = await fixture({ root: { id: "root", projectID: "project-safe", agent: "orchestrator" }, primary: primary({ version: 1, targetSessionID: "primary", beadID: "bead-missing" }) });
    try {
      await missing.prompt("primary");
      expect(missing.sessions.primary?.metadata).toEqual({ keep: "this" });
    } finally {
      await dispose(missing);
    }

    const finalized = await fixture({ root: { id: "root", projectID: "project-safe", agent: "orchestrator" }, primary: primary({ version: 1, targetSessionID: "primary", beadID: "bead-finalized" }) });
    try {
      await finalized.startRun("bead-finalized");
      expect((await finalized.closeout("bead-finalized")).output.status).toBe("finalized");
      await finalized.prompt("primary");
      expect(finalized.sessions.primary?.metadata).toEqual({ keep: "this" });
      expect(readAssociations(finalized.directory, "missing-run").passes).toHaveLength(1);
    } finally {
      await dispose(finalized);
    }
  });

  test("keeps descriptor failures nonblocking and diagnostics content-free", async () => {
    const testFixture = await fixture({ root: { id: "root", projectID: "project-safe", agent: "orchestrator" }, primary: primary({ version: 1, targetSessionID: "primary", beadID: "bead-private" }) });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      (testFixture.sessions.primary as TestSession).metadata = { [LAUNCH_METADATA_KEY]: { version: 1, targetSessionID: "primary", beadID: "bead-private" } };
      testFixture.setUpdateFailure(true);
      await testFixture.prompt("primary");
      expect(readAssociations(testFixture.directory, "missing-run").passes).toHaveLength(1);
      expect(warnings.join(" ")).toContain("launch descriptor ignored; delivery continues");
      expect(warnings.join(" ")).toContain("launch descriptor removal failed; delivery continues");
      expect(warnings.join(" ")).not.toContain("bead-private");
    } finally {
      console.warn = originalWarn;
      await dispose(testFixture);
    }
  });
});
