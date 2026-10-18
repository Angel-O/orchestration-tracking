import { createHash } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import { parseOptions } from "./options.js";
import { TrackerStore, type SessionInput } from "./store.js";

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
      };
    } catch (error) {
      store.close();
      diagnose("tracking hooks unavailable; tracking disabled", error);
    }
  },
});

export default TrackerPlugin;
