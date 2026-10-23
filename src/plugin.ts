import { Plugin } from "@opencode/plugin";
import { basename } from "node:path";
import { validateAuthoritativeBead, type ValidatedBead } from "./attribution/authoritative-bead.js";
import { AttributionTransitions } from "./attribution/transitions.js";
import { parseOptions } from "./config/options.js";
import { generateReport, type ReportGenerationResult, type ReportSelector } from "./report.js";
import {
  createReportViewer,
  type ReportViewer,
  type ReportViewerMetadata,
  type ReportViewerOptions,
} from "./report-viewer.js";
import { TrackerStore } from "./tracking/store.js";
import { validateBeadID } from "./shared/validation.js";

const PLUGIN_ID = "orchestration-tracking";
export const LAUNCH_METADATA_KEY = "orchestration-tracking.launch";

type LaunchDescriptor = {
  readonly version: 1;
  readonly targetSessionID: string;
  readonly beadID: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLaunchDescriptor(value: unknown): LaunchDescriptor {
  if (!isRecord(value)) throw new Error("invalid launch descriptor");
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "version" || key === "targetSessionID" || key === "beadID")
  )
    throw new Error("invalid launch descriptor");
  if (
    value.version !== 1 ||
    typeof value.targetSessionID !== "string" ||
    value.targetSessionID.length === 0 ||
    value.targetSessionID.length > 256
  )
    throw new Error("invalid launch descriptor");
  return {
    version: 1,
    targetSessionID: value.targetSessionID,
    beadID: validateBeadID(value.beadID),
  };
}

async function consumeLaunchDescriptor(
  sessionAPI: {
    readonly update?: (input: {
      readonly sessionID: string;
      readonly metadata: Record<string, unknown>;
    }) => Promise<unknown>;
  },
  store: TrackerStore,
  session: HostSession,
  observedAt: number,
): Promise<void> {
  const metadata = session.metadata;
  if (!isRecord(metadata) || !Object.prototype.hasOwnProperty.call(metadata, LAUNCH_METADATA_KEY))
    return;

  let descriptor: LaunchDescriptor;
  try {
    descriptor = parseLaunchDescriptor(metadata[LAUNCH_METADATA_KEY]);
    if (descriptor.targetSessionID !== session.id) throw new Error("launch target mismatch");
    const bead = await validateAuthoritativeBead(descriptor.beadID);
    const topologies: ValidatedBead[] = [];
    if (bead.parentBeadID !== undefined) {
      const parent = await validateAuthoritativeBead(bead.parentBeadID);
      if (parent.type !== "epic" || parent.parentBeadID !== undefined)
        throw new Error("authoritative parent topology is invalid");
      topologies.push(parent);
    }
    topologies.push(bead);
    const localBeads = new Map(store.listBeads().map((bead) => [bead.beadID, bead]));
    for (const topology of topologies) {
      const existing = localBeads.get(topology.beadID);
      if (
        existing &&
        (existing.type !== topology.type ||
          existing.parentBeadID !== (topology.parentBeadID ?? null))
      )
        throw new Error("authoritative validation conflicts with local topology");
    }
    for (const topology of topologies)
      store.recordTopology({ ...topology, validatedAt: observedAt });
    if (
      !store.recordAssociation({
        receiptID: `launch:${session.id}:v1`,
        sessionID: session.id,
        beadID: descriptor.beadID,
        source: "launch-descriptor",
        observedAt,
      })
    )
      return;
  } catch (error) {
    diagnose("launch descriptor ignored; delivery continues", error);
    return;
  }

  try {
    const remaining = { ...metadata };
    delete remaining[LAUNCH_METADATA_KEY];
    if (!sessionAPI.update) throw new Error("session metadata update unavailable");
    await sessionAPI.update({ sessionID: session.id, metadata: remaining });
  } catch (error) {
    diagnose("launch descriptor removal failed; delivery continues", error);
  }
}

