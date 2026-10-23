import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AttributionTransitions, type ValidatedBead } from "../src/attribution.js";
import { parseOptions } from "../src/config/options.js";
import { generateReport } from "../src/report.js";
import { LAUNCH_METADATA_KEY, TrackerPlugin } from "../src/plugin.js";
import { TrackerStore, UNASSIGNED_RETENTION_MS } from "../src/store.js";

type Fixture = { directory: string; store: TrackerStore };

function fixture(prefix = "tracker-simulation-"): Fixture {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

function dispose({ directory, store }: Fixture): void {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

function validator(records: readonly ValidatedBead[]) {
  return async (beadID: unknown): Promise<ValidatedBead> => {
    const bead = records.find((record) => record.beadID === beadID);
    if (!bead) throw new Error("authoritative Bead validation failed");
    return bead;
  };
}

function finish(
  store: TrackerStore,
  sessionID: string,
  actionID: string,
  endedAt: number,
  sequence: number,
): void {
  expect(
    store.endAction({
      eventID: `${actionID}-end`,
      aggregateID: sessionID,
      sequence,
      sessionID,
      actionID,
      outcome: "completed",
      endedAt,
    }),
  ).toBe(true);
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const prohibitedContent = [
  /prompt/i,
  /response/i,
  /transcript/i,
  /context label/i,
  /tool payload/i,
  /\btokens?\b/i,
  /git metadata/i,
  /\/Users\//,
  /command output/i,
  /arbitrary event payload/i,
  /(?:^|\s)\/[^\s/]+(?:\/[^\s/]+)+/,
];

function containsPrivateContent(values: readonly string[]): boolean {
  return values.some((value) => prohibitedContent.some((pattern) => pattern.test(value)));
}

function assertNoPrivateContent(values: readonly string[]): void {
  expect(containsPrivateContent(values)).toBe(false);
}

describe("deterministic tracker integration simulations", () => {
  test("covers standalone creation, resume, switching, closeout, B2 scoping, and replay", async () => {
    const fixtureValue = fixture();
    try {
      const { store } = fixtureValue;
      const transitions = new AttributionTransitions(
        store,
        validator([
          { beadID: "bead-a", type: "task" },
          { beadID: "bead-b", type: "bug" },
          { beadID: "bead-b2", type: "feature" },
        ]),
      );

      // A root has no counted interval before its first action.
      store.recordSession({ sessionID: "root-a", observedAt: 50 });
      store.startAction({
        sessionID: "root-a",
        actionID: "scope",
        observedRole: "orchestrator",
        startedAt: 100,
      });
      finish(store, "root-a", "scope", 180, 1);
      store.startAction({
        sessionID: "root-a",
        actionID: "create-a",
        observedRole: "orchestrator",
        startedAt: 200,
      });
      expect(
        await transitions.beadCreated("bead-a", {
          sessionID: "root-a",
          receiptID: "create-a-receipt",
          observedAt: 220,
        }),
      ).toEqual({ ok: true, changed: true });
      expect(
        await transitions.beadCreated("bead-a", {
          sessionID: "root-a",
          receiptID: "create-a-receipt",
          observedAt: 230,
        }),
      ).toEqual({ ok: true, changed: false });
      finish(store, "root-a", "create-a", 240, 2);
      store.startAction({
        sessionID: "root-a",
        actionID: "implement-a",
        observedRole: "worker",
        startedAt: 300,
      });
      finish(store, "root-a", "implement-a", 360, 3);

      // Explicit resume is forward-only and replay adds neither a boundary nor time.
      store.recordSession({ sessionID: "root-b", observedAt: 400 });
      store.startAction({
        sessionID: "root-b",
        actionID: "resume-a",
        observedRole: "worker",
        startedAt: 420,
      });
      expect(
        await transitions.beadSelected("bead-a", {
          sessionID: "root-b",
          receiptID: "resume-a-receipt",
          observedAt: 450,
        }),
      ).toEqual({ ok: true, changed: true });
      expect(
        await transitions.beadSelected("bead-a", {
          sessionID: "root-b",
          receiptID: "resume-a-receipt",
          observedAt: 460,
        }),
      ).toEqual({ ok: true, changed: false });
      finish(store, "root-b", "resume-a", 480, 1);
      store.startAction({
        sessionID: "root-b",
        actionID: "switch-back",
        observedRole: "orchestrator",
        startedAt: 500,
      });
      expect(
        await transitions.beadSelected("bead-b", {
          sessionID: "root-b",
          receiptID: "switch-b-receipt",
          observedAt: 520,
        }),
      ).toEqual({ ok: true, changed: true });
      expect(
        await transitions.beadSelected("bead-a", {
          sessionID: "root-b",
          receiptID: "switch-a-receipt",
          observedAt: 540,
        }),
      ).toEqual({ ok: true, changed: true });
      finish(store, "root-b", "switch-back", 560, 2);

      const beforeCloseout = generateReport(store, { bead: "bead-a" }, 600).report;
      expect(beforeCloseout.metrics.activeMs).toBe(250);
      expect(beforeCloseout.phaseTotals.scoping.activeMs).toBe(120);
      expect(beforeCloseout.phaseTotals.implementation.activeMs).toBe(90);
      expect(beforeCloseout.phaseTotals.coordination.activeMs).toBe(40);
      expect(beforeCloseout.metrics.sessionCount).toBe(2);
      expect(generateReport(store, { bead: "bead-b" }, 600).report.metrics.activeMs).toBe(20);

      // Closeout resets only the invoking root; later work can create B2 without mixing B1.
      store.startAction({
        sessionID: "root-a",
        actionID: "close-a",
        observedRole: "orchestrator",
        startedAt: 500,
      });
      expect(
        await transitions.closeout("bead-a", {
          sessionID: "root-a",
          receiptID: "close-a-receipt",
          observedAt: 520,
        }),
      ).toEqual({ ok: true, changed: true });
      finish(store, "root-a", "close-a", 540, 4);
      expect(
        await transitions.closeout("bead-a", {
          sessionID: "root-a",
          receiptID: "close-a-receipt",
          observedAt: 550,
        }),
      ).toEqual({ ok: true, changed: false });

      store.startAction({
        sessionID: "root-a",
        actionID: "create-b2",
        observedRole: "orchestrator",
        startedAt: 600,
      });
      expect(
        await transitions.beadCreated("bead-b2", {
          sessionID: "root-a",
          receiptID: "create-b2-receipt",
          observedAt: 620,
        }),
      ).toEqual({ ok: true, changed: true });
      finish(store, "root-a", "create-b2", 640, 5);

      const b2 = generateReport(store, { bead: "bead-b2" }, 700).report;
      expect(b2.lifecycleState).toBe("Active — closeout not observed");
      expect(b2.phaseTotals.scoping.activeMs).toBe(60);
      expect(b2.metrics.activeMs).toBe(60);
      expect(store.listCloseouts()).toEqual([
        { receiptID: "close-a-receipt", beadID: "bead-a", kind: "concrete", closedAt: 520 },
      ]);
    } finally {
      dispose(fixtureValue);
    }
  });

  test("covers epic decomposition, children, inheritance, delivery phases, metrics, and closeout", async () => {
    const fixtureValue = fixture();
    try {
      const { store } = fixtureValue;
      const transitions = new AttributionTransitions(
        store,
        validator([
          { beadID: "epic-a", type: "epic" },
          { beadID: "child-a", type: "task", parentBeadID: "epic-a" },
          { beadID: "child-b", type: "feature", parentBeadID: "epic-a" },
        ]),
      );
      store.recordSession({ sessionID: "planner", observedAt: 100 });
      expect(
        await transitions.beadCreated("epic-a", {
          sessionID: "planner",
          receiptID: "epic-create",
          observedAt: 100,
        }),
      ).toEqual({ ok: true, changed: true });
      store.startAction({
        sessionID: "planner",
        actionID: "decompose",
        observedRole: "planner",
        startedAt: 100,
      });
      expect(
        await transitions.beadCreated("child-a", {
          sessionID: "planner",
          receiptID: "child-a-create",
          observedAt: 120,
        }),
      ).toEqual({ ok: true, changed: true });
      expect(
        await transitions.beadCreated("child-b", {
          sessionID: "planner",
          receiptID: "child-b-create",
          observedAt: 130,
        }),
      ).toEqual({ ok: true, changed: true });
      finish(store, "planner", "decompose", 300, 1);

      // A child inherits once. A later parent switch does not rewrite the child.
      store.recordSession({ sessionID: "epic-child", parentSessionID: "planner", observedAt: 310 });
      store.startAction({
        sessionID: "epic-child",
        actionID: "inherited",
        observedRole: "orchestrator",
        startedAt: 320,
      });
      expect(
        await transitions.beadSelected("child-b", {
          sessionID: "planner",
          receiptID: "planner-child-a",
          observedAt: 330,
        }),
      ).toEqual({ ok: true, changed: true });
      finish(store, "epic-child", "inherited", 340, 1);

      expect(
        await transitions.beadSelected("epic-a", {
          sessionID: "planner",
          receiptID: "planner-epic-again",
          observedAt: 380,
        }),
      ).toEqual({ ok: true, changed: true });

      store.startAction({
        sessionID: "epic-child",
        actionID: "override",
        observedRole: "orchestrator",
        startedAt: 350,
      });
      expect(
        await transitions.beadSelected("child-a", {
          sessionID: "epic-child",
          receiptID: "child-a-override",
          observedAt: 360,
        }),
      ).toEqual({ ok: true, changed: true });
      finish(store, "epic-child", "override", 370, 2);

      // Direct epic work overlaps with child work, so combined active time is not elapsed time.
      store.startAction({
        sessionID: "planner",
        actionID: "direct",
        observedRole: "orchestrator",
        startedAt: 400,
      });
      finish(store, "planner", "direct", 600, 2);
      store.startAction({
        sessionID: "epic-child",
        actionID: "coordinate",
        observedRole: "orchestrator",
        startedAt: 400,
      });
      finish(store, "epic-child", "coordinate", 450, 3);
      store.startAction({
        sessionID: "epic-child",
        actionID: "implement",
        observedRole: "worker",
        startedAt: 450,
      });
      finish(store, "epic-child", "implement", 650, 4);
      store.startAction({
        sessionID: "epic-child",
        actionID: "review",
        observedRole: "reviewer",
        startedAt: 660,
      });
      finish(store, "epic-child", "review", 700, 5);
      store.startAction({
        sessionID: "epic-child",
        actionID: "integration",
        observedRole: "integration",
        startedAt: 710,
      });
      finish(store, "epic-child", "integration", 730, 6);
      store.startAction({
        sessionID: "epic-child",
        actionID: "build",
        observedRole: "build",
        startedAt: 740,
      });
      finish(store, "epic-child", "build", 750, 7);

      const child = generateReport(store, { bead: "child-a" }, 800).report;
      expect(child.kind).toBe("child");
      expect(child.phaseTotals.scoping.activeMs).toBe(0);
      expect(child.phaseTotals.coordination.activeMs).toBe(60);
      expect(child.phaseTotals.implementation.activeMs).toBe(200);
      expect(child.phaseTotals.review.activeMs).toBe(40);
      expect(child.phaseTotals["integration-validation"].activeMs).toBe(20);
      expect(child.phaseTotals.build.activeMs).toBe(10);
      expect(child.metrics.activeMs).toBe(330);

      const epic = generateReport(store, { bead: "epic-a" }, 800).report;
      expect(epic.initiativeState).toBe("open");
      expect(epic.metrics.directActiveMs).toBe(430);
      expect(epic.metrics.summedChildActiveMs).toBe(330);
      expect(epic.metrics.combinedActiveMs).toBe(760);
      expect(epic.metrics.initiativeElapsedMs).toBe(700);
      expect(
        epic.children?.map(({ beadID, lifecycleState, metrics }) => [
          beadID,
          lifecycleState,
          metrics.activeMs,
        ]),
      ).toEqual([
        ["child-a", "Active — closeout not observed", 330],
        ["child-b", "Not started", 0],
      ]);
      expect(epic.actions).toBeUndefined();
      expect(epic.sessions).toBeUndefined();

      // A coordinator remains epic-associated when it closes a child workstream.
      store.recordSession({ sessionID: "epic-coordinator", observedAt: 810 });
      store.recordAssociation({
        receiptID: "coordinator-epic",
        sessionID: "epic-coordinator",
        beadID: "epic-a",
        source: "selection",
        observedAt: 810,
      });
      store.startAction({
        sessionID: "epic-coordinator",
        actionID: "child-closeout",
        observedRole: "orchestrator",
        startedAt: 820,
      });
      expect(
        await transitions.closeout("child-a", {
          sessionID: "epic-coordinator",
          receiptID: "child-a-close",
          observedAt: 830,
        }),
      ).toEqual({ ok: true, changed: true });
      finish(store, "epic-coordinator", "child-closeout", 840, 1);
      expect(
        store.listActivitySlices().find((slice) => slice.actionID === "child-closeout")?.beadID,
      ).toBe("epic-a");
      store.startAction({
        sessionID: "epic-coordinator",
        actionID: "after-child-closeout",
        observedRole: "orchestrator",
        startedAt: 850,
      });
      finish(store, "epic-coordinator", "after-child-closeout", 860, 2);
      expect(
        store.listActivitySlices().find((slice) => slice.actionID === "after-child-closeout")
          ?.beadID,
      ).toBe("epic-a");
      const afterChildClose = generateReport(store, { bead: "epic-a" }, 950).report;
      expect(afterChildClose.initiativeState).toBe("open");
      expect(afterChildClose.children?.[0]?.lifecycleState).toBe("Closeout complete");

      expect(
        await transitions.closeout("epic-a", {
          sessionID: "planner",
          receiptID: "epic-close",
          observedAt: 1_000,
        }),
      ).toEqual({ ok: true, changed: true });
      expect(
        await transitions.closeout("epic-a", {
          sessionID: "planner",
          receiptID: "epic-close",
          observedAt: 1_100,
        }),
      ).toEqual({ ok: true, changed: false });
      const closed = generateReport(store, { bead: "epic-a" }, 2_000).report;
      expect(closed.initiativeState).toBe("closeout-bounded");
      expect(closed.elapsed).toEqual({ startAt: 100, endAt: 1_000, durationMs: 900, open: false });
      expect(closed.children?.[0]?.lifecycleState).toBe("Closeout complete");
      expect(store.listCloseouts()).toHaveLength(2);
    } finally {
      dispose(fixtureValue);
    }
  });

  test("replays lifecycle, reports, retention, and mixed-session facts without duplication", () => {
    const fixtureValue = fixture();
    try {
      const { store } = fixtureValue;
      store.recordTopology({ beadID: "bead-kept", type: "task", validatedAt: 1 });
      store.recordSession({ sessionID: "old", observedAt: 1 });
      store.recordSession({ sessionID: "old", observedAt: 2 });
      store.startAction({
        sessionID: "old",
        actionID: "old-action",
        startedAt: 1,
        receiptID: "old-start",
      });
      store.startAction({
        sessionID: "old",
        actionID: "old-action",
        startedAt: 2,
        receiptID: "other-start",
      });
      finish(store, "old", "old-action", 2, 1);
      expect(
        store.endAction({
          eventID: "old-end",
          aggregateID: "old",
          sequence: 1,
          sessionID: "old",
          actionID: "old-action",
          outcome: "failed",
          endedAt: 3,
        }),
      ).toBe(false);

      store.recordSession({ sessionID: "mixed", observedAt: 1 });
      store.startAction({
        sessionID: "mixed",
        actionID: "mixed-action",
        startedAt: 1,
        receiptID: "mixed-start",
      });
      store.recordAssociation({
        receiptID: "mixed-select",
        sessionID: "mixed",
        beadID: "bead-kept",
        source: "selection",
        observedAt: 2,
      });
      finish(store, "mixed", "mixed-action", 3, 1);
      const report = generateReport(store, { bead: "bead-kept" }, 10);
      const replay = generateReport(store, { bead: "bead-kept" }, 10);
      expect(replay.reportID).toBe(report.reportID);
      expect(replay.report.metrics).toEqual(report.report.metrics);
      expect(store.listReports()).toHaveLength(1);
      expect(store.listActions()).toHaveLength(2);
      expect(store.listActivitySlices()).toHaveLength(3);

      const cleanup = store.cleanupUnassigned(UNASSIGNED_RETENTION_MS + 10, 100);
      expect(cleanup).toEqual({ slicesPruned: 2, sessionsPruned: 1 });
      expect(store.listSessions().map(({ sessionID }) => sessionID)).toEqual(["mixed"]);
      expect(store.listActivitySlices().map(({ beadID }) => beadID)).toEqual(["bead-kept"]);
      expect(store.listCloseouts()).toEqual([]);
    } finally {
      dispose(fixtureValue);
    }
  });

  test("advances unchanged open detailed and initiative windows on regeneration", () => {
    const fixtureValue = fixture();
    try {
      const { store } = fixtureValue;
      store.recordTopology({ beadID: "bead-open", type: "task", validatedAt: 1 });
      store.recordSession({ sessionID: "open-detail", observedAt: 10 });
      store.recordAssociation({
        receiptID: "open-detail-select",
        sessionID: "open-detail",
        beadID: "bead-open",
        source: "selection",
        observedAt: 10,
      });
      store.startAction({
        sessionID: "open-detail",
        actionID: "open-detail-action",
        observedRole: "worker",
        startedAt: 100,
      });

      store.recordTopology({ beadID: "epic-open", type: "epic", validatedAt: 1 });
      store.recordSession({ sessionID: "open-initiative", observedAt: 10 });
      store.recordAssociation({
        receiptID: "open-initiative-select",
        sessionID: "open-initiative",
        beadID: "epic-open",
        source: "selection",
        observedAt: 10,
      });
      store.startAction({
        sessionID: "open-initiative",
        actionID: "open-initiative-action",
        observedRole: "orchestrator",
        startedAt: 100,
      });

      const firstDetail = generateReport(store, { bead: "bead-open" }, 200);
      const laterDetail = generateReport(store, { bead: "bead-open" }, 350);
      expect(laterDetail.reportID).toBe(firstDetail.reportID);
      expect(laterDetail.report.metrics).toMatchObject({
        activeMs: firstDetail.report.metrics.activeMs,
        actionCount: firstDetail.report.metrics.actionCount,
        sessionCount: firstDetail.report.metrics.sessionCount,
      });
      expect(firstDetail.report.elapsed).toEqual({
        startAt: 100,
        endAt: 200,
        durationMs: 100,
        open: true,
      });
      expect(laterDetail.report.elapsed).toEqual({
        startAt: 100,
        endAt: 350,
        durationMs: 250,
        open: true,
      });

      const firstInitiative = generateReport(store, { bead: "epic-open" }, 200);
      const laterInitiative = generateReport(store, { bead: "epic-open" }, 350);
      expect(laterInitiative.reportID).toBe(firstInitiative.reportID);
      expect(laterInitiative.report.metrics).toMatchObject({
        activeMs: firstInitiative.report.metrics.activeMs,
        actionCount: firstInitiative.report.metrics.actionCount,
        directActiveMs: firstInitiative.report.metrics.directActiveMs,
        combinedActiveMs: firstInitiative.report.metrics.combinedActiveMs,
      });
      expect(firstInitiative.report.elapsed).toEqual({
        startAt: 100,
        endAt: 200,
        durationMs: 100,
        open: true,
      });
      expect(laterInitiative.report.elapsed).toEqual({
        startAt: 100,
        endAt: 350,
        durationMs: 250,
        open: true,
      });
      expect(laterInitiative.report.metrics.initiativeElapsedMs).toBe(250);
      expect(store.listReports()).toHaveLength(2);
    } finally {
      dispose(fixtureValue);
    }
  });

  test("scans database, WAL, reports, and diagnostics for prohibited content", async () => {
    const fixtureValue = fixture("tracker-privacy-");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalPath = process.env.PATH;
    let commandDirectory: string | undefined;
    const sentinels = {
      prompt: "sentinel-prompt-001",
      response: "sentinel-response-002",
      transcript: "sentinel-transcript-003",
      contextLabel: "sentinel-context-label-004",
      toolPayload: "sentinel-tool-payload-005",
      tokens: "sentinel-tokens-006",
      gitMetadata: "sentinel-git-metadata-007",
      fullPath: "/sentinel/full/path-008",
      eventPayload: "sentinel-event-payload-009",
      commandOutput: "sentinel-command-output-010",
    } as const;
    try {
      const { directory, store } = fixtureValue;
      expect(containsPrivateContent([sentinels.fullPath])).toBe(true);
      store.recordTopology({ beadID: "bead-private", type: "feature", validatedAt: 1 });
      store.recordSession({ sessionID: "session-private", observedAt: 10 });
      store.recordAssociation({
        receiptID: "association-private",
        sessionID: "session-private",
        beadID: "bead-private",
        source: "selection",
        observedAt: 10,
      });
      store.startAction({
        sessionID: "session-private",
        actionID: "action-private",
        observedRole: "worker",
        startedAt: 10,
      });
      finish(store, "session-private", "action-private", 20, 1);
      const generated = generateReport(store, { bead: "bead-private" }, 30);

      // Exercise a content-bearing host error; the plugin must reduce it to its error kind.
      const session = {
        id: "descriptor-session",
        metadata: {
          [LAUNCH_METADATA_KEY]: {
            version: 1,
            targetSessionID: "descriptor-session",
            beadID: "bead-private",
          },
          sentinels,
        } as Record<string, unknown>,
      };
      commandDirectory = mkdtempSync(join(tmpdir(), "tracker-privacy-command-"));
      const command = join(commandDirectory, "wbd");
      writeFileSync(
        command,
        `#!/bin/sh
printf '%s' '${JSON.stringify({
          id: "bead-private",
          issue_type: "feature",
          prompt: sentinels.prompt,
          response: sentinels.response,
          transcript: sentinels.transcript,
          context_labels: sentinels.contextLabel,
          tool_payload: sentinels.toolPayload,
          tokens: sentinels.tokens,
          git_metadata: sentinels.gitMetadata,
          full_path: sentinels.fullPath,
          event_payload: sentinels.eventPayload,
          command_output: sentinels.commandOutput,
        })}'
`,
      );
      chmodSync(command, 0o700);
      process.env.PATH = `${commandDirectory}:${originalPath ?? ""}`;
      let promptHook:
        | ((event: { sessionID: string; messageID: string }) => Promise<void>)
        | undefined;
      const context = {
        options: { dataDir: directory },
        session: {
          hook: async (_name: string, callback: typeof promptHook) => {
            promptHook = callback;
            return { dispose: async () => undefined };
          },
          get: async () => session,
          update: async () => {
            throw new Error(Object.values(sentinels).join(" "));
          },
        },
        event: { subscribe: async function* () {} },
      };
      const cleanupPlugin = await TrackerPlugin.setup(context as never);
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      if (!promptHook) throw new Error("prompt hook was not registered");
      await promptHook({ sessionID: session.id, messageID: "descriptor-action" });
      if (typeof cleanupPlugin === "function") cleanupPlugin();
      rmSync(commandDirectory, { recursive: true, force: true });
      commandDirectory = undefined;

      const artifactValues = filesUnder(directory).map((path) => readFileSync(path, "utf8"));
      expect(existsSync(generated.artifactPath)).toBe(true);
      expect(filesUnder(directory).some((path) => path.endsWith("-wal"))).toBe(true);
      assertNoPrivateContent([...artifactValues, ...warnings]);
      const allArtifactsAndDiagnostics = [...artifactValues, ...warnings].join("\n");
      for (const sentinel of Object.values(sentinels))
        expect(allArtifactsAndDiagnostics).not.toContain(sentinel);
      expect(warnings.join(" ")).toContain("launch descriptor removal failed; delivery continues");
      expect(warnings.join(" ")).toContain("Error");
      expect(warnings.join(" ")).not.toContain("opaque fixture");
    } finally {
      console.warn = originalWarn;
      process.env.PATH = originalPath;
      if (commandDirectory) rmSync(commandDirectory, { recursive: true, force: true });
      dispose(fixtureValue);
    }
  });

  test("keeps injected database, Hub, report, descriptor, and closeout failures non-blocking", async () => {
    const fixtureValue = fixture("tracker-failure-");
    try {
      const { directory, store } = fixtureValue;
      store.recordTopology({ beadID: "bead-failure", type: "task", validatedAt: 1 });
      store.recordSession({ sessionID: "failure-session", observedAt: 10 });

      const authoritative = validator([{ beadID: "bead-failure", type: "task" }]);
      const hubFailure = new AttributionTransitions(store, async () => {
        throw new Error(["opaque", "Hub", "fixture"].join(" "));
      });
      let deliveryCompleted = false;
      expect(
        await hubFailure.beadSelected("bead-failure", {
          sessionID: "failure-session",
          receiptID: "hub-failure",
          observedAt: 20,
        }),
      ).toEqual({ ok: false, changed: false });
      deliveryCompleted = true;
      expect(deliveryCompleted).toBe(true);

      // A successful authoritative validation followed by a closed store reaches the database path.
      let validationCalls = 0;
      const databaseTransitions = new AttributionTransitions(store, async (beadID) => {
        validationCalls += 1;
        return authoritative(beadID);
      });
      store.close();
      const databaseFailure = await databaseTransitions.beadSelected("bead-failure", {
        sessionID: "failure-session",
        receiptID: "database-failure",
        observedAt: 30,
      });
      expect(databaseFailure).toEqual({ ok: false, changed: false });
      expect(validationCalls).toBe(1);
      expect(deliveryCompleted).toBe(true);

      // Exercise the production tool handler after the managed Hub-closeout precondition.
      const commandDirectory = mkdtempSync(join(tmpdir(), "tracker-closeout-command-"));
      const originalPath = process.env.PATH;
      const originalWarn = console.warn;
      const registeredTools: Array<{
        name: string;
        execute: (args: unknown, context: unknown) => Promise<{ output: unknown }>;
      }> = [];
      let promptHook:
        | ((event: { sessionID: string; messageID: string }) => Promise<void>)
        | undefined;
      const command = join(commandDirectory, "wbd");
      writeFileSync(
        command,
        '#!/bin/sh\nprintf \'%s\' \'{"id":"bead-failure","issue_type":"task"}\'\n',
      );
      chmodSync(command, 0o700);
      process.env.PATH = `${commandDirectory}:${originalPath ?? ""}`;
      const pluginContext = {
        options: { dataDir: directory },
        session: {
          hook: async (_name: string, callback: typeof promptHook) => {
            promptHook = callback;
            return { dispose: async () => undefined };
          },
          get: async () => ({ id: "close-session", agent: "orchestrator" }),
        },
        tool: {
          transform: async (
            callback: (tools: { add: (tool: (typeof registeredTools)[number]) => void }) => void,
          ) => {
            callback({ add: (tool) => registeredTools.push(tool) });
            return { dispose: async () => undefined };
          },
        },
        event: { subscribe: async function* () {} },
        reportViewerOptions: { launch: () => true },
      };
      const cleanupPlugin = await TrackerPlugin.setup(pluginContext as never);
      if (!promptHook) throw new Error("prompt hook was not registered");
      await promptHook({ sessionID: "close-session", messageID: "close-action" });
      const closeoutTool = registeredTools.find((tool) => tool.name === "tracking_closeout");
      if (!closeoutTool) throw new Error("closeout tool was not registered");
      writeFileSync(join(directory, "reports"), "not a directory");

      const closeoutDiagnostics: string[] = [];
      console.warn = (...args: unknown[]) => {
        closeoutDiagnostics.push(args.join(" "));
      };
      const hubSucceeded = await Promise.resolve(true);
      let closeoutResult: { output: unknown } = { output: undefined };
      try {
        if (hubSucceeded)
          closeoutResult = await closeoutTool.execute(
            { beadID: "bead-failure" },
            { sessionID: "close-session", toolCallID: "close-call" },
          );
        deliveryCompleted = true;
      } finally {
        console.warn = originalWarn;
        if (typeof cleanupPlugin === "function") cleanupPlugin();
        process.env.PATH = originalPath;
        rmSync(commandDirectory, { recursive: true, force: true });
      }
      expect(hubSucceeded).toBe(true);
      const output = closeoutResult.output as {
        ok: boolean;
        changed: boolean;
        viewer: { url: string; browserOpened: boolean };
      };
      expect(output.ok).toBe(true);
      expect(output.changed).toBe(true);
      expect(output.viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/report\//u);
      expect(output.viewer.browserOpened).toBe(true);
      expect(deliveryCompleted).toBe(true);
      expect(closeoutDiagnostics).toEqual([
        "[orchestration-tracking] closeout report regeneration failed; delivery continues: Error",
      ]);
      assertNoPrivateContent(closeoutDiagnostics);
      const recovered = TrackerStore.open(parseOptions({ dataDir: directory }));
      expect(recovered.listCloseouts()).toHaveLength(1);
      recovered.close();
    } finally {
      dispose(fixtureValue);
    }
  });
});
