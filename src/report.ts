import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateBeadID } from "./shared/validation.js";
import type {
  ActionOutcome,
  ActionRecord,
  ActivitySliceRecord,
  BeadRecord,
  BeadType,
  CloseoutRecordView,
  ReportSnapshot,
  SessionRecord,
  TrackerStore,
} from "./store.js";

/** Fixed policy; callers cannot supply phase or purpose language. */
export const REPORTING_POLICY_VERSION = "session-attribution-v1" as const;
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

/** One captured phase bucket for the report-detail renderer. */
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

const PHASE_LABELS: Readonly<Record<ReportPhase, string>> = {
  scoping: "Scoping",
  "scoping-decomposition": "Scoping and decomposition",
  coordination: "Coordination",
  implementation: "Implementation",
  review: "Review",
  "integration-validation": "Integration validation",
  build: "Build",
  unclassified: "Unclassified",
};
const STANDALONE_PHASE_ORDER: readonly ReportPhase[] = [
  "scoping",
  "coordination",
  "implementation",
  "review",
  "integration-validation",
  "build",
  "unclassified",
];
const CHILD_PHASE_ORDER: readonly ReportPhase[] = [
  "coordination",
  "implementation",
  "review",
  "integration-validation",
  "build",
  "unclassified",
];
const EPIC_PHASE_ORDER: readonly ReportPhase[] = [
  "scoping-decomposition",
  "coordination",
  "unclassified",
];