function diagnose(message: string, error: unknown): void {
  // Host identifiers and SQLite paths can be private; diagnostics intentionally expose only an error kind.
  const kind = error instanceof Error ? error.name : "UnknownError";
  console.warn(`[${PLUGIN_ID}] ${message}: ${kind}`);
}

/** Keep only the final configured project directory component; never persist its path. */
function privacySafeProjectLabel(location: unknown): string {
  if (!isRecord(location)) return "unknown";
  const project = isRecord(location.project) ? location.project : undefined;
  const directory = project?.directory ?? location.directory;
  if (typeof directory !== "string") return "unknown";
  const label = basename(directory);
  return label && label !== "." && label !== ".." ? label : "unknown";
}

type HostSession = {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
  readonly metadata?: Record<string, unknown>;
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
    viewer: {
      type: "object",
      properties: {
        url: { type: "string" },
        expiresAt: { type: "integer" },
        browserOpened: { type: "boolean" },
      },
      required: ["url", "expiresAt", "browserOpened"],
      additionalProperties: false,
    },
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

function parseReportSelector(value: unknown): ReportSelector {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("invalid report selector");
  const allowed = new Set(["bead", "sessions", "from", "to"]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("invalid report selector");
  if (value.bead !== undefined && typeof value.bead !== "string")
    throw new Error("invalid report selector");
  if (
    value.sessions !== undefined &&
    (!Array.isArray(value.sessions) ||
      value.sessions.some((session) => typeof session !== "string"))
  )
    throw new Error("invalid report selector");
  for (const key of ["from", "to"] as const) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    )
      throw new Error("invalid report selector");
  }
  const selector: { bead?: string; sessions?: string[]; from?: number; to?: number } = {};
  if (value.bead !== undefined) selector.bead = value.bead;
  if (value.sessions !== undefined) selector.sessions = value.sessions as string[];
  if (value.from !== undefined) selector.from = value.from as number;
  if (value.to !== undefined) selector.to = value.to as number;
  return selector;
}

function reportToolResult(
  result: ReportGenerationResult,
): Omit<ReportGenerationResult, "artifactPath" | "renderedArtifactPath"> {
  return {
    reportID: result.reportID,
    artifactKey: result.artifactKey,
    renderedArtifactKey: result.renderedArtifactKey,
    sourceHighWaterMark: result.sourceHighWaterMark,
    report: result.report,
  };
}

