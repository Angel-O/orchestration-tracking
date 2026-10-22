import { Plugin } from "@opencode/plugin";
import { AttributionTransitions } from "./attribution.js";
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

const transitionOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    changed: { type: "boolean" },
  },
  required: ["ok", "changed"],
  additionalProperties: false,
} as const;

function toolReceiptID(context: unknown, fallback: string): string {
  if (context && typeof context === "object") {
    const value = context as Record<string, unknown>;
    for (const key of ["toolCallID", "callID", "messageID"]) {
      if (typeof value[key] === "string" && value[key].length > 0) return value[key];
    }
  }
  return fallback;
}

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

      let toolRegistration: { dispose: () => unknown } | undefined;
      if (ctx.tool) {
        const transitions = new AttributionTransitions(store);
        toolRegistration = await ctx.tool.transform((tools) => {
          const input = (properties: Record<string, unknown>) => ({
            type: "object",
            properties,
            required: ["beadID"],
            additionalProperties: false,
          });
          const execute =
            (operation: "created" | "select" | "closeout") =>
            async (rawArgs: unknown, context: unknown) => {
              try {
                const args =
                  rawArgs && typeof rawArgs === "object"
                    ? (rawArgs as Record<string, unknown>)
                    : {};
                const sessionID =
                  context && typeof context === "object"
                    ? (context as Record<string, unknown>).sessionID
                    : undefined;
                if (typeof sessionID !== "string" || sessionID.length === 0)
                  return { output: { ok: false, changed: false } };
                const beadID = args.beadID;
                const receiptID = toolReceiptID(
                  context,
                  `tracking-${operation}:${sessionID}:${Date.now()}`,
                );
                const transitionContext = { sessionID, receiptID, observedAt: Date.now() };
                const result =
                  operation === "created"
                    ? await transitions.beadCreated(beadID, transitionContext)
                    : operation === "select"
                      ? await transitions.beadSelected(beadID, transitionContext)
                      : await transitions.closeout(beadID, transitionContext);
                return { output: result };
              } catch (error) {
                diagnose(`${operation} attribution failed; delivery continues`, error);
                return { output: { ok: false, changed: false } };
              }
            };

          tools.add({
            name: "tracking_bead_created",
            options: { permission: "orchestration_tracking", codemode: false },
            description: "Register a newly created, authoritatively validated Bead.",
            input: input({ beadID: { type: "string", minLength: 1 } }),
            output: transitionOutputSchema,
            execute: execute("created"),
          });
          tools.add({
            name: "tracking_bead_select",
            options: { permission: "orchestration_tracking", codemode: false },
            description: "Explicitly associate the invoking session with a validated Bead.",
            input: input({ beadID: { type: "string", minLength: 1 } }),
            output: transitionOutputSchema,
            execute: execute("select"),
          });
          tools.add({
            name: "tracking_closeout",
            options: { permission: "orchestration_tracking", codemode: false },
            description: "Record tracker closeout for an authoritatively validated Bead.",
            input: input({ beadID: { type: "string", minLength: 1 } }),
            output: transitionOutputSchema,
            execute: execute("closeout"),
          });
        });
      }

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
        void toolRegistration?.dispose();
      };
    } catch (error) {
      store.close();
      diagnose("tracking hooks unavailable; tracking disabled", error);
    }
  },
});

export default TrackerPlugin;