function markdownCell(value: string | number): string {
  return String(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function duration(value: number): string {
  return `${value} ms`;
}

function phaseRows(report: ReportDocument, phases: readonly ReportPhase[]): readonly ReportPhase[] {
  return phases.filter((phase) => report.phaseTotals[phase].actionCount > 0);
}

function phaseTable(report: ReportDocument, phases: readonly ReportPhase[]): string[] {
  const rows = phaseRows(report, phases);
  return [
    "| Phase | Active time | Actions |",
    "| --- | ---: | ---: |",
    ...(rows.length === 0
      ? ["| None | 0 ms | 0 |"]
      : rows.map((phase) => {
          const metric = report.phaseTotals[phase];
          return `| ${markdownCell(PHASE_LABELS[phase])} | ${duration(metric.activeMs)} | ${metric.actionCount} |`;
        })),
  ];
}

function outcomeTable(report: ReportDocument): string[] {
  const outcomes = report.metrics.outcomes;
  return [
    "| Outcome | Actions |",
    "| --- | ---: |",
    `| Open | ${outcomes.open} |`,
    `| Completed | ${outcomes.completed} |`,
    `| Failed | ${outcomes.failed} |`,
    `| Interrupted | ${outcomes.interrupted} |`,
    `| Incomplete | ${outcomes.incomplete} |`,
  ];
}

function timelineEnd(action: ReportAction): string | number {
  if (action.outcome === "open") return "open";
  if (action.outcome === "incomplete") return "unknown";
  return action.endedAt ?? "unknown";
}

function noticesAndWarnings(report: ReportDocument): string[] {
  return [
    "## Privacy and interpretation",
    "",
    `- Privacy: ${markdownCell(report.privacyNotice)}`,
    ...report.notices.map((notice) => `- Notice: ${markdownCell(notice)}`),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length === 0
      ? ["- None"]
      : report.warnings.map((warning) => `- ${markdownCell(warning)}`)),
  ];
}

function reportIdentity(report: ReportDocument): string[] {
  return [
    "| Field | Value |",
    "| --- | --- |",
    `| View | ${markdownCell(report.kind)} |`,
    `| Bead | ${markdownCell(report.beadID ?? "session scope")} |`,
    `| Policy | ${markdownCell(report.policyVersion)} |`,
    `| Lifecycle | ${markdownCell(report.lifecycleState)} |`,
    `| Generated at (ms) | ${report.generatedAt} |`,
  ];
}

function detailedReport(report: ReportDocument): string {
  const phases = report.kind === "child" ? CHILD_PHASE_ORDER : STANDALONE_PHASE_ORDER;
  const title = report.kind === "child" ? "Child detailed report" : "Standalone detailed report";
  const sessions = report.sessions ?? [];
  const actions = [...(report.actions ?? [])].sort(
    (left, right) => left.startedAt - right.startedAt || left.sliceID - right.sliceID,
  );
  return [
    `# ${title}`,
    "",
    ...reportIdentity(report),
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Active time (summed) | ${duration(report.metrics.activeMs)} |`,
    `| Work-window elapsed | ${duration(report.elapsed.durationMs)} |`,
    `| Sessions / lanes | ${report.metrics.sessionCount} |`,
    `| Actions | ${report.metrics.actionCount} |`,
    "",
    "## Ordered phases",
    "",
    ...phaseTable(report, phases),
    "",
    "## Session / lane summary",
    "",
    "| Lane | Active time | Actions |",
    "| --- | ---: | ---: |",
    ...(sessions.length === 0
      ? ["| None | 0 ms | 0 |"]
      : sessions.map(
          (session) =>
            `| ${markdownCell(session.sessionID)} | ${duration(session.activeMs)} | ${session.actionCount} |`,
        )),
    "",
    "## Shared-clock lane timeline",
    "",
    "| Start (ms) | End (ms) | Lane | Action | Phase | Outcome | Active time |",
    "| ---: | ---: | --- | --- | --- | --- | ---: |",
    ...(actions.length === 0
      ? ["| — | — | None | — | — | — | 0 ms |"]
      : actions.map(
          (action) =>
            `| ${action.startedAt} | ${timelineEnd(action)} | ${markdownCell(action.sessionID)} | ${markdownCell(action.actionID)} | ${markdownCell(PHASE_LABELS[action.phase])} | ${markdownCell(action.outcome)} | ${duration(action.activeMs)} |`,
        )),
    "",
    "## Outcomes",
    "",
    ...outcomeTable(report),
    "",
    ...noticesAndWarnings(report),
    "",
  ].join("\n");
}

function childMetric(summary: ChildSummary, phase: ReportPhase): string {
  const metric = summary.phaseTotals[phase];
  return `${duration(metric.activeMs)} (${metric.actionCount})`;
}

function initiativeWindowTable(report: ReportDocument): string[] {
  if (report.initiativeState === "not-started") {
    return [
      "| Boundary | Timestamp (ms) |",
      "| --- | ---: |",
      "| First direct activity | Not started |",
      "| End | Not started |",
    ];
  }
  const endLabel =
    report.initiativeState === "open"
      ? "End (generation-time boundary)"
      : "End (successful epic closeout)";
  return [
    "| Boundary | Timestamp (ms) |",
    "| --- | ---: |",
    `| First direct activity | ${report.elapsed.startAt ?? "unknown"} |`,
    `| ${endLabel} | ${report.elapsed.endAt ?? report.generatedAt} |`,
  ];
}

function epicReport(report: ReportDocument): string {
  const children = report.children ?? [];
  return [
    "# Epic initiative report",
    "",
    ...reportIdentity(report),
    `| Initiative state | ${markdownCell(report.initiativeState ?? "not-started")} |`,
    "",
    "## Initiative window",
    "",
    ...initiativeWindowTable(report),
    "",
    "## Metric cards",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Direct epic active time | ${duration(report.metrics.directActiveMs ?? 0)} |`,
    `| Summed child active time | ${duration(report.metrics.summedChildActiveMs ?? 0)} |`,
    `| Combined active time | ${duration(report.metrics.combinedActiveMs ?? 0)} |`,
    `| Initiative elapsed time | ${duration(report.metrics.initiativeElapsedMs ?? report.elapsed.durationMs)} |`,
    "",
    "## Direct phase totals",
    "",
    ...phaseTable(report, EPIC_PHASE_ORDER),
    "",
    "## Child summary",
    "",
    "| Child | Type | Lifecycle | Coordination | Implementation | Review | Integration validation | Build | Unclassified | Total active |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(children.length === 0
      ? [
          "| None | — | Not started | 0 ms (0) | 0 ms (0) | 0 ms (0) | 0 ms (0) | 0 ms (0) | 0 ms (0) | 0 ms |",
        ]
      : children.map(
          (child) =>
            `| ${markdownCell(child.beadID)} | ${markdownCell(child.type)} | ${markdownCell(child.lifecycleState)} | ${childMetric(child, "coordination")} | ${childMetric(child, "implementation")} | ${childMetric(child, "review")} | ${childMetric(child, "integration-validation")} | ${childMetric(child, "build")} | ${childMetric(child, "unclassified")} | ${duration(child.metrics.activeMs)} |`,
        )),
    "",
    ...noticesAndWarnings(report),
    "",
  ].join("\n");
}

/** Render a report document as deterministic, privacy-safe Markdown. */
export function renderReport(report: ReportDocument): string {
  return report.kind === "epic" ? epicReport(report) : detailedReport(report);
}

