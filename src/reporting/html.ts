import type {
  ChildSummary,
  OutcomeCounts,
  ReportDetailModel,
  ReportDetailPass,
  ReportDetailSessionTotal,
  ReportPhase,
} from "./models.js";

const OUTCOMES: readonly (keyof OutcomeCounts)[] = [
  "open",
  "completed",
  "failed",
  "interrupted",
  "incomplete",
];
const PHASES: readonly ReportPhase[] = [
  "scoping",
  "scoping-decomposition",
  "coordination",
  "implementation",
  "review",
  "integration-validation",
  "build",
  "unclassified",
];
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDuration(milliseconds: number): string {
  const totalMs = Math.max(0, Math.round(milliseconds));
  if (totalMs < 1000) return `${totalMs} ms`;
  const totalSeconds = totalMs / 1000;
  if (totalSeconds < 60) {
    return `${totalMs % 1000 === 0 ? totalSeconds : totalSeconds.toFixed(1)} s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (totalMinutes < 60) return `${totalMinutes}m${seconds ? ` ${seconds}s` : ""}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

/** Display report timestamps in the viewing machine's local time zone. */
function formatTime(value: number | null): string {
  return value === null ? "—" : new Date(value).toLocaleString();
}

function percent(value: number): string {
  const bounded = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return Number.isInteger(bounded) ? String(bounded) : bounded.toFixed(3).replace(/0+$/, "");
}

function phaseSwatch(color: string): string {
  return `<span class="swatch" style="background:${escapeHtml(color)}" aria-hidden="true"></span>`;
}

function selection(detail: ReportDetailModel): string {
  const parts = [
    detail.selection.bead === undefined ? "" : `bead: ${escapeHtml(detail.selection.bead)}`,
    detail.selection.sessions === undefined
      ? ""
      : `sessions: ${detail.selection.sessions.length === 0 ? "(none)" : detail.selection.sessions.map(escapeHtml).join(", ")}`,
    detail.selection.from === undefined
      ? ""
      : `from: ${escapeHtml(formatTime(detail.selection.from))}`,
    detail.selection.to === undefined ? "" : `to: ${escapeHtml(formatTime(detail.selection.to))}`,
  ].filter(Boolean);
  return parts.join("; ") || "all local activity";
}

function phaseLegend(detail: ReportDetailModel): string {
  return detail.phases.length === 0
    ? "No phase segments"
    : detail.phases
        .map(
          (phase) =>
            `<span class="legend-item">${phaseSwatch(phase.color)}${escapeHtml(phase.phaseLabel)}</span>`,
        )
        .join("");
}

function timelineSegments(pass: ReportDetailPass): string {
  return pass.segments
    .map(
      (segment) =>
        `<div class="timeline-segment" role="img" aria-label="${escapeHtml(`${pass.sessionID}; session-local action ordinal P${pass.passNumber}; ${pass.phaseLabel}; ${pass.agent}; ${formatTime(segment.startedAt)}; ${formatTime(segment.endedAt)}`)}" style="left:${percent(segment.startPercent)}%;width:${percent(segment.widthPercent)}%;background:${escapeHtml(pass.color)}">P${escapeHtml(pass.passNumber)}</div>`,
    )
    .join("");
}

function bars(pass: ReportDetailPass, trackClass: string): string {
  return `<div class="${trackClass}" aria-label="Timeline for ${escapeHtml(pass.sessionID)}, session-local action ordinal P${escapeHtml(pass.passNumber)}">${timelineSegments(pass)}</div>`;
}

function outcomeList(outcomes: OutcomeCounts): string {
  return OUTCOMES.map(
    (outcome) => `<li>${escapeHtml(outcome)}: ${escapeHtml(outcomes[outcome])}</li>`,
  ).join("");
}

function outcomeLabels(outcomes: OutcomeCounts): string {
  return OUTCOMES.map(
    (outcome) =>
      `<span class="outcome">${escapeHtml(outcome)}: ${escapeHtml(outcomes[outcome])}</span>`,
  ).join("");
}

function phaseRows(detail: ReportDetailModel): string {
  if (detail.phases.length === 0) return '<tr><td colspan="4">None</td></tr>';
  return detail.phases
    .map((phase) => {
      const agents = [
        ...new Set(
          detail.passes
            .filter((pass) => pass.phaseKey === phase.phaseKey)
            .map((pass) => pass.agent),
        ),
      ];
      return `<tr><td>${phaseSwatch(phase.color)}${escapeHtml(phase.phaseLabel)}</td><td>${escapeHtml(agents.join(", ") || "—")}</td><td>${escapeHtml(phase.passCount)}</td><td>${escapeHtml(formatDuration(phase.activeMs))}</td></tr>`;
    })
    .join("");
}

function agentRows(detail: ReportDetailModel): string {
  if (detail.agents.length === 0) return '<tr><td colspan="3">None</td></tr>';
  return detail.agents
    .map(
      (agent) =>
        `<tr><td>${escapeHtml(agent.agent)}</td><td>${escapeHtml(agent.passCount)}</td><td>${escapeHtml(formatDuration(agent.activeMs))}</td></tr>`,
    )
    .join("");
}

function sessionRows(detail: ReportDetailModel): string {
  if (detail.sessions.length === 0) return '<tr><td colspan="4">None</td></tr>';
  return detail.sessions
    .map((session: ReportDetailSessionTotal) => {
      return `<tr><td>${escapeHtml(session.sessionID)}</td><td>${escapeHtml(session.passCount)}</td><td>${escapeHtml(formatDuration(session.activeMs))}</td><td>${outcomeLabels(session.outcomes)}</td></tr>`;
    })
    .join("");
}

function passRows(detail: ReportDetailModel): string {
  if (detail.passes.length === 0) return '<tr><td colspan="8">None</td></tr>';
  return detail.passes
    .map(
      (pass) =>
        `<tr><td>${escapeHtml(pass.sessionID)}</td><td>${escapeHtml(pass.agent)}</td><td>${phaseSwatch(pass.color)}${escapeHtml(pass.phaseLabel)}</td><td>${escapeHtml(pass.passNumber)}</td><td>${escapeHtml(formatTime(pass.startedAt))}</td><td>${escapeHtml(formatTime(pass.endedAt))}</td><td>${escapeHtml(formatDuration(pass.activeMs))}</td><td>${escapeHtml(pass.outcome)}</td></tr>`,
    )
    .join("");
}

function timelineRows(detail: ReportDetailModel): string {
  if (detail.passes.length === 0) return '<tr><td colspan="3">None</td></tr>';
  // Incomplete passes have no terminal timing, so keep their active time unknown.
  return detail.passes
    .map(
      (pass) =>
        `<tr><td>${escapeHtml(pass.sessionID)}</td><td>${escapeHtml(pass.endedAt === null ? "—" : formatDuration(pass.activeMs))}</td><td class="segments"><div class="pass-label">P${escapeHtml(pass.passNumber)} · ${phaseSwatch(pass.color)}${escapeHtml(pass.phaseLabel)} · ${escapeHtml(pass.agent)} · ${escapeHtml(pass.outcome)}</div>${bars(pass, "pass-track")}</td></tr>`,
    )
    .join("");
}

function directPhaseRows(detail: ReportDetailModel): string {
  const rows = PHASES.filter((phase) => detail.phaseTotals[phase].actionCount > 0).map((phase) => {
    const metric = detail.phaseTotals[phase];
    return `<tr><td>${escapeHtml(PHASE_LABELS[phase])}</td><td>${escapeHtml(formatDuration(metric.activeMs))}</td><td>${escapeHtml(metric.actionCount)}</td></tr>`;
  });
  return rows.length === 0 ? '<tr><td colspan="3">None</td></tr>' : rows.join("");
}

function childMetric(child: ChildSummary, phase: ReportPhase): string {
  const metric = child.phaseTotals[phase];
  return `${formatDuration(metric.activeMs)} (${metric.actionCount})`;
}

function childRows(detail: ReportDetailModel): string {
  const children = detail.children ?? [];
  if (children.length === 0) return '<tr><td colspan="10">None</td></tr>';
  return children
    .map(
      (child) =>
        `<tr><td>${escapeHtml(child.beadID)}</td><td>${escapeHtml(child.type)}</td><td>${escapeHtml(child.lifecycleState)}</td><td>${escapeHtml(childMetric(child, "coordination"))}</td><td>${escapeHtml(childMetric(child, "implementation"))}</td><td>${escapeHtml(childMetric(child, "review"))}</td><td>${escapeHtml(childMetric(child, "integration-validation"))}</td><td>${escapeHtml(childMetric(child, "build"))}</td><td>${escapeHtml(childMetric(child, "unclassified"))}</td><td>${escapeHtml(formatDuration(child.metrics.activeMs))}</td></tr>`,
    )
    .join("");
}

function repeatRows(detail: ReportDetailModel): string {
  if (detail.repeats.length === 0) return "<li>None</li>";
  return detail.repeats
    .map(
      (repeat) =>
        `<li>${escapeHtml(repeat.agent)} / ${escapeHtml(repeat.sessionID)} — ${escapeHtml(repeat.phaseLabel)}: ${escapeHtml(repeat.passes)} pass(es)${repeat.repeated ? " (repeated)" : ""}; pass numbers ${escapeHtml(repeat.passNumbers.join(", "))}</li>`,
    )
    .join("");
}

/** Render the supplied report-detail projection as self-contained HTML. */
export function renderReportDetailHtml(detail: ReportDetailModel): string {
  const project =
    detail.projectLabel ??
    (detail.projectLabels.length > 0 ? detail.projectLabels.join(", ") : "—");
  const epic = detail.kind === "epic";
  const metrics = detail.metrics;
  const epicMetrics = epic
    ? [
        "<h2>Epic metrics</h2><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>",
        `<tr><td>Direct epic active time</td><td>${escapeHtml(formatDuration(metrics.directActiveMs ?? 0))}</td></tr>`,
        `<tr><td>Summed child active time</td><td>${escapeHtml(formatDuration(metrics.summedChildActiveMs ?? 0))}</td></tr>`,
        `<tr><td>Combined active time</td><td>${escapeHtml(formatDuration(metrics.combinedActiveMs ?? 0))}</td></tr>`,
        `<tr><td>Initiative elapsed time</td><td>${escapeHtml(formatDuration(metrics.initiativeElapsedMs ?? detail.durations.elapsedMs))}</td></tr>`,
        "</tbody></table>",
      ].join("")
    : "";
  const epicDetail = epic
    ? `${epicMetrics}<h2>Direct phase totals</h2><table><thead><tr><th>Phase</th><th>Active time</th><th>Actions</th></tr></thead><tbody>${directPhaseRows(detail)}</tbody></table><h2>Child summary</h2><table><thead><tr><th>Child</th><th>Type</th><th>Lifecycle</th><th>Coordination</th><th>Implementation</th><th>Review</th><th>Integration validation</th><th>Build</th><th>Unclassified</th><th>Total active</th></tr></thead><tbody>${childRows(detail)}</tbody></table>`
    : "";
  const warningRows =
    detail.warnings.length === 0
      ? "<li>None</li>"
      : detail.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestration tracker report</title><style>',
    "body{font:15px system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#202124;background:#fff}h1{font-size:1.7rem}h2{margin-top:2rem}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{border:1px solid #ccc;padding:.45rem;text-align:left;vertical-align:top}th{background:#f1f3f4}.muted{color:#5f6368}ul{padding-left:1.4rem}.swatch{display:inline-block;width:.8rem;height:.8rem;margin-right:.35rem;border:1px solid #888;vertical-align:middle}.legend{display:flex;flex-wrap:wrap;gap:.75rem;margin:.75rem 0;color:#3c4043}.legend-item{white-space:nowrap}.timeline-scroll{overflow-x:auto}.segments{min-width:18rem}.pass-label{margin-bottom:.25rem}.lane-track,.pass-track{position:relative;height:1.4rem;background:repeating-linear-gradient(90deg,#f8f9fa 0,#f8f9fa 9.9%,#e8eaed 10%,#e8eaed 10.2%);border:1px solid #9aa0a6;margin:.15rem 0}.pass-track{min-width:18rem}.timeline-segment{position:absolute;top:.15rem;height:1rem;box-sizing:border-box;padding:0 .2rem;overflow:hidden;white-space:nowrap;border:0;border-left:3px solid #3c4043;font-size:.8rem;color:#202124}.notice{border-left:3px solid #9aa0a6;padding-left:.7rem}",
    '</style></head><body><h1>Orchestration tracker report</h1><p class="muted">Private local report; contains only tracker summaries and no network assets.</p>',
    "<h2>Scope and selection</h2><dl>",
    `<dt>Scope</dt><dd>${escapeHtml(detail.kind)}</dd><dt>Bead</dt><dd>${escapeHtml(detail.beadID ?? "session scope")}</dd><dt>Project</dt><dd>${escapeHtml(project)}</dd><dt>Status</dt><dd>${escapeHtml(detail.status)}</dd><dt>Selection</dt><dd>${selection(detail)}</dd><dt>Generated</dt><dd>${escapeHtml(formatTime(detail.generatedAt))}</dd><dt>Finalized</dt><dd>${escapeHtml(formatTime(detail.finalizedAt))}</dd></dl>`,
    "<h2>Timing</h2>",
    `<p>Shared time scale: ${escapeHtml(formatTime(detail.scale.startAt))} → ${escapeHtml(formatTime(detail.scale.endAt))}. Window: ${escapeHtml(formatDuration(detail.durations.elapsedMs))} elapsed; ${escapeHtml(formatDuration(detail.durations.activeMs))} summed active pass time.</p>`,
    "<h2>Phases</h2><table><thead><tr><th>Phase</th><th>Observed agents</th><th>Passes</th><th>Active time</th></tr></thead><tbody>",
    phaseRows(detail),
    "</tbody></table><h2>Observed-agent totals</h2><table><thead><tr><th>Agent</th><th>Passes</th><th>Active time</th></tr></thead><tbody>",
    agentRows(detail),
    '</tbody></table><h2>Session lanes</h2><div class="legend" aria-label="Timeline legend"><strong>Timeline legend:</strong>',
    phaseLegend(detail),
    '</div><p class="muted">P&lt;n&gt; labels are session-local action ordinals: they restart independently for each session and are not global workflow rounds. Bars show pass timing and are not interactive controls. Discontiguous selected slices remain separate bars on their pass row.</p><h3>Session summary</h3><table><thead><tr><th>Session</th><th>Passes</th><th>Active time</th><th>Outcomes</th></tr></thead><tbody>',
    sessionRows(detail),
    '</tbody></table><h3>Phase segments / Session–Shared timeline</h3><div class="timeline-scroll"><table><thead><tr><th>Session</th><th>Active time</th><th>Shared timeline</th></tr></thead><tbody>',
    timelineRows(detail),
    "</tbody></table></div><h2>Passes</h2><table><thead><tr><th>Session</th><th>Observed agent</th><th>Phase</th><th>Pass</th><th>Start</th><th>End</th><th>Duration</th><th>Outcome</th></tr></thead><tbody>",
    passRows(detail),
    `</tbody></table><h2>Outcomes</h2><ul>${outcomeList(metrics.outcomes)}</ul>${epicDetail}<h2>Repeat signals</h2><p class="muted">Repeated passes are diagnostic, not proof of poor scoping.</p><ul>${repeatRows(detail)}</ul><h2>Warnings</h2><ul>${warningRows}</ul><p class="notice">Incomplete: ${escapeHtml(detail.incomplete)}; unmapped: ${escapeHtml(detail.unmapped)}.</p></body></html>`,
  ].join("");
}
