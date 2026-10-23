import { fakeWbd } from "../support/fake-wbd.js";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseOptions } from "../../src/config/options.js";
import { TrackerPlugin } from "../../src/plugin.js";
import { TrackerStore } from "../../src/store.js";
import type { ReportViewerOptions } from "../../src/report-viewer.js";

type ReportTool = {
  readonly name: string;
  readonly execute?: (args: unknown, context?: unknown) => Promise<{ output: any }>;
};

function endAction(
  store: TrackerStore,
  sessionID: string,
  actionID: string,
  endedAt: number,
): void {
  store.endAction({
    eventID: `${actionID}-end`,
    aggregateID: sessionID,
    sequence: 1,
    sessionID,
    actionID,
    outcome: "completed",
    endedAt,
  });
}

async function setupReportTool(
  directory: string,
  reportViewerOptions: ReportViewerOptions = { launch: () => false },
): Promise<{
  readonly tools: readonly ReportTool[];
  readonly cleanup: unknown;
}> {
  const tools: ReportTool[] = [];
  const context = {
    options: { dataDir: directory },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      get: async () => ({ id: "unused", parentID: undefined, agent: "orchestrator" }),
    },
    tool: {
      transform: async (callback: (registered: { add: (tool: ReportTool) => void }) => void) => {
        callback({ add: (tool) => tools.push(tool) });
        return { dispose: async () => undefined };
      },
    },
    event: { subscribe: async function* () {} },
    reportViewerOptions,
  };
  return { tools, cleanup: await TrackerPlugin.setup(context as never) };
}

function reportTool(tools: readonly ReportTool[]): NonNullable<ReportTool["execute"]> {
  const tool = tools.find((candidate) => candidate.name === "tracking_report");
  if (!tool?.execute) throw new Error("report tool was not registered");
  return tool.execute;
}

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
    expect(warnings.join(" ")).toContain("closeout report regeneration failed; delivery continues");
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

