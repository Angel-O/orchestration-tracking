import { Plugin } from "@opencode/plugin";
import { parseOptions } from "./options.js";
import { TrackerStore } from "./store.js";

const PLUGIN_ID = "orchestration-tracking";

function diagnose(message: string, error: unknown): void {
  // Host identifiers and SQLite paths can be private; diagnostics intentionally expose only an error kind.
  const kind = error instanceof Error ? error.name : "UnknownError";
  console.warn(`[${PLUGIN_ID}] ${message}: ${kind}`);
}

type HostSession = {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
};

type HostEvent = {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: {
    readonly sessionID: string;
    readonly parentID?: string;
    readonly messageID?: string;
    readonly projectID?: string;
    readonly location?: { readonly workspaceID?: string };
  };
  readonly durable?: { readonly aggregateID?: string; readonly seq?: number };
};

export const TrackerPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    let store: TrackerStore;
    try {
      store = TrackerStore.open(parseOptions(ctx.options));
    } catch (error) {
      diagnose("tracking disabled", error);
      return;
    }

    try {
      await ctx.session.hook("prompt", async (event) => {
        try {
          const hostSession = (await ctx.session.get({
            sessionID: event.sessionID,
          })) as HostSession;
          store.recordSession({
            sessionID: hostSession.id,
            parentSessionID: hostSession.parentID,
          });
          store.startAction({
            sessionID: hostSession.id,
            actionID: event.messageID,
            observedRole: hostSession.agent,
            receiptID: event.messageID,
          });
        } catch (error) {
          diagnose("action observation failed; delivery continues", error);
        }
      });

      const abort = new AbortController();
      void (async () => {
        for await (const rawEvent of ctx.event.subscribe({ signal: abort.signal })) {
          const event = rawEvent as unknown as HostEvent;
          try {
            if (event.type === "session.created") {
              store.recordSession({
                sessionID: event.data.sessionID,
                parentSessionID: event.data.parentID,
                observedAt: event.created,
                receipt: {
                  eventID: event.id,
                  aggregateID: event.durable?.aggregateID ?? event.data.sessionID,
                  sequence: event.durable?.seq ?? 0,
                  eventType: "session.created",
                  observedAt: event.created,
                },
              });
              continue;
            }
            if (event.type === "session.deleted") {
              const staleActions = store
                .listActions()
                .filter((action) => action.sessionID === event.data.sessionID)
                .map(({ sessionID, actionID }) => ({ sessionID, actionID }));
              store.recoverStaleActions(staleActions, {
                eventID: event.id,
                aggregateID: event.durable?.aggregateID ?? event.data.sessionID,
                sequence: event.durable?.seq ?? 0,
                eventType: "session.deleted",
                observedAt: event.created,
              });
              continue;
            }
            if (
              event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed" ||
              event.type === "session.execution.interrupted"
            ) {
              const outcome =
                event.type === "session.execution.succeeded"
                  ? "completed"
                  : event.type === "session.execution.failed"
                    ? "failed"
                    : "interrupted";
              store.endAction({
                eventID: event.id,
                aggregateID: event.durable?.aggregateID ?? event.data.sessionID,
                sequence: event.durable?.seq ?? 0,
                sessionID: event.data.sessionID,
                actionID: event.data.messageID,
                outcome,
                endedAt: event.created,
              });
            }
          } catch (error) {
            diagnose("lifecycle observation failed; delivery continues", error);
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
