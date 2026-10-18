import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TrackerPlugin } from "../src/plugin.js";

describe("stable tracker tools", () => {
  test("registers and executes the four approved contracts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-plugin-tools-"));
    const registered: any[] = [];
    const sessions: Record<string, any> = {
      root: { id: "root", projectID: "project-safe", parentID: undefined, agent: "orchestrator" },
      lane: { id: "lane", projectID: "project-safe", parentID: "root", agent: "worker" },
      "failure-root": { id: "failure-root", projectID: "project-safe", parentID: undefined, agent: "orchestrator" },
    };
    const context = {
      options: { dataDir: directory },
      location: { directory: "/safe/workspace", project: { id: "project-safe" }, workspaceID: "workspace-safe" },
      session: {
        hook: async () => ({ dispose: async () => undefined }),
        get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
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
    expect(registered.map((tool) => tool.name)).toEqual([
      "tracking_run_start",
      "tracking_lane_attach",
      "tracking_closeout",
      "tracking_report",
    ]);
    expect(registered[0].input.required).toEqual(["beadID"]);
    expect(registered[1].input.required).toEqual(["runID", "sessionID"]);
    const run = await registered[0].execute({ beadID: "bead-test-tools" }, { sessionID: "root" });
    await registered[1].execute({ runID: run.output.runID, sessionID: "lane" }, {});
    await registered[2].execute({ beadID: "bead-test-tools" }, {});
    const report = await registered[3].execute({ bead: "bead-test-tools" }, {});
    expect(report.output.url).not.toContain(run.output.runID);
    const defaultReport = await registered[3].execute(undefined, { sessionID: "root" });
    expect(defaultReport.output.url).not.toContain(run.output.runID);
    expect((await registered[2].execute({ beadID: "missing-bead" }, {})).output.status).toBe("not-finalized");
    await registered[0].execute({ beadID: "bead-report-failure" }, { sessionID: "failure-root" });
    mkdirSync(join(directory, "reports", "beads", "bead-report-failure", "report.html"), { recursive: true });
    expect((await registered[2].execute({ beadID: "bead-report-failure" }, {})).output.status).toBe("finalized-report-failed");
    if (typeof cleanup === "function") await cleanup();
    rmSync(directory, { recursive: true, force: true });
  });
});
