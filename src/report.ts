/**
 * Compatibility facade for the historical reporting module path.
 * Implementations now live under `reporting/` so pure projections/renderers
 * remain separate from artifact persistence.
 */
import { buildReportModels as buildReportModelsProjection } from "./reporting/build.js";
import type { ReportSnapshot } from "./tracking/models.js";
import type { ReportModels, ReportSelector } from "./reporting/models.js";

/** Preserve the historical optional generation-time argument at the facade. */
export function buildReportModels(
  snapshot: ReportSnapshot,
  input: ReportSelector = {},
  generatedAt = Date.now(),
): ReportModels {
  return buildReportModelsProjection(snapshot, input, generatedAt);
}
export { renderReport } from "./reporting/markdown.js";
export { generateReport } from "./reporting/artifacts.js";
export {
  PRIVACY_NOTICE,
  REPORT_NOTICES,
  REPORTING_POLICY_VERSION,
  REPORT_PHASES,
  type ChildSummary,
  type InitiativeState,
  type ReportDetailAgentTotal,
  type ReportDetailModel,
  type ReportDetailPass,
  type ReportDetailPhaseTotal,
  type ReportDetailRepeatSignal,
  type ReportDetailSessionTotal,
  type ReportDetailTimelineSegment,
  type LifecycleState,
  type NormalizedSelector,
  type OutcomeCounts,
  type PhaseMetric,
  type ReportAction,
  type ReportDocument,
  type ReportGenerationResult,
  type ReportKind,
  type ReportMetrics,
  type ReportModels,
  type ReportPhase,
  type ReportSelector,
  type ReportSession,
} from "./reporting/models.js";
