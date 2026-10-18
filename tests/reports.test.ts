import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import { normalizeSelector, writeReport } from "../src/report.js";
import { sourceReleasePlan } from "../src/release.js";
import { TrackerStore, type SessionInput } from "../src/store.js";

function session(sessionID: string, parentID?: string, projectLabel = "workspace-safe"): SessionInput {
  return { sessionID, parentID, projectID: "project-safe", workspaceID: "workspace-safe", projectLabel };
}

function storeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "tracker-reports-"));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

describe("run association and reports", () => {
  test("associates root, parent-chain, and explicit primary sessions idempotently", () => {
    const { directory, store } = storeFixture();
    store.recordSession(session("root"));
    store.recordSession(session("child", "root"));
    store.recordSession(session("grandchild", "child"));
    const run = store.startRun({ beadID: "bead-test-001", root: session("root"), startedAt: 100 });
    const primary = session("primary", "root");
    store.attachLane({ runID: run.runID, session: primary });
    store.attachLane({ runID: run.runID, session: primary });
    expect(store.listRunSessions(run.runID)).toEqual([
      { sessionID: "child", source: "parent-chain" },
      { sessionID: "grandchild", source: "parent-chain" },
      { sessionID: "primary", source: "explicit-primary" },
      { sessionID: "root", source: "root" },
    ]);
    expect(store.startRun({ beadID: "bead-test-001", root: session("root"), startedAt: 101 }).runID).toBe(run.runID);
    expect(() => store.startRun({ beadID: "bead-test-other", root: session("root"), startedAt: 102 })).toThrow(/root session/);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("associates descendants discovered before their parent becomes known", () => {
    const { directory, store } = storeFixture();
    store.recordSession(session("late-root"));
    const run = store.startRun({ beadID: "bead-late-parent", root: session("late-root"), startedAt: 100 });
    store.recordSession(session("late-grandchild", "late-parent"));
    expect(store.listRunSessions(run.runID)).toEqual([{ sessionID: "late-root", source: "root" }]);
    store.recordSession(session("late-parent", "late-root"));
    expect(store.listRunSessions(run.runID)).toEqual([
      { sessionID: "late-grandchild", source: "parent-chain" },
      { sessionID: "late-parent", source: "parent-chain" },
      { sessionID: "late-root", source: "root" },
    ]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("prompt admission propagates a newly known parent to its descendants", () => {
    const { directory, store } = storeFixture();
    const root = session("prompt-root");
    const run = store.startRun({ beadID: "bead-prompt-parent", root, startedAt: 100 });
    store.admit({ ...session("prompt-grandchild", "prompt-parent"), messageID: "grandchild-message", agent: "worker", startedAt: 110 });
    store.admit({ ...session("prompt-parent", "prompt-root"), messageID: "parent-message", agent: "planner", startedAt: 120 });
    expect(store.listRunSessions(run.runID)).toEqual([
      { sessionID: "prompt-grandchild", source: "parent-chain" },
      { sessionID: "prompt-parent", source: "parent-chain" },
      { sessionID: "prompt-root", source: "root" },
    ]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("finalizes stale opens without an end time and atomically replaces one stable Bead report", () => {
    const { directory, store } = storeFixture();
    const root = session("root", undefined, "safe <project>");
    const run = store.startRun({ beadID: "bead-test-002", root, startedAt: 100 });
    store.admit({ ...root, messageID: "m-1", agent: "worker", startedAt: 100 });
    store.closeExecution({ eventID: "e-1", aggregateID: "a-1", sequence: 1, sessionID: "root", outcome: "completed", endedAt: 200 });
    store.admit({ ...root, messageID: "m-2", agent: "worker", startedAt: 210 });
    store.admit({ ...root, messageID: "m-3", agent: "unknown-agent", startedAt: 220 });
    store.finalizeRun("bead-test-002", 300);
    expect(store.listPasses().map((pass) => [pass.outcome, pass.endedAt])).toEqual([["completed", 200], ["incomplete", null], ["incomplete", null]]);
    const first = writeReport(store, { bead: "bead-test-002" }, 300);
    const second = writeReport(store, { bead: "bead-test-002" }, 301);
    expect(second.path).toBe(join(directory, "reports", "beads", "bead-test-002", "report.html"));
    expect(second.path).toBe(first.path);
    expect(second.summary.elapsedMs).toBe(100);
    expect(second.summary.elapsedMs).toBe(first.summary.elapsedMs);
    const timeline = store.reportData({ bead: "bead-test-002" }, 9999);
    expect(timeline.timeScale.end).toBe(220);
    expect(timeline.passes[1]?.endedAt).toBe(null);
    expect(timeline.passes[2]?.widthPercent).toBe(0);
    expect(second.url).not.toContain(run.runID);
    expect(store.listReports()).toHaveLength(1);
    expect(statSync(second.path).mode & 0o777).toBe(0o600);
    const html = readFileSync(second.path, "utf8");
    expect(html).toContain("safe &lt;project&gt;");
    expect(html).toContain("incomplete");
    expect(html).toContain("unmapped");
    expect(html).toContain("Observed-agent totals");
    expect(html).toContain("Phase segments");
    expect(html).toContain("Shared time scale");
    expect(html).toContain("lane-track");
    expect(html.includes("width:")).toBe(true);
    expect(html).toContain("<h2>Passes</h2>");
    expect(html).toContain("P1");
    expect(html).toContain("1970-01-01T00:00:00.100Z");
    expect(html).toContain("1970-01-01T00:00:00.300Z");
    expect(html).toContain("1970-01-01T00:00:00.301Z");
    expect(html.includes("network assets")).toBe(true);
    expect(html).not.toMatch(/prompt|transcript|tool payload|token|git data/i);
    expect(html.includes("<script") || html.includes("src=") || html.includes("href=")).toBe(false);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("selectors intersect and reject unsupported or invalid input", () => {
    expect(normalizeSelector({ sessions: ["root"], from: "1970-01-01T00:00:01Z", to: "1970-01-01T00:00:02Z" })).toEqual({ sessions: ["root"], from: 1000, to: 2000 });
    expect(() => normalizeSelector({ allRuns: true })).toThrow(/multi-run/);
    expect(() => normalizeSelector({ sessions: ["root"], from: "not-a-time" })).toThrow(/timestamp/);
    expect(() => normalizeSelector({ from: "2025-01-02", to: "2025-01-01" })).toThrow(/after/);

    const { directory, store } = storeFixture();
    const root = session("selector-root");
    store.startRun({ beadID: "bead-selector", root, startedAt: 1 });
    store.admit({ ...root, messageID: "selector-message", agent: "worker", startedAt: 100 });
    store.closeExecution({ eventID: "selector-event", aggregateID: "selector-aggregate", sequence: 1, sessionID: "selector-root", outcome: "completed", endedAt: 200 });
    expect(store.reportData({ sessions: ["selector-root"], from: 150, to: 250 }).summary.passes).toBe(1);
    expect(() => store.reportData({ sessions: ["missing-session"] })).toThrow(/unknown session/);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("does not mark one pass in each session as a repeat", () => {
    const { directory, store } = storeFixture();
    const root = session("repeat-root");
    const run = store.startRun({ beadID: "bead-repeat-sessions", root, startedAt: 1 });
    store.attachLane({ runID: run.runID, session: session("repeat-a", "repeat-root") });
    store.attachLane({ runID: run.runID, session: session("repeat-b", "repeat-root") });
    for (const [sessionID, suffix, start, end] of [["repeat-a", "a", 100, 200], ["repeat-b", "b", 300, 400]] as const) {
      store.admit({ ...session(sessionID, "repeat-root"), messageID: `repeat-${suffix}`, agent: "worker", startedAt: start });
      store.closeExecution({ eventID: `repeat-event-${suffix}`, aggregateID: `repeat-aggregate-${suffix}`, sequence: 1, sessionID, outcome: "completed", endedAt: end });
    }
    expect(store.reportData({ bead: "bead-repeat-sessions" }).repeats).toEqual([
      { agent: "worker", sessionID: "repeat-a", phaseLabel: "Implementation", passes: 1, repeated: false },
      { agent: "worker", sessionID: "repeat-b", phaseLabel: "Implementation", passes: 1, repeated: false },
    ]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("finalized selector bounds use only selected passes and never current time for incomplete spans", () => {
    const { directory, store } = storeFixture();
    const root = session("bounds-root");
    const run = store.startRun({ beadID: "bead-selected-bounds", root, startedAt: 1 });
    store.attachLane({ runID: run.runID, session: session("bounds-lane", "bounds-root") });
    store.admit({ ...root, messageID: "bounds-complete", agent: "worker", startedAt: 100 });
    store.closeExecution({ eventID: "bounds-event", aggregateID: "bounds-aggregate", sequence: 1, sessionID: "bounds-root", outcome: "completed", endedAt: 200 });
    store.admit({ ...session("bounds-lane", "bounds-root"), messageID: "bounds-incomplete", agent: "worker", startedAt: 1000 });
    store.finalizeRun("bead-selected-bounds", 5000);
    expect(store.reportData({ bead: "bead-selected-bounds", sessions: ["bounds-root"] }, 9000).summary.elapsedMs).toBe(100);
    const laneReport = store.reportData({ bead: "bead-selected-bounds", sessions: ["bounds-lane"], from: 900, to: 1100 }, 9000);
    expect(laneReport.summary.elapsedMs).toBe(0);
    expect(laneReport.timeScale.end).toBe(1000);
    expect(laneReport.passes[0]?.endedAt).toBe(null);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("release support is deterministic and publication-free", () => {
    expect(sourceReleasePlan("0.1.0")).toEqual({ tag: "v0.1.0", archive: "orchestration-tracking-0.1.0.tar.gz", command: "git archive --format=tar.gz --prefix=orchestration-tracking-0.1.0/ v0.1.0 > orchestration-tracking-0.1.0.tar.gz" });
    expect(() => sourceReleasePlan("latest")).toThrow();
  });
});
