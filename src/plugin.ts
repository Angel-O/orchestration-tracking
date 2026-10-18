import { createHash } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import { parseOptions } from "./options.js";
import { TrackerStore, type SessionInput } from "./store.js";
import { writeReport } from "./report.js";

const PLUGIN_ID = "orchestration-tracking";

function projectLabel(directory: string): string {
  return `workspace-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`;
}

function diagnose(message: string, error: unknown): void {
  // Keep diagnostics local and content-free; SQLite/path details can contain private data.
  const kind = error instanceof Error ? error.name : "UnknownError";
  console.warn(`[${PLUGIN_ID}] ${message}: ${kind}`);
}

export const TrackerPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    let store: TrackerStore;
    try {
      const options = parseOptions(ctx.options);
      store = TrackerStore.open(options);
    } catch (error) {
      diagnose("tracking disabled", error);
      return;
    }

    const label = projectLabel(ctx.location.directory);
    const baseSession = (
      sessionID: string,
      parentID?: string,
      projectID: string = ctx.location.project.id,
      workspaceID?: string,
    ): SessionInput => ({
      sessionID,
      parentID,
      projectID,
      workspaceID,
      projectLabel: label,
    });

    try {
      await ctx.session.hook("prompt", async (event) => {
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID });
          store.admit({
            ...baseSession(event.sessionID, session.parentID, session.projectID, ctx.location.workspaceID),
            messageID: event.messageID,
            agent: session.agent,
          });
        } catch (error) {
          diagnose("prompt admission failed; delivery continues", error);
        }
      });

      const toolRegistration = await ctx.tool.transform((tools) => {
        const input = (properties: Record<string, unknown>, required: string[] = []) => ({
          type: "object",
          properties,
          required,
          additionalProperties: false,
        });
        const sessionInput = async (sessionID: string): Promise<SessionInput> => {
          const session = await ctx.session.get({ sessionID });
          return baseSession(session.id, session.parentID, session.projectID, ctx.location.workspaceID);
        };
        tools.add({
          name: "tracking_run_start",
          description: "Start or resume the tracker run rooted at the invoking OpenCode session.",
          input: input({ beadID: { type: "string", minLength: 1 } }, ["beadID"]),
          execute: async (rawArgs, context) => {
            const args = rawArgs as { beadID: string };
            try {
              const root = await sessionInput(context.sessionID);
              return { output: store.startRun({ beadID: args.beadID, root }) };
            } catch (error) {
              diagnose("run association failed; delivery continues", error);
              return { output: { started: false } };
            }
          },
        });
        tools.add({
          name: "tracking_lane_attach",
          description: "Attach an actual OpenCode primary session to an active tracker run.",
          input: input({ runID: { type: "string", minLength: 1 }, sessionID: { type: "string", minLength: 1 } }, ["runID", "sessionID"]),
          execute: async (rawArgs) => {
            const args = rawArgs as { runID: string; sessionID: string };
            try {
              // Fetching the session here deliberately prevents callers from relabeling its agent.
              const lane = await sessionInput(args.sessionID);
              store.attachLane({ runID: args.runID, session: lane });
              return { output: { attached: true, sessionID: lane.sessionID } };
            } catch (error) {
              diagnose("lane association failed; delivery continues", error);
              return { output: { attached: false } };
            }
          },
        });
        tools.add({
          name: "tracking_closeout",
          description: "Finalize the matching run after successful Bead closeout and regenerate its private report.",
          input: input({ beadID: { type: "string", minLength: 1 } }, ["beadID"]),
          execute: async (rawArgs) => {
            const args = rawArgs as { beadID: string };
            try {
              store.finalizeRun(args.beadID);
            } catch (error) {
              diagnose("closeout finalization failed; delivery continues", error);
              return { output: { status: "not-finalized", finalized: false, report: null } };
            }
            try {
              const report = writeReport(store, { bead: args.beadID });
              return { output: { status: "finalized", finalized: true, report } };
            } catch (error) {
              diagnose("report rendering failed after closeout", error);
              return { output: { status: "finalized-report-failed", finalized: true, report: null } };
            }
          },
        });
        tools.add({
          name: "tracking_report",
          description: "Read-only report for one Bead, selected sessions, and/or an intersecting time range.",
          input: input({
            bead: { type: "string" },
            sessions: { type: "array", items: { type: "string" }, minItems: 1 },
            from: { type: "string" },
            to: { type: "string" },
          }),
          execute: async (args: unknown, context) => ({ output: writeReport(store, args, Date.now(), context.sessionID) }),
        });
      });

      const abort = new AbortController();
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            if (event.type === "session.created") {
              store.recordSession({
                sessionID: event.data.sessionID,
                parentID: event.data.parentID,
                projectID: event.data.projectID,
                workspaceID: event.data.location.workspaceID,
                projectLabel: label,
              });
              continue;
            }
            if (
              event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed" ||
              event.type === "session.execution.interrupted"
            ) {
              store.closeExecution({
                eventID: event.id,
                aggregateID: event.durable.aggregateID,
                sequence: event.durable.seq,
                sessionID: event.data.sessionID,
                outcome: event.type === "session.execution.succeeded"
                  ? "completed"
                  : event.type === "session.execution.failed" ? "failed" : "interrupted",
                endedAt: event.created,
                session: baseSession(event.data.sessionID),
              });
            }
          } catch (error) {
            diagnose("lifecycle receipt failed; delivery continues", error);
          }
        }
      })().catch((error) => {
        if (!abort.signal.aborted) diagnose("event subscription stopped", error);
      });

      return () => {
        abort.abort();
        store.close();
        void toolRegistration.dispose();
      };
    } catch (error) {
      store.close();
      diagnose("tracking hooks unavailable; tracking disabled", error);
    }
  },
});

export default TrackerPlugin;