test("disposal overlaps browser launch without registering a late viewer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-report-tool-overlap-"));
  let started!: () => void;
  let releaseLaunch!: (opened: boolean) => void;
  let launchedURL = "";
  const launchStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const launch = (url: string): Promise<boolean> => {
    launchedURL = url;
    started();
    return new Promise((resolve) => {
      releaseLaunch = resolve;
    });
  };
  const { tools, cleanup } = await setupReportTool(directory, { launch });
  try {
    const execute = reportTool(tools);
    const reportPromise = execute({ sessions: ["session-overlap"] });
    await launchStarted;

    const dispose = cleanup as () => void | Promise<void>;
    const disposal = dispose();
    let closed = false;
    try {
      await fetch(launchedURL);
    } catch {
      closed = true;
    }
    expect(closed).toBe(true);
    releaseLaunch(true);
    await disposal;

    const result = await reportPromise;
    expect(result.output.report.selector).toEqual({ sessions: ["session-overlap"] });
    expect(Object.hasOwn(result.output, "viewer")).toBe(false);
  } finally {
    if (typeof cleanup === "function") await cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracking_report selects standalone, child, epic, and intersecting session/time reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-report-tool-"));
  let viewerURL: string | undefined;
  const store = TrackerStore.open(parseOptions({ dataDir: directory }));
  store.recordTopology({ beadID: "epic-1", type: "epic", validatedAt: 1 });
  store.recordTopology({ beadID: "child-1", type: "task", parentBeadID: "epic-1", validatedAt: 1 });
  store.recordTopology({ beadID: "standalone-1", type: "feature", validatedAt: 1 });
  store.recordSession({ sessionID: "epic-session", observedAt: 1 });
  store.recordAssociation({
    receiptID: "epic-association",
    sessionID: "epic-session",
    beadID: "epic-1",
    source: "selection",
    observedAt: 1,
  });
  store.startAction({
    sessionID: "epic-session",
    actionID: "epic-action",
    observedRole: "architect",
    startedAt: 10,
  });
  endAction(store, "epic-session", "epic-action", 20);
  store.recordSession({ sessionID: "child-session", observedAt: 1 });
  store.recordAssociation({
    receiptID: "child-association",
    sessionID: "child-session",
    beadID: "child-1",
    source: "selection",
    observedAt: 1,
  });
  store.startAction({
    sessionID: "child-session",
    actionID: "child-action",
    observedRole: "worker",
    startedAt: 30,
  });
  endAction(store, "child-session", "child-action", 40);
  store.recordSession({ sessionID: "standalone-session", observedAt: 1 });
  store.recordAssociation({
    receiptID: "standalone-association",
    sessionID: "standalone-session",
    beadID: "standalone-1",
    source: "selection",
    observedAt: 1,
  });
  store.startAction({
    sessionID: "standalone-session",
    actionID: "standalone-action",
    observedRole: "worker",
    startedAt: 50,
  });
  endAction(store, "standalone-session", "standalone-action", 70);
  store.close();

  const { tools, cleanup } = await setupReportTool(directory);
  try {
    const execute = reportTool(tools);
    const standalone = await execute({ bead: "standalone-1" });
    expect(standalone.output.report.kind).toBe("standalone");
    expect(standalone.output.artifactKey).toMatch(/^reports\/report-[a-f0-9]+\.json$/u);
    expect(standalone.output.renderedArtifactKey).toMatch(/^reports\/report-[a-f0-9]+\.md$/u);
    expect(standalone.output.viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/report\//u);
    expect(typeof standalone.output.viewer.expiresAt).toBe("number");
    expect(standalone.output.viewer.browserOpened).toBe(false);
    viewerURL = standalone.output.viewer.url;
    expect(Object.hasOwn(standalone.output, "artifactPath")).toBe(false);
    expect(Object.hasOwn(standalone.output, "renderedArtifactPath")).toBe(false);
    expect((await execute({ bead: "child-1" })).output.report.kind).toBe("child");
    expect((await execute({ bead: "epic-1" })).output.report.kind).toBe("epic");
    const selected = await execute({ sessions: ["child-session"], from: 32, to: 38 });
    expect(selected.output.report.kind).toBe("sessions");
    expect(selected.output.report.selector).toEqual({
      sessions: ["child-session"],
      from: 32,
      to: 38,
    });
    expect(selected.output.report.metrics.activeMs).toBe(6);

    // Cross-boundary matrix: every supplied selector dimension must survive normalization and delivery.
    const selectorCases = [
      { bead: "child-1", sessions: ["child-session"], from: 32, to: 38 },
      { bead: "child-1", sessions: ["child-session"], from: 32 },
      { bead: "child-1", sessions: ["child-session"], to: 38 },
      { bead: "child-1", sessions: ["child-session"] },
      { bead: "child-1", from: 32, to: 38 },
      { bead: "child-1", from: 32 },
      { bead: "child-1", to: 38 },
      { sessions: ["child-session", "standalone-session"], from: 32, to: 68 },
      { sessions: ["child-session", "standalone-session"], from: 32 },
      { sessions: ["child-session", "standalone-session"], to: 38 },
      { sessions: ["child-session", "standalone-session"] },
      { from: 32, to: 68 },
      { from: 32 },
      { to: 38 },
    ] as const;
    for (const selector of selectorCases) {
      const result = await execute(selector);
      expect(result.output.report.selector).toEqual(selector);
      expect(result.output.viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/report\//u);
    }
    const emptySessions = await execute({ sessions: [] });
    expect(emptySessions.output.report.selector).toEqual({ sessions: [] });
    expect(emptySessions.output.report.metrics).toMatchObject({ sessionCount: 0, actionCount: 0 });

    const combinedViewer = await execute({
      bead: "child-1",
      sessions: ["child-session"],
      from: 32,
      to: 38,
    });
    const combinedHtml = await (await fetch(combinedViewer.output.viewer.url)).text();
    expect(combinedHtml).toContain("bead: child-1");
    expect(combinedHtml).toContain("sessions: child-session");
    expect(combinedHtml).toContain("from: 1970-01-01T00:00:00.032Z");
    expect(combinedHtml).toContain("to: 1970-01-01T00:00:00.038Z");

    const bare = await execute({});
    expect(Object.hasOwn(bare.output, "viewer")).toBe(false);
    expect(bare.output.report.selector).toEqual({});
  } finally {
    if (typeof cleanup === "function") cleanup();
    if (viewerURL !== undefined) {
      let disposed = false;
      try {
        await fetch(viewerURL);
      } catch {
        disposed = true;
      }
      expect(disposed).toBe(true);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracking_report rejects invalid selectors and does not mutate raw lifecycle facts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-report-tool-invalid-"));
  const store = TrackerStore.open(parseOptions({ dataDir: directory }));
  store.recordTopology({ beadID: "bead-1", type: "task", validatedAt: 1 });
  store.recordSession({ sessionID: "session-1", observedAt: 1 });
  store.close();

  const { tools, cleanup } = await setupReportTool(directory);
  try {
    const execute = reportTool(tools);
    const before = TrackerStore.open(parseOptions({ dataDir: directory }));
    const rawBefore = JSON.stringify({
      sessions: before.listSessions(),
      actions: before.listActions(),
      slices: before.listActivitySlices(),
      beads: before.listBeads(),
      associations: before.listAssociationReceipts(),
      closeouts: before.listCloseouts(),
    });
    const reportsBefore = before.listReports().length;
    before.close();

    const valid = await execute({ sessions: ["session-1"] });
    expect(valid.output.report.kind).toBe("sessions");
    expect(valid.output.viewer.browserOpened).toBe(false);
    const afterValid = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(afterValid.listReports()).toHaveLength(reportsBefore + 1);
    afterValid.close();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    const result = await execute({ bead: "bead-1", unsupported: true });
    console.warn = originalWarn;
    expect(result.output).toEqual({ ok: false, changed: false });
    expect(Object.hasOwn(result.output, "viewer")).toBe(false);
    expect(warnings.join(" ")).toContain("report generation failed; delivery continues");
    expect(warnings.join(" ")).not.toContain("bead-1");
    expect(warnings.join(" ")).not.toContain(directory);

    const after = TrackerStore.open(parseOptions({ dataDir: directory }));
    expect(
      JSON.stringify({
        sessions: after.listSessions(),
        actions: after.listActions(),
        slices: after.listActivitySlices(),
        beads: after.listBeads(),
        associations: after.listAssociationReceipts(),
        closeouts: after.listCloseouts(),
      }),
    ).toBe(rawBefore);
    expect(after.listReports()).toHaveLength(reportsBefore + 1);
    after.close();
  } finally {
    if (typeof cleanup === "function") cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});
