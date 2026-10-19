import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TrackerPlugin } from "../src/plugin.js";

function matchesSchema(schema: any, value: unknown): boolean {
  if (schema.oneOf) return schema.oneOf.some((candidate: any) => matchesSchema(candidate, value));
  if (Array.isArray(schema.type))
    return schema.type.some((type: string) => matchesSchema({ ...schema, type }, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (
    schema.type !== "object" ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return false;
  if (schema.additionalProperties !== false) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(key in schema.properties))) return false;
  if (schema.required.some((key: string) => !(key in record))) return false;
  return Object.entries(record).every(([key, entry]) =>
    matchesSchema(schema.properties[key], entry),
  );
}

describe("stable tracker tools", () => {
  test("registers and executes the four approved contracts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-plugin-tools-"));
    const registered: any[] = [];
    const sessions: Record<string, any> = {
      root: { id: "root", projectID: "project-safe", parentID: undefined, agent: "orchestrator" },
      lane: { id: "lane", projectID: "project-safe", parentID: "root", agent: "worker" },
      "failure-root": {
        id: "failure-root",
        projectID: "project-safe",
        parentID: undefined,
        agent: "orchestrator",
      },
    };
    const context = {
      options: { dataDir: directory },
      location: {
        directory: "/safe/workspace",
        project: { id: "project-safe" },
        workspaceID: "workspace-safe",
      },
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
      event: {
        subscribe: async function* () {
          /* no lifecycle events in this contract test */
        },
      },
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
    expect(registered.every((tool) => tool.output)).toBe(true);
    const run = await registered[0].execute({ beadID: "bead-test-tools" }, { sessionID: "root" });
    expect(matchesSchema(registered[0].output, run.output)).toBe(true);
    const lane = await registered[1].execute({ runID: run.output.runID, sessionID: "lane" }, {});
    expect(matchesSchema(registered[1].output, lane.output)).toBe(true);
    const closeout = await registered[2].execute({ beadID: "bead-test-tools" }, {});
    expect(matchesSchema(registered[2].output, closeout.output)).toBe(true);
    const report = await registered[3].execute({ bead: "bead-test-tools" }, {});
    expect(matchesSchema(registered[3].output, report.output)).toBe(true);
    expect(Object.keys(report.output.summary)).toEqual(["elapsedMs", "activeMs", "passes"]);
    expect(report.output.url).not.toContain(run.output.runID);
    const defaultReport = await registered[3].execute(undefined, { sessionID: "root" });
    expect(matchesSchema(registered[3].output, defaultReport.output)).toBe(true);
    expect(defaultReport.output.url).not.toContain(run.output.runID);
    const runFallback = await registered[0].execute(
      { beadID: "bead-run-failure" },
      { sessionID: "missing-session" },
    );
    expect(matchesSchema(registered[0].output, runFallback.output)).toBe(true);
    const laneFallback = await registered[1].execute(
      { runID: run.output.runID, sessionID: "missing-session" },
      {},
    );
    expect(matchesSchema(registered[1].output, laneFallback.output)).toBe(true);
    const closeoutFallback = await registered[2].execute({ beadID: "missing-bead" }, {});
    expect(matchesSchema(registered[2].output, closeoutFallback.output)).toBe(true);
    expect(closeoutFallback.output.status).toBe("not-finalized");
    await registered[0].execute({ beadID: "bead-report-failure" }, { sessionID: "failure-root" });
    mkdirSync(join(directory, "reports", "beads", "bead-report-failure", "report.html"), {
      recursive: true,
    });
    const reportFailure = await registered[2].execute({ beadID: "bead-report-failure" }, {});
    expect(matchesSchema(registered[2].output, reportFailure.output)).toBe(true);
    expect(reportFailure.output.status).toBe("finalized-report-failed");
    if (typeof cleanup === "function") await cleanup();
    rmSync(directory, { recursive: true, force: true });
  });
});
