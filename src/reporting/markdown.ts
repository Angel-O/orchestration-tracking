import {
  CHILD_PHASE_ORDER,
  EPIC_PHASE_ORDER,
  PHASE_LABELS,
  STANDALONE_PHASE_ORDER,
  type ChildSummary,
  type ReportDocument,
  type ReportPhase,
} from "./models.js";

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

function timelineEnd(action: NonNullable<ReportDocument["actions"]>[number]): string | number {
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
