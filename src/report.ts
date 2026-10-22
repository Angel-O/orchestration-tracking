import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateBeadID } from "./validation.js";
import type {
  ActionOutcome,
  ActionRecord,
  ActivitySliceRecord,
  BeadRecord,
  BeadType,
  CloseoutRecordView,
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

export interface ReportGenerationResult {
  readonly reportID: string;
  /** Absolute local path for the renderer; never included in the artifact. */
  readonly artifactPath: string;
  readonly artifactKey: string;
  readonly sourceHighWaterMark: number;
  readonly report: ReportDocument;
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
  const bead = input.bead === undefined ? undefined : validateBeadID(input.bead);
  const sessions = input.sessions === undefined ? undefined : [...new Set(input.sessions)].sort();
  if (sessions?.some((sessionID) => !isIdentifier(sessionID)))
    throw new Error("report session selector is invalid");
  const from = input.from === undefined ? undefined : timestamp(input.from, "from");
  const to = input.to === undefined ? undefined : timestamp(input.to, "to");
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

function entriesForBead(
  beadID: string,
  slices: readonly ActivitySliceRecord[],
  actions: ReadonlyMap<string, ActionRecord>,
  sessions: ReadonlyMap<string, SessionRecord>,
  beads: ReadonlyMap<string, BeadRecord>,
  selector: NormalizedSelector,
  generatedAt: number,
  allSessions: readonly SessionRecord[],
  allActions: readonly ActionRecord[],
  allSlices: readonly ActivitySliceRecord[],
  creationScopeStarts: ReadonlyMap<string, number>,
): Entry[] {
  return slices
    .filter((slice) => {
      const action = actions.get(`${slice.sessionID}:${slice.actionID}`);
      return (
        slice.beadID === beadID &&
        action !== undefined &&
        selectedSlice(slice, action, { ...selector, bead: beadID }, generatedAt)
      );
    })
    .map((slice) => {
      const action = actions.get(`${slice.sessionID}:${slice.actionID}`)!;
      return toEntry(
        slice,
        action,
        sessions.get(slice.sessionID)!,
        beads.get(beadID),
        selector,
        generatedAt,
        allSessions,
        allActions,
        allSlices,
        creationScopeStarts,
      );
    });
}

/** Classify local facts and atomically replace one private JSON artifact. */
export function generateReport(
  store: TrackerStore,
  input: ReportSelector = {},
  generatedAt = Date.now(),
): ReportGenerationResult {
  const now = timestamp(generatedAt, "generatedAt");
  const selector = normalizeSelector(input);
  const snapshot = store.readReportSnapshot();
  const { sessions, actions, slices, beads, closeouts } = snapshot;
  const beadMap = new Map(beads.map((bead) => [bead.beadID, bead]));
  const actionMap = new Map(
    actions.map((action) => [`${action.sessionID}:${action.actionID}`, action]),
  );
  const sessionMap = new Map(sessions.map((session) => [session.sessionID, session]));
  const creationStarts = creationScopeStarts(snapshot.associations, actions);
  const entries = slices
    .filter((slice) => {
      const action = actionMap.get(`${slice.sessionID}:${slice.actionID}`);
      return action !== undefined && selectedSlice(slice, action, selector, now);
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

  if (kind === "epic") {
    const directEntries = entries.filter((entry) => entry.bead?.beadID === selectedBead!.beadID);
    const epicCloseout = closeouts.find(
      (closeout) => closeout.beadID === selectedBead!.beadID && closeout.kind === "epic",
    );
    const directWindow = initiativeWindow(directEntries, epicCloseout?.closedAt, now);
    const direct = metrics(directEntries, directWindow.durationMs);
    const childRecords = beads.filter((bead) => bead.parentBeadID === selectedBead!.beadID);
    const childWarnings: string[] = [];
    children = childRecords.map((childRecord) => {
      const childEntries = entriesForBead(
        childRecord.beadID,
        slices,
        actionMap,
        sessionMap,
        beadMap,
        selector,
        now,
        sessions,
        actions,
        slices,
        creationStarts,
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
  const reportID = stableReportID(selector);
  const artifactKey = `reports/${reportID}.json`;
  const reportDirectory = join(store.options.dataDir, "reports");
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  chmodSync(reportDirectory, 0o700);
  const artifactPath = join(store.options.dataDir, artifactKey);
  const temporaryPath = join(reportDirectory, `.${reportID}.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, artifactPath);
  chmodSync(artifactPath, 0o600);
  const sourceHighWaterMark = snapshot.sourceHighWaterMark;
  store.recordReport({
    reportID,
    artifactPath: artifactKey,
    selectorFingerprint: reportID.slice("report-".length),
    policyVersion: REPORTING_POLICY_VERSION,
    sourceHighWaterMark,
    generatedAt: now,
  });
  return { reportID, artifactPath, artifactKey, sourceHighWaterMark, report };
}
