import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateBeadID, parseTimestamp } from "./validation.js";
import type { ReportData, ReportSelector, TrackerStore } from "./store.js";

export interface ReportResult {
  readonly reportID: string;
  readonly path: string;
  readonly url: string;
  readonly summary: ReportData["summary"];
}

export function normalizeSelector(input: unknown, invokingSessionID?: string): ReportSelector {
  if (input === undefined) input = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("tracking_report arguments must be an object");
  const value = input as Record<string, unknown>;
  if ("allRuns" in value || "runID" in value) throw new Error("multi-run selectors are not supported");
  const bead = value.bead === undefined ? undefined : validateBeadID(value.bead);
  const sessions = value.sessions === undefined ? undefined : value.sessions;
  if (sessions !== undefined && (!Array.isArray(sessions) || sessions.length === 0 || sessions.some((id) => typeof id !== "string" || id.length === 0))) throw new Error("sessions must be a non-empty list of session IDs");
  const from = parseTimestamp(value.from, "from");
  const to = parseTimestamp(value.to, "to");
  if (from !== undefined && to !== undefined && from > to) throw new Error("from must not be after to");
  if (!bead && !sessions && from === undefined && to === undefined) {
    if (invokingSessionID) return { sessions: [invokingSessionID] };
    throw new Error("select a bead, sessions, or time range");
  }
  return { bead, sessions: sessions as string[] | undefined, from, to };
}

