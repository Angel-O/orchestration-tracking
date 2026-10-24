import type { ActionOutcome, BeadType } from "../tracking/models.js";

/** Fixed policy; callers cannot supply phase or purpose language. */
export const REPORTING_POLICY_VERSION = "session-attribution-v2" as const;
export const PRIVACY_NOTICE =
  "Derived from private local lifecycle facts; source content is not retained.";
export const REPORT_NOTICES = [
  "Summed active time includes concurrent lanes and can exceed elapsed time.",
  "Lifecycle values are observed tracker states, not authoritative Hub status.",
] as const;

export const REPORT_PHASES = [
  "scoping",
  "scoping-decomposition",
  "coordination",
  "implementation",
  "review",
  "integration-validation",
  "build",
  "unclassified",
] as const;
export type ReportPhase = (typeof REPORT_PHASES)[number];
export type ReportKind = "standalone" | "child" | "epic" | "sessions";

export interface ReportSelector {
  readonly bead?: string;
  readonly sessions?: readonly string[];
  readonly from?: number;
  readonly to?: number;
}

export interface NormalizedSelector {
  readonly bead?: string;
  readonly sessions?: readonly string[];
  readonly from?: number;
  readonly to?: number;
}

export interface PhaseMetric {
  readonly activeMs: number;
  readonly actionCount: number;
}

export interface OutcomeCounts {
  readonly open: number;
  readonly completed: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly incomplete: number;
}

export interface ReportMetrics {
  readonly activeMs: number;
  readonly elapsedMs: number;
  readonly sessionCount: number;
  readonly actionCount: number;
  readonly outcomes: OutcomeCounts;
  readonly directActiveMs?: number;
  readonly summedChildActiveMs?: number;
  readonly combinedActiveMs?: number;
  readonly initiativeElapsedMs?: number;
}

export interface ReportAction {
  readonly sliceID: number;
  readonly sessionID: string;
  readonly actionID: string;
  readonly role: string;
  readonly phase: ReportPhase;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: ActionOutcome;
  readonly activeMs: number;
}

export interface ReportSession {
  readonly sessionID: string;
  readonly activeMs: number;
  readonly actionCount: number;
}

export type LifecycleState =
  | "Not started"
  | "Active — closeout not observed"
  | "Closeout complete"
  | "Not applicable";

/** The epic-only initiative window state; child lifecycle remains tracker-derived. */
export type InitiativeState = "not-started" | "open" | "closeout-bounded";

export interface ChildSummary {
  readonly beadID: string;
  readonly type: Exclude<BeadType, "epic">;
  readonly lifecycleState: LifecycleState;
  readonly metrics: ReportMetrics;
  readonly phaseTotals: Readonly<Record<ReportPhase, PhaseMetric>>;
}

export interface ReportDocument {
  readonly policyVersion: typeof REPORTING_POLICY_VERSION;
  readonly generatedAt: number;
  readonly privacyNotice: typeof PRIVACY_NOTICE;
  readonly notices: readonly string[];
  readonly selector: NormalizedSelector;
  readonly kind: ReportKind;
  readonly beadID?: string;
  readonly lifecycleState: LifecycleState;
  readonly metrics: ReportMetrics;
  readonly phaseTotals: Readonly<Record<ReportPhase, PhaseMetric>>;
  readonly warnings: readonly string[];
  /** Present only for epic views; it describes the direct initiative window. */
  readonly initiativeState?: InitiativeState;
  readonly elapsed: {
    readonly startAt: number | null;
    readonly endAt: number | null;
    readonly durationMs: number;
    readonly open: boolean;
  };
  readonly sessions?: readonly ReportSession[];
  readonly actions?: readonly ReportAction[];
  readonly children?: readonly ChildSummary[];
}

/** One derived report phase bucket for the report-detail renderer. */
export interface ReportDetailPhaseTotal {
  readonly phaseKey: string;
  readonly phaseLabel: string;
  readonly color: string;
  readonly activeMs: number;
  readonly passCount: number;
}

/** One observed-agent bucket for the report-detail renderer. */
export interface ReportDetailAgentTotal {
  readonly agent: string;
  readonly activeMs: number;
  readonly passCount: number;
}