type Entry = {
  readonly slice: ActivitySliceRecord;
  readonly action: ActionRecord;
  readonly session: SessionRecord;
  readonly bead: BeadRecord | undefined;
  readonly activeMs: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly phase: ReportPhase;
};

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${name} must be a safe integer`);
  return value as number;
}

function normalizeSelector(input: ReportSelector): NormalizedSelector {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("report selector must be an object");
  const value = input as ReportSelector & Record<string, unknown>;
  const supportedKeys = new Set(["bead", "sessions", "from", "to"]);
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !supportedKeys.has(key)))
    throw new Error("report selector contains unsupported keys");
  const bead = value.bead === undefined ? undefined : validateBeadID(value.bead);
  if (value.sessions !== undefined && !Array.isArray(value.sessions))
    throw new Error("report session selector is invalid");
  const sessions = value.sessions === undefined ? undefined : [...new Set(value.sessions)].sort();
  if (sessions?.some((sessionID) => !isIdentifier(sessionID)))
    throw new Error("report session selector is invalid");
  const from = value.from === undefined ? undefined : timestamp(value.from, "from");
  const to = value.to === undefined ? undefined : timestamp(value.to, "to");
  if (from !== undefined && to !== undefined && to < from)
    throw new Error("report selector range is invalid");
  return {
    ...(bead === undefined ? {} : { bead }),
    ...(sessions ? { sessions } : {}),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function emptyPhaseTotals(): Record<ReportPhase, PhaseMetric> {
  return Object.fromEntries(
    REPORT_PHASES.map((phase) => [phase, { activeMs: 0, actionCount: 0 }]),
  ) as Record<ReportPhase, PhaseMetric>;
}

function emptyOutcomes(): Record<ActionOutcome, number> {
  return { open: 0, completed: 0, failed: 0, interrupted: 0, incomplete: 0 };
}

function activeDuration(startedAt: number, endedAt: number | null, action: ActionRecord): number {
  if (action.endedAt === null || action.outcome === "open" || action.outcome === "incomplete")
    return 0;
  return Math.max(0, (endedAt ?? action.endedAt) - startedAt);
}

function phaseFor(
  slice: ActivitySliceRecord,
  action: ActionRecord,
  bead: BeadRecord | undefined,
  sessions: readonly SessionRecord[],
  actions: readonly ActionRecord[],
  slices: readonly ActivitySliceRecord[],
  creationScopeStarts: ReadonlyMap<string, number>,
  inherit = true,
): { phase: ReportPhase; warning: boolean } {
  if (!bead) return { phase: "unclassified", warning: true };
  const creationScopeStart = creationScopeStarts.get(`${slice.sessionID}:${bead.beadID}`);
  if (
    slice.associationSource === "creation" &&
    (creationScopeStart === undefined || action.startedAt <= creationScopeStart)
  ) {
    if (bead.type === "epic") return { phase: "scoping-decomposition", warning: false };
    return bead.parentBeadID === null
      ? { phase: "scoping", warning: false }
      : { phase: "unclassified", warning: true };
  }
  if (bead.type === "epic") {
    if (["architect", "planner", "plan"].includes(action.observedRole))
      return { phase: "scoping-decomposition", warning: false };
    if (action.observedRole === "orchestrator") return { phase: "coordination", warning: false };
  } else if (
    bead.parentBeadID !== null &&
    ["architect", "planner", "plan"].includes(action.observedRole)
  ) {
    return { phase: "unclassified", warning: true };
  }
  const fixed: Partial<Record<string, ReportPhase>> = {
    orchestrator: "coordination",
    worker: "implementation",
    reviewer: "review",
    integration: "integration-validation",
    build: "build",
  };
  const fixedPhase = fixed[action.observedRole];
  if (fixedPhase) return { phase: fixedPhase, warning: false };
  if (action.observedRole === "investigator" && inherit) {
    const current = sessions.find((session) => session.sessionID === action.sessionID);
    let parentID = current?.parentSessionID ?? null;
    while (parentID) {
      const candidates = slices
        .filter((candidate) => candidate.sessionID === parentID && candidate.beadID === bead.beadID)
        .map((candidate) => {
          const candidateAction = actions.find(
            (item) =>
              item.sessionID === candidate.sessionID && item.actionID === candidate.actionID,
          );
          return candidateAction ? { candidate, candidateAction } : undefined;
        })
        .filter(
          (
            candidate,
          ): candidate is {
            candidate: ActivitySliceRecord;
            candidateAction: ActionRecord;
          } => candidate !== undefined,
        )
        .sort(
          (left, right) =>
            Math.abs(left.candidate.startedAt - slice.startedAt) -
            Math.abs(right.candidate.startedAt - slice.startedAt),
        );
      const parent = candidates[0];
      if (parent) {
        const inherited = phaseFor(
          parent.candidate,
          parent.candidateAction,
          bead,
          sessions,
          actions,
          slices,
          creationScopeStarts,
          false,
        );
        if (inherited.phase !== "unclassified") return inherited;
      }
      parentID =
        sessions.find((session) => session.sessionID === parentID)?.parentSessionID ?? null;
    }
  }
  return { phase: "unclassified", warning: true };
}

function selectedSlice(
  slice: ActivitySliceRecord,
  action: ActionRecord,
  selector: NormalizedSelector,
  generatedAt: number,
): boolean {
  if (selector.sessions && !selector.sessions.includes(slice.sessionID)) return false;
  if (selector.bead && slice.beadID !== selector.bead) return false;
  const end =
    slice.endedAt ?? action.endedAt ?? (action.outcome === "open" ? generatedAt : slice.startedAt);
  return (
    (selector.from === undefined || end >= selector.from) &&
    (selector.to === undefined || slice.startedAt <= selector.to)
  );
}

function toEntry(
  slice: ActivitySliceRecord,
  action: ActionRecord,
  session: SessionRecord,
  bead: BeadRecord | undefined,
  selector: NormalizedSelector,
  generatedAt: number,
  sessions: readonly SessionRecord[],
  actions: readonly ActionRecord[],
  slices: readonly ActivitySliceRecord[],
  creationScopeStarts: ReadonlyMap<string, number>,
): Entry {
  const startedAt = Math.max(slice.startedAt, selector.from ?? slice.startedAt);
  const rawEnd =
    slice.endedAt ?? action.endedAt ?? (action.outcome === "open" ? generatedAt : null);
  const endedAt = rawEnd === null ? null : Math.min(rawEnd, selector.to ?? rawEnd);
  const phase = phaseFor(slice, action, bead, sessions, actions, slices, creationScopeStarts).phase;
  return {
    slice,
    action,
    session,
    bead,
    activeMs: activeDuration(startedAt, endedAt, action),
    startedAt,
    endedAt,
    phase,
  };
}

function metrics(
  entries: readonly Entry[],
  elapsedMs: number,
): { metrics: ReportMetrics; phaseTotals: Record<ReportPhase, PhaseMetric>; warnings: string[] } {
  const phaseTotals = emptyPhaseTotals();
  const phaseActions = new Map<ReportPhase, Set<string>>();
  const actionEntries = new Map<string, ActionRecord>();
  const sessions = new Set<string>();
  let activeMs = 0;
  let hasUnclassified = false;
  for (const entry of entries) {
    const actionKey = `${entry.action.sessionID}:${entry.action.actionID}`;
    actionEntries.set(actionKey, entry.action);
    sessions.add(entry.session.sessionID);
    activeMs += entry.activeMs;
    phaseTotals[entry.phase] = {
      activeMs: phaseTotals[entry.phase].activeMs + entry.activeMs,
      actionCount: 0,
    };
    const actionSet = phaseActions.get(entry.phase) ?? new Set<string>();
    actionSet.add(actionKey);
    phaseActions.set(entry.phase, actionSet);
    hasUnclassified ||= entry.phase === "unclassified";
  }
  for (const [phase, actionSet] of phaseActions)
    phaseTotals[phase] = { ...phaseTotals[phase], actionCount: actionSet.size };
  const outcomes = emptyOutcomes();
  for (const action of actionEntries.values()) outcomes[action.outcome] += 1;
  const warnings = hasUnclassified ? ["unclassified activity is present"] : [];
  if (outcomes.open + outcomes.incomplete > 0)
    warnings.push("open or incomplete actions have zero active time");
  return {
    metrics: {
      activeMs,
      elapsedMs,
      sessionCount: sessions.size,
      actionCount: actionEntries.size,
      outcomes,
    },
    phaseTotals,
    warnings,
  };
}

function workWindow(
  entries: readonly Entry[],
  generatedAt: number,
): { startAt: number | null; endAt: number | null; durationMs: number; open: boolean } {
  if (entries.length === 0) return { startAt: null, endAt: null, durationMs: 0, open: false };
  const startAt = Math.min(...entries.map((entry) => entry.startedAt));
  const open = entries.some(
    (entry) => entry.action.outcome === "open" && entry.action.endedAt === null,
  );
  const endAt = open
    ? generatedAt
    : Math.max(...entries.map((entry) => entry.endedAt ?? entry.startedAt));
  return { startAt, endAt, durationMs: Math.max(0, endAt - startAt), open };
}

function initiativeWindow(
  entries: readonly Entry[],
  closedAt: number | undefined,
  generatedAt: number,
): { startAt: number | null; endAt: number | null; durationMs: number; open: boolean } {
  if (entries.length === 0) return { startAt: null, endAt: null, durationMs: 0, open: false };
  const startAt = Math.min(...entries.map((entry) => entry.startedAt));
  const endAt = closedAt ?? generatedAt;
  return {
    startAt,
    endAt,
    durationMs: Math.max(0, endAt - startAt),
    open: closedAt === undefined,
  };
}

function creationScopeStarts(
  associations: readonly {
    readonly sessionID: string;
    readonly beadID: string;
    readonly source: string;
    readonly observedAt: number;
  }[],
  actions: readonly ActionRecord[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const association of associations) {
    if (association.source !== "creation") continue;
    const containing = actions
      .filter(
        (action) =>
          action.sessionID === association.sessionID && action.startedAt <= association.observedAt,
      )
      .sort((left, right) => right.startedAt - left.startedAt)[0];
    if (containing)
      result.set(
        `${association.sessionID}:${association.beadID}`,
        Math.max(
          result.get(`${association.sessionID}:${association.beadID}`) ?? 0,
          containing.startedAt,
        ),
      );
  }
  return result;
}

function lifecycleState(
  beadID: string,
  closeouts: readonly CloseoutRecordView[],
  active: boolean,
): LifecycleState {
  if (closeouts.some((closeout) => closeout.beadID === beadID)) return "Closeout complete";
  return active ? "Active — closeout not observed" : "Not started";
}

function stableReportID(selector: NormalizedSelector): string {
  const digest = createHash("sha256")
    .update(`${REPORTING_POLICY_VERSION}\n${JSON.stringify(selector)}`)
    .digest("hex")
    .slice(0, 32);
  return `report-${digest}`;
}

function writePrivateArtifact(reportDirectory: string, fileName: string, content: string): string {
  const artifactPath = join(reportDirectory, fileName);
  const temporaryPath = join(reportDirectory, `.${fileName}.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, artifactPath);
  chmodSync(artifactPath, 0o600);
  return artifactPath;
}

