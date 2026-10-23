import { describe, expect, test } from "bun:test";
import * as root from "orchestration-tracking";
import * as plugin from "orchestration-tracking/plugin";

// Type-only exports disappear at runtime, so keep their presence in the compile-time contract.
type RootTypeExports = [
  root.PhaseMapping,
  root.PhaseMappings,
  root.TrackerOptions,
  root.ActionEnd,
  root.ActionOutcome,
  root.ActionRecord,
  root.ActionStart,
  root.ActivitySliceRecord,
  root.AssociationReceiptRecord,
  root.AssociationRecord,
  root.AssociationSource,
  root.BeadRecord,
  root.BeadType,
  root.CloseoutRecord,
  root.CloseoutRecordView,
  root.LifecycleReceipt,
  root.LifecycleReceiptRecord,
  root.ReportMetadata,
  root.ReportMetadataRecord,
  root.ReportSnapshot,
  root.RetentionCleanupResult,
  root.SessionObservation,
  root.SessionRecord,
  root.TopologyRecord,
  root.SourceReleasePlan,
  root.ChildSummary,
  root.InitiativeState,
  root.ReportDetailAgentTotal,
  root.ReportDetailModel,
  root.ReportDetailPass,
  root.ReportDetailPhaseTotal,
  root.ReportDetailRepeatSignal,
  root.ReportDetailSessionTotal,
  root.ReportDetailTimelineSegment,
  root.LifecycleState,
  root.NormalizedSelector,
  root.OutcomeCounts,
  root.PhaseMetric,
  root.ReportAction,
  root.ReportDocument,
  root.ReportGenerationResult,
  root.ReportKind,
  root.ReportMetrics,
  root.ReportModels,
  root.ReportPhase,
  root.ReportSelector,
  root.ReportSession,
  root.ReportViewer,
  root.ReportViewerLauncher,
  root.ReportViewerMetadata,
  root.ReportViewerOptions,
  root.TransitionContext,
  root.TransitionResult,
  root.ValidatedBead,
  root.WbdShowRunner,
];

describe("portable package export contract", () => {
  test("loads the complete root and plugin entry-point surfaces", () => {
    void (undefined as RootTypeExports | undefined);
    expect(Object.keys(root).sort()).toEqual([
      "AttributionTransitions",
      "DATABASE_FILENAME",
      "DEFAULT_PHASE_MAPPINGS",
      "LAUNCH_METADATA_KEY",
      "PRIVACY_NOTICE",
      "REPORTING_POLICY_VERSION",
      "REPORT_NOTICES",
      "REPORT_PHASES",
      "REPORT_VIEWER_LIFETIME_MS",
      "RETENTION_CLEANUP_BATCH_SIZE",
      "SCHEMA_VERSION",
      "TrackerPlugin",
      "TrackerStore",
      "UNASSIGNED_RETENTION_MS",
      "UNMAPPED_PHASE",
      "buildReportModels",
      "createReportViewer",
      "default",
      "generateReport",
      "launchReportViewerBrowser",
      "mappingFor",
      "parseOptions",
      "parseTimestamp",
      "renderReport",
      "renderReportDetailHtml",
      "runWbdShow",
      "sourceReleasePlan",
      "validateAuthoritativeBead",
      "validateBeadID",
    ]);
    expect(Object.keys(plugin).sort()).toEqual(["LAUNCH_METADATA_KEY", "TrackerPlugin", "default"]);
    expect(root.default).toBe(plugin.default);
    expect(root.TrackerPlugin).toBe(plugin.TrackerPlugin);
    expect(root.LAUNCH_METADATA_KEY).toBe(plugin.LAUNCH_METADATA_KEY);
    expect(root.default).toBe(root.TrackerPlugin);
    expect(root.TrackerPlugin.id).toBe("orchestration-tracking");
    expect(typeof root.TrackerPlugin.setup).toBe("function");
  });
});