function reportViewerMetadata(viewer: ReportViewer): ReportViewerMetadata {
  return {
    url: viewer.url,
    expiresAt: viewer.expiresAt,
    browserOpened: viewer.browserOpened,
  };
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
      store.cleanupUnassigned();
    } catch (error) {
      diagnose("retention cleanup failed; delivery continues", error);
    }
    const configuredProjectLabel = privacySafeProjectLabel(
      (ctx as unknown as { readonly location?: unknown }).location,
    );
    let lastCleanupAt = Date.now();
    const maybeCleanup = (): void => {
      const now = Date.now();
      if (now - lastCleanupAt < 24 * 60 * 60 * 1000) return;
      lastCleanupAt = now;
      try {
        store.cleanupUnassigned(now);
      } catch (error) {
        diagnose("retention cleanup failed; delivery continues", error);
      }
    };

    try {
      await ctx.session.hook("prompt", async (event) => {
        try {
          maybeCleanup();
          const hostSession = (await ctx.session.get({
            sessionID: event.sessionID,
          })) as HostSession;
          const startedAt = Date.now();
          store.recordSession({
            sessionID: hostSession.id,
            parentSessionID: hostSession.parentID,
            observedAt: startedAt,
            projectLabel: configuredProjectLabel,
          });
          await consumeLaunchDescriptor(
            ctx.session as unknown as {
              readonly update: (input: {
                readonly sessionID: string;
                readonly metadata: Record<string, unknown>;
              }) => Promise<unknown>;
            },
            store,
            hostSession,
            startedAt,
          );
          store.startAction({
            sessionID: hostSession.id,
            actionID: event.messageID,
            observedRole: hostSession.agent,
            startedAt,
            receiptID: event.messageID,
          });
        } catch (error) {
          diagnose("action observation failed; delivery continues", error);
        }
      });

      let toolRegistration: { dispose: () => unknown } | undefined;
      const viewers = new Set<ReportViewer>();
      const pendingViewerDeliveries = new Set<Promise<ReportViewerMetadata>>();
      const viewerAbort = new AbortController();
      let disposed = false;
      let cleanupPromise: Promise<void> | undefined;
      // Internal host seam used by focused tests; production uses viewer defaults.
      const viewerOptions = (
        ctx as unknown as { readonly reportViewerOptions?: ReportViewerOptions }
      ).reportViewerOptions;
      const deliverViewer = (selector: ReportSelector): Promise<ReportViewerMetadata> => {
        const delivery = (async () => {
          if (disposed) throw new Error("report viewer delivery disposed");
          const viewer = await createReportViewer(store, selector, {
            ...viewerOptions,
            signal: viewerAbort.signal,
          });
          if (disposed) {
            viewer.dispose();
            throw new Error("report viewer delivery disposed");
          }
          viewers.add(viewer);
          return reportViewerMetadata(viewer);
        })();
        pendingViewerDeliveries.add(delivery);
        delivery.then(
          () => pendingViewerDeliveries.delete(delivery),
          () => pendingViewerDeliveries.delete(delivery),
        );
        return delivery;
      };
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
                if (operation === "closeout" && result.ok) {
                  try {
                    generateReport(store, { bead: validateBeadID(beadID) });
                  } catch (error) {
                    // Closeout is already committed; report/render failure must not block delivery.
                    diagnose("closeout report regeneration failed; delivery continues", error);
                  }
                  try {
                    const viewer = await deliverViewer({ bead: validateBeadID(beadID) });
                    return { output: { ...result, viewer } };
                  } catch (error) {
                    // Closeout is already committed; viewer failure must not block delivery.
                    diagnose("closeout report viewer failed; delivery continues", error);
                  }
                }
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
          tools.add({
            name: "tracking_report",
            options: { permission: "orchestration_tracking", codemode: false },
            description: "Read a privacy-safe local tracker report.",
            input: {
              type: "object",
              properties: {
                bead: { type: "string", minLength: 1 },
                sessions: { type: "array", items: { type: "string", minLength: 1 } },
                from: { type: "integer", minimum: 0 },
                to: { type: "integer", minimum: 0 },
              },
              required: [],
              additionalProperties: false,
            },
            output: { type: "object", additionalProperties: true },
            execute: async (rawArgs: unknown) => {
              try {
                const selector = parseReportSelector(rawArgs);
                const output = reportToolResult(generateReport(store, selector));
                if (Object.keys(selector).length === 0) return { output };
                try {
                  const viewer = await deliverViewer(selector);
                  return { output: { ...output, viewer } };
                } catch (error) {
                  // Viewer failure is additive; the structured report remains usable.
                  diagnose("report viewer failed; delivery continues", error);
                }
                return { output };
              } catch (error) {
                diagnose("report generation failed; delivery continues", error);
                return { output: { ok: false, changed: false } };
              }
            },
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
                projectLabel: configuredProjectLabel,
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

      const finishCleanup = (): void => {
        for (const viewer of viewers) viewer.dispose();
        viewers.clear();
        store.close();
        void toolRegistration?.dispose();
      };
      return () => {
        if (cleanupPromise !== undefined) return cleanupPromise;
        disposed = true;
        abort.abort();
        viewerAbort.abort();
        for (const viewer of viewers) viewer.dispose();
        viewers.clear();
        const pending = [...pendingViewerDeliveries];
        if (pending.length === 0) {
          finishCleanup();
          return;
        }
        cleanupPromise = Promise.allSettled(pending).then(() => {
          pendingViewerDeliveries.clear();
          finishCleanup();
        });
        return cleanupPromise;
      };
    } catch (error) {
      store.close();
      diagnose("tracking hooks unavailable; tracking disabled", error);
    }
  },
});

export default TrackerPlugin;
