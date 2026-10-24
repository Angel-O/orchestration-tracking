import { Plugin } from "@opencode/plugin";
import { basename } from "node:path";
import { consumeLaunchDescriptor, type LaunchSession, type LaunchSessionAPI } from "./launch.js";
import { registerTrackingTools, type ToolRegistrar } from "./tools.js";
import { parseOptions } from "../config/options.js";
import type { ReportSelector } from "../reporting/models.js";
import {
  createReportViewer,
  type ReportViewer,
  type ReportViewerMetadata,
  type ReportViewerOptions,
} from "../reporting/viewer.js";
import { TrackerStore } from "../tracking/store.js";

const PLUGIN_ID = "orchestration-tracking";

type HostSession = LaunchSession & {
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

function diagnose(message: string, error: unknown): void {
  // Host identifiers and SQLite paths can be private; diagnostics intentionally expose only an error kind.
  const kind = error instanceof Error ? error.name : "UnknownError";
  console.warn(`[${PLUGIN_ID}] ${message}: ${kind}`);
}

/** Keep only the final configured project directory component; never persist its path. */
function privacySafeProjectLabel(location: unknown): string {
  if (typeof location !== "object" || location === null || Array.isArray(location))
    return "unknown";
  const value = location as Record<string, unknown>;
  const project =
    typeof value.project === "object" && value.project !== null && !Array.isArray(value.project)
      ? (value.project as Record<string, unknown>)
      : undefined;
  const directory = project?.directory ?? value.directory;
  if (typeof directory !== "string") return "unknown";
  const label = basename(directory);
  return label && label !== "." && label !== ".." ? label : "unknown";
}

function reportViewerMetadata(viewer: ReportViewer): ReportViewerMetadata {
  return {
    url: viewer.url,
    expiresAt: viewer.expiresAt,
    browserOpened: viewer.browserOpened,
  };
}

/** Composition root: host lifecycle remains here while launch admission and tools stay separate. */
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
            ctx.session as unknown as LaunchSessionAPI,
            store,
            hostSession,
            startedAt,
            diagnose,
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
        toolRegistration = await registerTrackingTools(
          ctx.tool as unknown as ToolRegistrar,
          store,
          deliverViewer,
          diagnose,
        );
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