export interface ReportDetailSessionTotal {
  readonly sessionID: string;
  readonly projectLabel: string;
  readonly activeMs: number;
  readonly passCount: number;
  readonly outcomes: OutcomeCounts;
}

export interface ReportDetailTimelineSegment {
  readonly sliceID: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly activeMs: number;
  /** Percentages share the model's single selected time scale. */
  readonly startPercent: number;
  readonly endPercent: number;
  readonly widthPercent: number;
}

export interface ReportDetailPass {
  readonly passNumber: number;
  readonly sessionID: string;
  readonly actionID: string;
  readonly agent: string;
  readonly phaseKey: string;
  readonly phaseLabel: string;
  readonly color: string;
  readonly outcome: ActionOutcome;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly activeMs: number;
  readonly segments: readonly ReportDetailTimelineSegment[];
}

export interface ReportDetailRepeatSignal {
  readonly sessionID: string;
  readonly agent: string;
  readonly phaseLabel: string;
  readonly passes: number;
  readonly repeated: boolean;
  readonly passNumbers: readonly number[];
  readonly count: number;
  readonly repeatCount: number;
}

/**
 * Internal, write-free report-detail projection. It is built beside ReportDocument
 * so the HTML renderer never needs to reinterpret raw tracker facts.
 */
export interface ReportDetailModel {
  readonly kind: ReportKind;
  readonly beadID?: string;
  readonly status: LifecycleState;
  readonly generatedAt: number;
  readonly finalizedAt: number | null;
  readonly selection: NormalizedSelector;
  /** Current structured metrics retained for epic direct/child rendering. */
  readonly metrics: ReportMetrics;
  readonly phaseTotals: Readonly<Record<ReportPhase, PhaseMetric>>;
  readonly children?: readonly ChildSummary[];
  readonly projectLabel: string | null;
  readonly projectLabels: readonly string[];
  readonly durations: {
    readonly activeMs: number;
    readonly elapsedMs: number;
  };
  readonly phases: readonly ReportDetailPhaseTotal[];
  readonly agents: readonly ReportDetailAgentTotal[];
  readonly sessions: readonly ReportDetailSessionTotal[];
  readonly passes: readonly ReportDetailPass[];
  readonly scale: {
    readonly startAt: number | null;
    readonly endAt: number | null;
    readonly durationMs: number;
  };
  readonly repeats: readonly ReportDetailRepeatSignal[];
  readonly incomplete: boolean;
  readonly unmapped: boolean;
  readonly warnings: readonly string[];
}

export interface ReportModels {
  readonly selector: NormalizedSelector;
  readonly report: ReportDocument;
  readonly reportDetail: ReportDetailModel;
}

export interface ReportGenerationResult {
  readonly reportID: string;
  /** Absolute local path for the private JSON artifact; never included in either artifact. */
  readonly artifactPath: string;
  readonly artifactKey: string;
  /** Absolute local path for the deterministic human-readable view. */
  readonly renderedArtifactPath: string;
  readonly renderedArtifactKey: string;
  readonly sourceHighWaterMark: number;
  readonly report: ReportDocument;
}

export const PHASE_LABELS: Readonly<Record<ReportPhase, string>> = {
  scoping: "Scoping",
  "scoping-decomposition": "Scoping and decomposition",
  coordination: "Coordination",
  implementation: "Implementation",
  review: "Review",
  "integration-validation": "Integration validation",
  build: "Build",
  unclassified: "Unclassified",
};
export const STANDALONE_PHASE_ORDER: readonly ReportPhase[] = [
  "scoping",
  "coordination",
  "implementation",
  "review",
  "integration-validation",
  "build",
  "unclassified",
];
export const CHILD_PHASE_ORDER: readonly ReportPhase[] = [
  "coordination",
  "implementation",
  "review",
  "integration-validation",
  "build",
  "unclassified",
];
export const EPIC_PHASE_ORDER: readonly ReportPhase[] = [
  "scoping-decomposition",
  "coordination",
  "unclassified",
];