const REPORT_DETAIL_PHASE_COLORS = [
  "#cfe8ff",
  "#d9f2d9",
  "#ffe4b5",
  "#eadcff",
  "#ffd6e7",
  "#d8f3f0",
] as const;

function reportDetailPhaseColor(phaseKey: string): string {
  let hash = 0;
  for (const character of phaseKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return REPORT_DETAIL_PHASE_COLORS[(hash >>> 0) % REPORT_DETAIL_PHASE_COLORS.length]!;
}

function buildReportDetail(
  entries: readonly Entry[],
  report: ReportDocument,
  closeouts: readonly CloseoutRecordView[],
  now: number,
): ReportDetailModel {
  const actionEntries = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = `${entry.action.sessionID}:${entry.action.actionID}`;
    actionEntries.set(key, [...(actionEntries.get(key) ?? []), entry]);
  }
  const passes = [...actionEntries.values()]
    .map((passEntries) => {
      const first = passEntries[0]!;
      const segments = passEntries
        .slice()
        .sort(
          (left, right) =>
            left.startedAt - right.startedAt || left.slice.sliceID - right.slice.sliceID,
        );
      const startAt = Math.min(...segments.map((entry) => entry.startedAt));
      const endAt = Math.max(...segments.map((entry) => entry.endedAt ?? entry.startedAt));
      return {
        first,
        startAt,
        endAt,
        activeMs: segments.reduce((total, entry) => total + entry.activeMs, 0),
        segments,
      };
    })
    .sort(
      (left, right) =>
        left.startAt - right.startAt ||
        left.first.action.sessionID.localeCompare(right.first.action.sessionID) ||
        left.first.action.passNumber - right.first.action.passNumber ||
        left.first.action.actionID.localeCompare(right.first.action.actionID),
    );

  const scaleStart =
    entries.length === 0 ? null : Math.min(...entries.map((entry) => entry.startedAt));
  const scaleEnd =
    entries.length === 0
      ? null
      : Math.max(...entries.map((entry) => entry.endedAt ?? entry.startedAt));
  const scaleDuration =
    scaleStart === null || scaleEnd === null ? 0 : Math.max(0, scaleEnd - scaleStart);
  const percent = (value: number): number =>
    scaleDuration === 0 ? 0 : ((value - scaleStart!) / scaleDuration) * 100;
  const timeline = (entry: Entry): ReportDetailTimelineSegment => {
    const endedAt = entry.endedAt;
    const visibleEnd = endedAt ?? entry.startedAt;
    return {
      sliceID: entry.slice.sliceID,
      startedAt: entry.startedAt,
      endedAt,
      activeMs: entry.activeMs,
      startPercent: percent(entry.startedAt),
      endPercent: percent(visibleEnd),
      widthPercent: Math.max(0, percent(visibleEnd) - percent(entry.startedAt)),
    };
  };
  const reportDetailPasses: ReportDetailPass[] = passes.map(
    ({ first, endAt, activeMs, segments }) => ({
      passNumber: first.action.passNumber,
      sessionID: first.action.sessionID,
      actionID: first.action.actionID,
      agent: first.action.observedRole,
      phaseKey: first.action.phaseKey,
      phaseLabel: first.action.phaseLabel,
      color: reportDetailPhaseColor(first.action.phaseKey),
      outcome: first.action.outcome,
      startedAt: Math.min(...segments.map((entry) => entry.startedAt)),
      endedAt: first.action.endedAt === null ? null : endAt,
      activeMs,
      segments: segments.map(timeline),
    }),
  );

  const phases = new Map<string, ReportDetailPhaseTotal>();
  const agents = new Map<string, ReportDetailAgentTotal>();
  const sessions = new Map<string, ReportDetailSessionTotal>();
  for (const pass of passes) {
    const first = pass.first;
    const phaseKey = first.action.phaseKey;
    const phase = phases.get(phaseKey);
    phases.set(phaseKey, {
      phaseKey,
      phaseLabel: first.action.phaseLabel,
      color: reportDetailPhaseColor(phaseKey),
      activeMs: (phase?.activeMs ?? 0) + pass.activeMs,
      passCount: (phase?.passCount ?? 0) + 1,
    });
    const agent = first.action.observedRole;
    const agentTotal = agents.get(agent);
    agents.set(agent, {
      agent,
      activeMs: (agentTotal?.activeMs ?? 0) + pass.activeMs,
      passCount: (agentTotal?.passCount ?? 0) + 1,
    });
    const session = sessions.get(first.action.sessionID);
    const outcomes = { ...(session?.outcomes ?? emptyOutcomes()) };
    outcomes[first.action.outcome] += 1;
    sessions.set(first.action.sessionID, {
      sessionID: first.action.sessionID,
      projectLabel: first.session.projectLabel,
      activeMs: (session?.activeMs ?? 0) + pass.activeMs,
      passCount: (session?.passCount ?? 0) + 1,
      outcomes,
    });
  }

  const repeatGroups = new Map<string, number[]>();
  for (const pass of passes) {
    if (!pass.first.action.repeatEligible) continue;
    const key = `${pass.first.action.sessionID}\u0000${pass.first.action.observedRole}`;
    const group = repeatGroups.get(key) ?? [];
    group.push(pass.first.action.passNumber);
    repeatGroups.set(key, group);
  }
  const repeats: ReportDetailRepeatSignal[] = [...repeatGroups.entries()]
    .filter(([, passNumbers]) => passNumbers.length > 1)
    .map(([key, passNumbers]) => {
      const [sessionID, agent] = key.split("\u0000", 2) as [string, string];
      return {
        sessionID,
        agent,
        phaseLabel:
          passNumbers.length > 0
            ? passes.find(
                (pass) =>
                  pass.first.action.sessionID === sessionID &&
                  pass.first.action.observedRole === agent &&
                  pass.first.action.repeatEligible,
              )!.first.action.phaseLabel
            : "Unmapped",
        passes: passNumbers.length,
        repeated: true,
        passNumbers: [...passNumbers].sort((left, right) => left - right),
        count: passNumbers.length,
        repeatCount: passNumbers.length - 1,
      };
    })
    .sort(
      (left, right) =>
        left.sessionID.localeCompare(right.sessionID) || left.agent.localeCompare(right.agent),
    );

  const projectLabels = [...new Set(entries.map((entry) => entry.session.projectLabel))].sort();
  const incomplete = passes.some(({ first }) => first.action.outcome === "incomplete");
  const unmapped = passes.some(({ first }) => first.action.phaseKey === "unmapped");
  const warnings = [
    ...new Set([
      ...report.warnings,
      ...passes.flatMap(({ first }) => [
        ...(first.action.outcome === "incomplete"
          ? [`incomplete pass in ${first.action.sessionID}`]
          : []),
        ...(first.action.phaseKey === "unmapped"
          ? [`unmapped agent in ${first.action.sessionID}`]
          : []),
      ]),
    ]),
  ].sort();
  const finalizedAt =
    report.beadID === undefined
      ? null
      : (closeouts.find((closeout) => closeout.beadID === report.beadID)?.closedAt ?? null);
  return {
    kind: report.kind,
    ...(report.beadID === undefined ? {} : { beadID: report.beadID }),
    status: report.lifecycleState,
    generatedAt: now,
    finalizedAt,
    selection: report.selector,
    metrics: report.metrics,
    phaseTotals: report.phaseTotals,
    ...(report.children === undefined ? {} : { children: report.children }),
    projectLabel: projectLabels.length === 1 ? projectLabels[0]! : null,
    projectLabels,
    durations: {
      activeMs: passes.reduce((total, pass) => total + pass.activeMs, 0),
      elapsedMs: report.elapsed.durationMs,
    },
    phases: [...phases.values()],
    agents: [...agents.values()],
    sessions: [...sessions.values()].sort((left, right) =>
      left.sessionID.localeCompare(right.sessionID),
    ),
    passes: reportDetailPasses,
    scale: { startAt: scaleStart, endAt: scaleEnd, durationMs: scaleDuration },
    repeats,
    incomplete,
    unmapped,
    warnings,
  };
}

