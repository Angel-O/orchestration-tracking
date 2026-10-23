export { default, TrackerPlugin } from "./plugin.js";
export {
  DEFAULT_PHASE_MAPPINGS,
  SCHEMA_VERSION,
  UNMAPPED_PHASE,
  mappingFor,
  parseOptions,
  type PhaseMapping,
  type PhaseMappings,
  type TrackerOptions,
} from "./config/options.js";
export {
  RETENTION_CLEANUP_BATCH_SIZE,
  TrackerStore,
  UNASSIGNED_RETENTION_MS,
} from "./tracking/store.js";
export { DATABASE_FILENAME } from "./tracking/schema.js";
export type {
  ActionEnd,
  ActionOutcome,
  ActionRecord,
  ActionStart,
  ActivitySliceRecord,
  AssociationReceiptRecord,
  AssociationRecord,
  AssociationSource,
  BeadRecord,
  BeadType,
  CloseoutRecord,
  CloseoutRecordView,
  LifecycleReceipt,
  LifecycleReceiptRecord,
  ReportMetadata,
  ReportMetadataRecord,
  ReportSnapshot,
  RetentionCleanupResult,
  SessionObservation,
  SessionRecord,
  TopologyRecord,
} from "./tracking/models.js";
export { LAUNCH_METADATA_KEY } from "./plugin.js";
export { sourceReleasePlan, type SourceReleasePlan } from "./release/source-release.js";
export { validateBeadID, parseTimestamp } from "./shared/validation.js";
export { buildReportModels } from "./reporting/build.js";
export { generateReport } from "./reporting/artifacts.js";
export { renderReport } from "./reporting/markdown.js";
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
export { renderReportDetailHtml } from "./reporting/html.js";
export {
  createReportViewer,
  launchReportViewerBrowser,
  REPORT_VIEWER_LIFETIME_MS,
  type ReportViewer,
  type ReportViewerLauncher,
  type ReportViewerMetadata,
  type ReportViewerOptions,
} from "./reporting/viewer.js";
export {
  validateAuthoritativeBead,
  runWbdShow,
  type ValidatedBead,
  type WbdShowRunner,
} from "./attribution/authoritative-bead.js";
export {
  AttributionTransitions,
  type TransitionContext,
  type TransitionResult,
} from "./attribution/transitions.js";
