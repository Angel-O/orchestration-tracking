import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import { TrackerPlugin } from "../src/plugin.js";
import { TrackerStore } from "../src/store.js";
import type { ReportViewerOptions } from "../src/report-viewer.js";

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

function reportTool(tools: readonly ReportTool[]): NonNullable<ReportTool["execute"]> {
  const tool = tools.find((candidate) => candidate.name === "tracking_report");
  if (!tool?.execute) throw new Error("report tool was not registered");
  return tool.execute;
}

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