/** Build both report projections from one immutable snapshot without writing. */
export function buildReportModels(
  snapshot: ReportSnapshot,
  input: ReportSelector = {},
  generatedAt = Date.now(),
): ReportModels {
  const now = timestamp(generatedAt, "generatedAt");
  const selector = normalizeSelector(input);
  const { sessions, actions, slices, beads, closeouts } = snapshot;
  const beadMap = new Map(beads.map((bead) => [bead.beadID, bead]));
  const actionMap = new Map(
    actions.map((action) => [`${action.sessionID}:${action.actionID}`, action]),
  );
  const sessionMap = new Map(sessions.map((session) => [session.sessionID, session]));
  const creationStarts = creationScopeStarts(snapshot.associations, actions);
  const selectedEntries = slices
    .filter((slice) => {
      const action = actionMap.get(`${slice.sessionID}:${slice.actionID}`);
      return (
        action !== undefined && selectedSlice(slice, action, { ...selector, bead: undefined }, now)
      );
    })
    .map((slice) => {
      const action = actionMap.get(`${slice.sessionID}:${slice.actionID}`)!;
      return toEntry(
        slice,
        action,
        sessionMap.get(slice.sessionID)!,
        slice.beadID === null ? undefined : beadMap.get(slice.beadID),
        selector,
        now,
        sessions,
        actions,
        slices,
        creationStarts,
      );
    })
    .sort(
      (left, right) => left.startedAt - right.startedAt || left.slice.sliceID - right.slice.sliceID,
    );
  const entries =
    selector.bead === undefined
      ? selectedEntries
      : selectedEntries.filter((entry) => entry.slice.beadID === selector.bead);
  const selectedBead = selector.bead === undefined ? undefined : beadMap.get(selector.bead);
  if (selector.bead !== undefined && !selectedBead)
    throw new Error("report bead is not locally validated");
  const kind: ReportKind =
    selector.bead === undefined
      ? "sessions"
      : selectedBead!.type === "epic"
        ? "epic"
        : selectedBead!.parentBeadID === null
          ? "standalone"
          : "child";
  const window = workWindow(entries, now);
  const calculated = metrics(entries, window.durationMs);
  let reportMetrics = calculated.metrics;
  let phaseTotals = calculated.phaseTotals;
  let warnings = calculated.warnings;
  let elapsed = window;
  let children: ChildSummary[] | undefined;
  let initiativeState: InitiativeState | undefined;

  if (kind === "epic") {
    const directEntries = entries.filter((entry) => entry.bead?.beadID === selectedBead!.beadID);
    const epicCloseout = closeouts.find(
      (closeout) => closeout.beadID === selectedBead!.beadID && closeout.kind === "epic",
    );
    const directWindow = initiativeWindow(directEntries, epicCloseout?.closedAt, now);
    initiativeState =
      directEntries.length === 0
        ? "not-started"
        : epicCloseout === undefined
          ? "open"
          : "closeout-bounded";
    const direct = metrics(directEntries, directWindow.durationMs);
    const childRecords = beads.filter((bead) => bead.parentBeadID === selectedBead!.beadID);
    const childWarnings: string[] = [];
    children = childRecords.map((childRecord) => {
      const childEntries = selectedEntries.filter(
        (entry) => entry.slice.beadID === childRecord.beadID,
      );
      const childWindow = workWindow(childEntries, now);
      const child = metrics(childEntries, childWindow.durationMs);
      childWarnings.push(...child.warnings);
      return {
        beadID: childRecord.beadID,
        type: childRecord.type as Exclude<BeadType, "epic">,
        lifecycleState: lifecycleState(childRecord.beadID, closeouts, childEntries.length > 0),
        metrics: child.metrics,
        phaseTotals: child.phaseTotals,
      };
    });
    const summedChildActiveMs = children.reduce(
      (total, child) => total + child.metrics.activeMs,
      0,
    );
    phaseTotals = direct.phaseTotals;
    warnings = [
      ...new Set([
        ...direct.warnings,
        ...childWarnings,
        ...children.flatMap((child) =>
          child.metrics.outcomes.open + child.metrics.outcomes.incomplete > 0
            ? ["open or incomplete actions have zero active time"]
            : [],
        ),
      ]),
    ];
    elapsed = directWindow;
    reportMetrics = {
      ...direct.metrics,
      elapsedMs: directWindow.durationMs,
      directActiveMs: direct.metrics.activeMs,
      summedChildActiveMs,
      combinedActiveMs: direct.metrics.activeMs + summedChildActiveMs,
      initiativeElapsedMs: directWindow.durationMs,
    };
  }

  const report: ReportDocument = {
    policyVersion: REPORTING_POLICY_VERSION,
    generatedAt: now,
    privacyNotice: PRIVACY_NOTICE,
    notices: REPORT_NOTICES,
    selector,
    kind,
    ...(selector.bead === undefined ? {} : { beadID: selector.bead }),
    lifecycleState:
      selector.bead === undefined
        ? "Not applicable"
        : lifecycleState(selector.bead, closeouts, entries.length > 0),
    metrics: reportMetrics,
    phaseTotals,
    warnings: [...new Set(warnings)].sort(),
    ...(initiativeState === undefined ? {} : { initiativeState }),
    elapsed,
    ...(kind === "epic"
      ? { children }
      : {
          sessions: [...new Set(entries.map((entry) => entry.session.sessionID))]
            .map((sessionID) => {
              const selected = entries.filter((entry) => entry.session.sessionID === sessionID);
              return {
                sessionID,
                activeMs: selected.reduce((total, entry) => total + entry.activeMs, 0),
                actionCount: new Set(selected.map((entry) => entry.action.actionID)).size,
              };
            })
            .sort((left, right) => left.sessionID.localeCompare(right.sessionID)),
          actions: entries.map((entry) => ({
            sliceID: entry.slice.sliceID,
            sessionID: entry.session.sessionID,
            actionID: entry.action.actionID,
            role: entry.action.observedRole,
            phase: entry.phase,
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            outcome: entry.action.outcome,
            activeMs: entry.activeMs,
          })),
        }),
  };
  const reportDetailEntries =
    kind === "epic"
      ? [
          ...entries,
          ...children!.flatMap((child) =>
            selectedEntries.filter((entry) => entry.slice.beadID === child.beadID),
          ),
        ]
      : entries;
  return {
    selector,
    report,
    reportDetail: buildReportDetail(reportDetailEntries, report, closeouts, now),
  };
}