export function renderReport(data: ReportData): string {
  const escape = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const list = (items: readonly string[]) => items.map((item) => `<li>${escape(item)}</li>`).join("");
  const time = (value: number | null | undefined): string => value === null || value === undefined ? "—" : new Date(value).toISOString();
  const selection = [data.selection.bead ? `bead: ${data.selection.bead}` : "", data.selection.sessions?.length ? `sessions: ${data.selection.sessions.join(", ")}` : "", data.selection.from === undefined ? "" : `from: ${time(data.selection.from)}`, data.selection.to === undefined ? "" : `to: ${time(data.selection.to)}`].filter(Boolean).join("; ") || "invoking session";
  const phaseRows = data.phases.map((phase) => `<tr><td><span class="swatch" style="background:${escape(phase.color)}"></span>${escape(phase.label)}</td><td>${escape(phase.agents.join(", "))}</td><td>${phase.passes}</td><td>${phase.activeMs}</td></tr>`).join("");
  const agentRows = data.observedAgents.map((agent) => `<tr><td>${escape(agent.agent)}</td><td>${agent.passes}</td><td>${agent.activeMs}</td></tr>`).join("");
  const laneRows = data.lanes.map((lane) => `<tr><td>${escape(lane.sessionID)}</td><td>${lane.passes}</td><td>${lane.activeMs}</td><td>${escape(lane.outcomes.join(", "))}</td><td class="segments"><div class="lane-track">${lane.segments.map((pass) => `<span class="segment" style="left:${pass.leftPercent}%;width:${Math.max(pass.widthPercent, 0.2)}%;background:${escape(pass.phaseColor)}" title="${escape(`${pass.phaseLabel}; ${pass.observedAgent}; ${time(pass.startedAt)}; ${time(pass.endedAt)}`)}">P${pass.passNumber}</span>`).join("")}</div></td></tr>`).join("");
  const passRows = data.passes.map((pass) => `<tr><td>${escape(pass.sessionID)}</td><td>${escape(pass.observedAgent)}</td><td><span class="swatch" style="background:${escape(pass.phaseColor)}"></span>${escape(pass.phaseLabel)}</td><td>${pass.passNumber}</td><td>${time(pass.startedAt)}</td><td>${time(pass.endedAt)}</td><td>${pass.durationMs}</td><td>${escape(pass.outcome)}</td></tr>`).join("");
  const repeats = data.repeats.map((repeat) => `<li>${escape(repeat.agent)} / ${escape(repeat.sessionID)} — ${escape(repeat.phaseLabel)}: ${repeat.passes} pass(es)${repeat.repeated ? " (repeated)" : ""}</li>`).join("");
  const outcomes = Object.entries(data.outcomes).map(([outcome, count]) => `<li>${escape(outcome)}: ${count}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestration tracker report</title><style>body{font:15px system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#202124;background:#fff}h1{font-size:1.7rem}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{border:1px solid #ccc;padding:.45rem;text-align:left;vertical-align:top}th{background:#f1f3f4}.muted{color:#5f6368}ul{padding-left:1.4rem}.swatch{display:inline-block;width:.8rem;height:.8rem;margin-right:.35rem;border:1px solid #888}.segments{min-width:18rem}.lane-track{position:relative;height:1.4rem;background:#f8f9fa;border:1px solid #dadce0}.segment{position:absolute;top:.15rem;height:1rem;box-sizing:border-box;padding:0 .2rem;overflow:hidden;white-space:nowrap;border:1px solid #888;border-radius:.2rem;font-size:.8rem}</style></head><body><h1>Orchestration tracker report</h1><p class="muted">Private local report; contains only tracker summaries and no network assets.</p><h2>Scope and selection</h2><dl><dt>Project</dt><dd>${escape(data.projectLabel)}</dd><dt>Status</dt><dd>${escape(data.status)}</dd><dt>Selection</dt><dd>${escape(selection)}</dd><dt>Generated</dt><dd>${time(data.generatedAt)}</dd><dt>Finalized</dt><dd>${time(data.finalizedAt)}</dd>${data.beadID ? `<dt>Bead</dt><dd>${escape(data.beadID)}</dd>` : ""}</dl><h2>Timing</h2><p>Shared time scale: ${time(data.timeScale.start)} → ${time(data.timeScale.end)}. Window: ${data.summary.elapsedMs} ms elapsed; ${data.summary.activeMs} ms summed active pass time.</p><h2>Phases</h2><table><thead><tr><th>Phase</th><th>Observed agents</th><th>Passes</th><th>Active ms</th></tr></thead><tbody>${phaseRows}</tbody></table><h2>Observed-agent totals</h2><table><thead><tr><th>Agent</th><th>Passes</th><th>Active ms</th></tr></thead><tbody>${agentRows}</tbody></table><h2>Session lanes</h2><table><thead><tr><th>Session</th><th>Passes</th><th>Active ms</th><th>Outcomes</th><th>Phase segments</th></tr></thead><tbody>${laneRows}</tbody></table><h2>Passes</h2><table><thead><tr><th>Session</th><th>Observed agent</th><th>Phase</th><th>Pass</th><th>Start</th><th>End</th><th>Duration ms</th><th>Outcome</th></tr></thead><tbody>${passRows}</tbody></table><h2>Outcomes</h2><ul>${outcomes}</ul><h2>Repeat signals</h2><p class="muted">Repeated passes are diagnostic, not proof of poor scoping.</p><ul>${repeats}</ul><h2>Warnings</h2><ul>${list(data.warnings.length ? data.warnings : ["None"])}</ul></body></html>`;
}

export function writeReport(store: TrackerStore, selectorInput: unknown, now = Date.now(), invokingSessionID?: string): ReportResult {
  const isEmpty = selectorInput === undefined || (typeof selectorInput === "object" && selectorInput !== null && !Array.isArray(selectorInput) && Object.keys(selectorInput).length === 0);
  let selector = normalizeSelector(selectorInput, invokingSessionID);
  if (isEmpty && invokingSessionID) {
    const run = store.findRunForSession(invokingSessionID);
    if (run?.beadID) selector = { bead: run.beadID };
  }
  const data = store.reportData(selector, now);
  const reportID = data.beadID ? `bead-${data.beadID}` : randomUUID();
  const path = data.beadID ? join(store.options.dataDir, "reports", "beads", validateBeadID(data.beadID), "report.html") : join(store.options.dataDir, "reports", "ad-hoc", `${reportID}.html`);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* best effort */ }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, renderReport(data), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* preserve original */ } throw error; }
  store.recordReport({ reportID, kind: data.beadID ? "bead" : "ad-hoc", beadID: data.beadID, path, generatedAt: now });
  return { reportID, path, url: `file://${path}`, summary: data.summary };
}
