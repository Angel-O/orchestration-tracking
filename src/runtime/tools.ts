import { AttributionTransitions } from "../attribution/transitions.js";
import { generateReport, type ReportGenerationResult, type ReportSelector } from "../report.js";
import { type ReportViewerMetadata } from "../report-viewer.js";
import { TrackerStore } from "../tracking/store.js";
import { validateBeadID } from "../shared/validation.js";

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

type Diagnose = (message: string, error: unknown) => void;

type RegisteredTool = {
  readonly name: string;
  readonly options: { readonly permission: string; readonly codemode: false };
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown>;
  readonly execute: (rawArgs: unknown, context?: unknown) => Promise<{ output: unknown }>;
};

type ToolRegistrar = {
  readonly transform: (
    callback: (tools: { readonly add: (tool: RegisteredTool) => void }) => void,
  ) => Promise<{ readonly dispose: () => unknown }>;
};

type DeliverViewer = (selector: ReportSelector) => Promise<ReportViewerMetadata>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** Register tracking tools; execution remains non-blocking for host delivery. */
export async function registerTrackingTools(
  tool: ToolRegistrar,
  store: TrackerStore,
  deliverViewer: DeliverViewer,
  diagnose: Diagnose,
): Promise<{ readonly dispose: () => unknown }> {
  const transitions = new AttributionTransitions(store);
  return tool.transform((tools) => {
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
            rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
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