/** Classify local facts and atomically replace one private JSON artifact. */
export function generateReport(
  store: TrackerStore,
  input: ReportSelector = {},
  generatedAt = Date.now(),
): ReportGenerationResult {
  const snapshot = store.readReportSnapshot();
  const { report, selector } = buildReportModels(snapshot, input, generatedAt);
  const reportID = stableReportID(selector);
  const artifactKey = `reports/${reportID}.json`;
  const renderedArtifactKey = `reports/${reportID}.md`;
  const reportDirectory = join(store.options.dataDir, "reports");
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  chmodSync(reportDirectory, 0o700);
  const artifactPath = writePrivateArtifact(
    reportDirectory,
    `${reportID}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const renderedArtifactPath = writePrivateArtifact(
    reportDirectory,
    `${reportID}.md`,
    renderReport(report),
  );
  const sourceHighWaterMark = snapshot.sourceHighWaterMark;
  store.recordReport({
    reportID,
    artifactPath: artifactKey,
    selectorFingerprint: reportID.slice("report-".length),
    policyVersion: REPORTING_POLICY_VERSION,
    sourceHighWaterMark,
    generatedAt: report.generatedAt,
  });
  return {
    reportID,
    artifactPath,
    artifactKey,
    renderedArtifactPath,
    renderedArtifactKey,
    sourceHighWaterMark,
    report,
  };
}
