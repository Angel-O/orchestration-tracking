import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { mappingFor, type PhaseMapping, type TrackerOptions } from "./options.js";
import { validateBeadID } from "./validation.js";

export type PassOutcome = "open" | "completed" | "failed" | "interrupted" | "incomplete";
export type AssociationSource = "root" | "parent-chain" | "explicit-primary";
export interface SessionInput {
  readonly sessionID: string;
  readonly parentID?: string;
  readonly projectID: string;
  readonly workspaceID?: string;
  readonly projectLabel: string;
  readonly observedAt?: number;
}
export interface AdmitInput extends SessionInput {
  readonly messageID: string;
  readonly agent?: string;
  readonly startedAt?: number;
}
export interface PassRecord {
  readonly id: number;
  readonly sessionID: string;
  readonly passNumber: number;
  readonly messageID: string;
  readonly observedAgent: string | null;
  readonly phaseKey: string;
  readonly phaseLabel: string;
  readonly repeatEligible: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: PassOutcome;
}
export interface ExecutionInput {
  readonly eventID: string;
  readonly aggregateID: string;
  readonly sequence: number;
  readonly sessionID: string;
  readonly outcome: Exclude<PassOutcome, "open" | "incomplete">;
  readonly endedAt: number;
  readonly session?: SessionInput;
}
export interface RunRecord {
  readonly runID: string;
  readonly rootSessionID: string;
  readonly beadID: string | null;
  readonly projectLabel: string;
  readonly status: "open" | "finalized";
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly workStartedAt: number | null;
  readonly workEndedAt: number | null;
  readonly reportPath: string | null;
}
export interface ReportSelector {
  readonly bead?: string;
  readonly sessions?: string[];
  readonly from?: number;
  readonly to?: number;
}
export interface ReportPass {
  readonly sessionID: string;
  readonly observedAgent: string;
  readonly phaseKey: string;
  readonly phaseLabel: string;
  readonly phaseColor: string;
  readonly passNumber: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number;
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly outcome: PassOutcome;
}
export interface ReportData {
  readonly beadID?: string;
  readonly projectLabel: string;
  readonly status: "open" | "finalized";
  readonly selection: ReportSelector;
  readonly generatedAt: number;
  readonly finalizedAt: number | null;
  readonly timeScale: { readonly start: number; readonly end: number };
  readonly summary: {
    readonly elapsedMs: number;
    readonly activeMs: number;
    readonly passes: number;
  };
  readonly phases: Array<{
    label: string;
    agents: string[];
    passes: number;
    activeMs: number;
    color: string;
  }>;
  readonly observedAgents: Array<{ agent: string; passes: number; activeMs: number }>;
  readonly lanes: Array<{
    sessionID: string;
    passes: number;
    activeMs: number;
    outcomes: string[];
    segments: ReportPass[];
  }>;
  readonly passes: ReportPass[];
  readonly outcomes: Record<string, number>;
  readonly repeats: Array<{
    agent: string;
    sessionID: string;
    phaseLabel: string;
    passes: number;
    repeated: boolean;
  }>;
  readonly warnings: string[];
}
export interface ReportRecord {
  readonly reportID: string;
  readonly kind: "bead" | "ad-hoc";
  readonly beadID?: string;
  readonly path: string;
  readonly generatedAt: number;
}
interface PassRow {
  id: number;
  session_id: string;
  pass_number: number;
  message_id: string;
  observed_agent: string | null;
  phase_key: string;
  phase_label: string;
  repeat_eligible: number;
  started_at: number;
  ended_at: number | null;
  outcome: PassOutcome;
}
interface SessionRow {
  session_id: string;
  parent_id: string | null;
  project_label: string;
}
interface RunRow {
  run_id: string;
  root_session_id: string;
  bead_id: string | null;
  project_label: string;
  status: "open" | "finalized";
  started_at: number;
  ended_at: number | null;
  work_started_at: number | null;
  work_ended_at: number | null;
  report_path: string | null;
}
const LATEST_SCHEMA = 3;
const MIGRATION_1 = `CREATE TABLE sessions (session_id TEXT PRIMARY KEY, parent_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL, project_id TEXT NOT NULL, workspace_id TEXT, project_label TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL); CREATE TABLE passes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, pass_number INTEGER NOT NULL, message_id TEXT NOT NULL, observed_agent TEXT, phase_key TEXT NOT NULL, phase_label TEXT NOT NULL, repeat_eligible INTEGER NOT NULL CHECK (repeat_eligible IN (0, 1)), started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL CHECK (outcome IN ('open', 'completed', 'failed', 'interrupted', 'incomplete')), UNIQUE (session_id, pass_number), UNIQUE (session_id, message_id)); CREATE INDEX passes_open_by_session ON passes (session_id, outcome, pass_number DESC); CREATE TABLE lifecycle_receipts (event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL, observed_at INTEGER NOT NULL, UNIQUE (aggregate_id, sequence)); CREATE INDEX receipts_by_aggregate ON lifecycle_receipts (aggregate_id, sequence DESC);`;
const MIGRATION_2 = `CREATE TABLE runs (run_id TEXT PRIMARY KEY, root_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id), bead_id TEXT UNIQUE, project_label TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','finalized')), started_at INTEGER NOT NULL, ended_at INTEGER, report_path TEXT); CREATE TABLE run_sessions (run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, source TEXT NOT NULL CHECK(source IN ('root','parent-chain','explicit-primary')), PRIMARY KEY(run_id, session_id)); CREATE INDEX run_sessions_by_session ON run_sessions(session_id); CREATE TABLE reports (report_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('bead','ad-hoc')), bead_id TEXT UNIQUE, run_id TEXT, selector_json TEXT, generated_at INTEGER NOT NULL, path TEXT NOT NULL);`;
const MIGRATION_3 =
  "ALTER TABLE runs ADD COLUMN work_started_at INTEGER; ALTER TABLE runs ADD COLUMN work_ended_at INTEGER;";
function rowToPass(row: PassRow): PassRecord {
  return {
    id: row.id,
    sessionID: row.session_id,
    passNumber: row.pass_number,
    messageID: row.message_id,
    observedAgent: row.observed_agent,
    phaseKey: row.phase_key,
    phaseLabel: row.phase_label,
    repeatEligible: row.repeat_eligible === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
  };
}
function rowToRun(row: RunRow): RunRecord {
  return {
    runID: row.run_id,
    rootSessionID: row.root_session_id,
    beadID: row.bead_id,
    projectLabel: row.project_label,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    workStartedAt: row.work_started_at,
    workEndedAt: row.work_ended_at,
    reportPath: row.report_path,
  };
}
const PHASE_COLORS = ["#cfe8ff", "#d9f2d9", "#ffe4b5", "#eadcff", "#ffd6e7", "#d8f3f0"];
function phaseColor(phaseKey: string): string {
  let hash = 0;
  for (const character of phaseKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PHASE_COLORS[hash % PHASE_COLORS.length]!;
}

export class TrackerStore {
  private constructor(
    private readonly db: Database,
    readonly options: TrackerOptions,
  ) {}
  static open(options: TrackerOptions): TrackerStore {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(options.dataDir, 0o700);
    } catch {
      /* best effort */
    }
    const databasePath = join(options.dataDir, "tracker.sqlite");
    const db = new Database(databasePath);
    try {
      try {
        chmodSync(databasePath, 0o600);
      } catch {
        /* best effort */
      }
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      migrate(db);
      return new TrackerStore(db, options);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  recordSession(input: SessionInput): void {
    this.transaction(() => {
      this.ensureSession(input, input.observedAt ?? Date.now());
      this.propagateParentAssociation(input);
    });
  }
  admit(input: AdmitInput): PassRecord {
    const now = input.startedAt ?? Date.now();
    const mapping = mappingFor(this.options, input.agent);
    return this.transaction(() => {
      this.ensureSession(input, now);
      this.propagateParentAssociation(input);
      const next = this.db
        .query<{ next_number: number }>(
          "SELECT COALESCE(MAX(pass_number), 0) + 1 AS next_number FROM passes WHERE session_id = ?",
        )
        .get(input.sessionID)!.next_number;
      this.db
        .query(
          "INSERT INTO passes (session_id, pass_number, message_id, observed_agent, phase_key, phase_label, repeat_eligible, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open') ON CONFLICT (session_id, message_id) DO NOTHING",
        )
        .run(
          input.sessionID,
          next,
          input.messageID,
          input.agent ?? null,
          mapping.phaseKey,
          mapping.phaseLabel,
          mapping.repeatEligible ? 1 : 0,
          now,
        );
      return rowToPass(
        this.db
          .query<PassRow>("SELECT * FROM passes WHERE session_id = ? AND message_id = ?")
          .get(input.sessionID, input.messageID)!,
      );
    });
  }
  closeExecution(input: ExecutionInput): boolean {
    return this.transactionImmediate(() => {
      const latest = this.db
        .query<{ sequence: number }>(
          "SELECT sequence FROM lifecycle_receipts WHERE aggregate_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(input.aggregateID);
      if (latest && input.sequence <= latest.sequence) return false;
      const receipt = this.db
        .query(
          "INSERT OR IGNORE INTO lifecycle_receipts (event_id, aggregate_id, sequence, event_type, observed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.eventID,
          input.aggregateID,
          input.sequence,
          `session.execution.${input.outcome}`,
          input.endedAt,
        );
      if (receipt.changes !== 1) return false;
      if (input.session) this.ensureSession(input.session, input.endedAt);
      const pass = this.db
        .query<{ id: number }>(
          "SELECT id FROM passes WHERE session_id = ? AND outcome = 'open' AND started_at <= ? ORDER BY pass_number DESC LIMIT 1",
        )
        .get(input.sessionID, input.endedAt);
      if (!pass) return true;
      this.db
        .query("UPDATE passes SET outcome = ?, ended_at = ? WHERE id = ? AND outcome = 'open'")
        .run(input.outcome, input.endedAt, pass.id);
      return true;
    });
  }
  recoverOpenPasses(): number {
    return this.db
      .query("UPDATE passes SET outcome = 'incomplete', ended_at = NULL WHERE outcome = 'open'")
      .run().changes;
  }
  listPasses(sessionID?: string): PassRecord[] {
    const rows =
      sessionID === undefined
        ? this.db.query<PassRow>("SELECT * FROM passes ORDER BY id").all()
        : this.db
            .query<PassRow>("SELECT * FROM passes WHERE session_id = ? ORDER BY id")
            .all(sessionID);
    return rows.map(rowToPass);
  }
  listSessions(): Array<Record<string, unknown>> {
    return this.db.query("SELECT * FROM sessions ORDER BY session_id").all();
  }
  listReceipts(): Array<Record<string, unknown>> {
    return this.db.query("SELECT * FROM lifecycle_receipts ORDER BY event_id").all();
  }
  startRun(input: { beadID: string; root: SessionInput; startedAt?: number }): RunRecord {
    const beadID = validateBeadID(input.beadID);
    const startedAt = input.startedAt ?? Date.now();
    return this.transactionImmediate(() => {
      this.ensureSession(input.root, startedAt);
      const byRoot = this.db
        .query<RunRow>("SELECT * FROM runs WHERE root_session_id = ?")
        .get(input.root.sessionID);
      const byBead = this.db.query<RunRow>("SELECT * FROM runs WHERE bead_id = ?").get(beadID);
      if (byRoot && byRoot.bead_id !== beadID)
        throw new Error("root session is already assigned to another run");
      if (byBead && byBead.root_session_id !== input.root.sessionID)
        throw new Error("bead already has a different root run");
      const row = byRoot ?? byBead;
      if (row) {
        this.addAssociation(row.run_id, input.root.sessionID, "root");
        this.associateDescendants(row.run_id, input.root.sessionID);
        return rowToRun(row);
      }
      const runID = randomUUID();
      this.db
        .query(
          "INSERT INTO runs (run_id, root_session_id, bead_id, project_label, status, started_at) VALUES (?, ?, ?, ?, 'open', ?)",
        )
        .run(runID, input.root.sessionID, beadID, input.root.projectLabel, startedAt);
      this.addAssociation(runID, input.root.sessionID, "root");
      this.associateDescendants(runID, input.root.sessionID);
      return rowToRun(this.db.query<RunRow>("SELECT * FROM runs WHERE run_id = ?").get(runID)!);
    });
  }
  getRun(runID: string): RunRecord | undefined {
    const row = this.db.query<RunRow>("SELECT * FROM runs WHERE run_id = ?").get(runID);
    return row ? rowToRun(row) : undefined;
  }
  findRunByBead(beadID: string): RunRecord | undefined {
    const row = this.db
      .query<RunRow>("SELECT * FROM runs WHERE bead_id = ?")
      .get(validateBeadID(beadID));
    return row ? rowToRun(row) : undefined;
  }
  findRunForSession(sessionID: string): RunRecord | undefined {
    const row = this.db
      .query<RunRow>(
        "SELECT runs.* FROM runs JOIN run_sessions ON run_sessions.run_id = runs.run_id WHERE run_sessions.session_id = ? ORDER BY runs.status = 'open' DESC, runs.started_at DESC LIMIT 1",
      )
      .get(sessionID);
    return row ? rowToRun(row) : undefined;
  }
  listRunSessions(runID: string): Array<{ sessionID: string; source: AssociationSource }> {
    return this.db
      .query<{ session_id: string; source: AssociationSource }>(
        "SELECT session_id, source FROM run_sessions WHERE run_id = ? ORDER BY session_id",
      )
      .all(runID)
      .map((row) => ({ sessionID: row.session_id, source: row.source }));
  }
  attachLane(input: { runID: string; session: SessionInput }): void {
    this.transactionImmediate(() => {
      const run = this.db.query<RunRow>("SELECT * FROM runs WHERE run_id = ?").get(input.runID);
      if (!run) throw new Error("run not found");
      if (run.status === "finalized") throw new Error("run is finalized");
      this.attachLaneToRun(run, input.session);
    });
  }
  attachPrimaryByBead(input: { beadID: string; session: SessionInput }): void {
    const beadID = validateBeadID(input.beadID);
    this.transactionImmediate(() => {
      const run = this.db
        .query<RunRow>("SELECT * FROM runs WHERE bead_id = ? AND status = 'open'")
        .get(beadID);
      if (!run) throw new Error("open run not found");
      this.attachLaneToRun(run, input.session);
    });
  }
  finalizeRun(beadID: string, endedAt = Date.now()): RunRecord {
    return this.transactionImmediate(() => {
      const run = this.db
        .query<RunRow>("SELECT * FROM runs WHERE bead_id = ?")
        .get(validateBeadID(beadID));
      if (!run) throw new Error("no run exists for bead");
      if (run.status === "finalized" && run.work_started_at !== null) return rowToRun(run);
      this.db
        .query(
          "UPDATE passes SET outcome = 'incomplete', ended_at = NULL WHERE outcome = 'open' AND session_id IN (SELECT session_id FROM run_sessions WHERE run_id = ?)",
        )
        .run(run.run_id);
      const bounds = this.db
        .query<{ work_started_at: number | null; work_ended_at: number | null }>(
          "SELECT MIN(started_at) AS work_started_at, MAX(ended_at) AS work_ended_at FROM passes WHERE session_id IN (SELECT session_id FROM run_sessions WHERE run_id = ?)",
        )
        .get(run.run_id)!;
      this.db
        .query(
          "UPDATE runs SET status = 'finalized', ended_at = ?, work_started_at = ?, work_ended_at = ? WHERE run_id = ?",
        )
        .run(endedAt, bounds.work_started_at, bounds.work_ended_at, run.run_id);
      return rowToRun(
        this.db.query<RunRow>("SELECT * FROM runs WHERE run_id = ?").get(run.run_id)!,
      );
    });
  }
  recordReport(record: ReportRecord): void {
    this.transaction(() => {
      this.db
        .query(
          "INSERT INTO reports (report_id, kind, bead_id, generated_at, path) VALUES (?, ?, ?, ?, ?) ON CONFLICT (bead_id) DO UPDATE SET report_id = excluded.report_id, kind = excluded.kind, generated_at = excluded.generated_at, path = excluded.path",
        )
        .run(record.reportID, record.kind, record.beadID ?? null, record.generatedAt, record.path);
      if (record.beadID)
        this.db
          .query("UPDATE runs SET report_path = ? WHERE bead_id = ?")
          .run(record.path, record.beadID);
    });
  }
  listReports(): Array<Record<string, unknown>> {
    return this.db
      .query(
        "SELECT report_id, kind, bead_id, generated_at, path FROM reports ORDER BY generated_at",
      )
      .all();
  }
  reportData(selector: ReportSelector, now = Date.now()): ReportData {
    const sessions = this.db
      .query<SessionRow>(
        "SELECT session_id, parent_id, project_label FROM sessions ORDER BY session_id",
      )
      .all();
    const known = new Set(sessions.map((item) => item.session_id));
    if (selector.sessions?.some((id) => !known.has(id)))
      throw new Error("unknown session in report selector");
    let allowed = selector.sessions ? new Set(selector.sessions) : undefined;
    let run: RunRow | undefined;
    if (selector.bead) {
      run =
        this.db
          .query<RunRow>("SELECT * FROM runs WHERE bead_id = ?")
          .get(validateBeadID(selector.bead)) ?? undefined;
      if (!run) throw new Error("no run exists for bead");
      const associated = this.db
        .query<{ session_id: string }>("SELECT session_id FROM run_sessions WHERE run_id = ?")
        .all(run.run_id);
      const beadSessions = new Set(associated.map((item) => item.session_id));
      allowed = allowed ? new Set([...allowed].filter((id) => beadSessions.has(id))) : beadSessions;
    }
    const selected = this.listPasses().filter(
      (pass) =>
        (!allowed || allowed.has(pass.sessionID)) &&
        (selector.from === undefined || (pass.endedAt ?? now) >= selector.from) &&
        (selector.to === undefined || pass.startedAt <= selector.to),
    );
    const projectLabel =
      run?.project_label ??
      sessions.find((item) => selected.some((pass) => pass.sessionID === item.session_id))
        ?.project_label ??
      "selected sessions";
    const phases = new Map<
      string,
      { label: string; agents: Set<string>; passes: number; activeMs: number; color: string }
    >();
    const lanes = new Map<
      string,
      { passes: number; activeMs: number; outcomes: Set<string>; segments: ReportPass[] }
    >();
    const observedAgents = new Map<string, { passes: number; activeMs: number }>();
    const outcomes: Record<string, number> = {};
    const repeats = new Map<
      string,
      { agent: string; sessionID: string; phaseLabel: string; passes: number; repeated: boolean }
    >();
    const warnings: string[] = [];
    const passStart = selected.length ? Math.min(...selected.map((pass) => pass.startedAt)) : now;
    const endedPasses = selected.filter((pass) => pass.endedAt !== null);
    const passEnd = !selected.length
      ? passStart
      : run?.status === "finalized"
        ? endedPasses.length
          ? Math.max(...endedPasses.map((pass) => pass.endedAt!))
          : passStart
        : Math.max(...selected.map((pass) => pass.endedAt ?? now));
    const timelineEnd = selected.length
      ? Math.max(passEnd, ...selected.map((pass) => pass.startedAt))
      : passEnd;
    const scaleRange = Math.max(1, timelineEnd - passStart);
    const passes: ReportPass[] = selected.map((pass) => {
      const activeMs = pass.endedAt === null ? 0 : Math.max(0, pass.endedAt - pass.startedAt);
      const agent = pass.observedAgent ?? "unmapped";
      const visualEnd = pass.endedAt ?? (run?.status === "finalized" ? pass.startedAt : now);
      const leftPercent = Math.max(
        0,
        Math.min(100, ((pass.startedAt - passStart) / scaleRange) * 100),
      );
      const endPercent = Math.max(
        leftPercent,
        Math.min(100, ((visualEnd - passStart) / scaleRange) * 100),
      );
      const result: ReportPass = {
        sessionID: pass.sessionID,
        observedAgent: agent,
        phaseKey: pass.phaseKey,
        phaseLabel: pass.phaseLabel,
        phaseColor: phaseColor(pass.phaseKey),
        passNumber: pass.passNumber,
        startedAt: pass.startedAt,
        endedAt: pass.endedAt,
        durationMs: activeMs,
        leftPercent,
        widthPercent: endPercent - leftPercent,
        outcome: pass.outcome,
      };
      const phase = phases.get(pass.phaseKey) ?? {
        label: pass.phaseLabel,
        agents: new Set<string>(),
        passes: 0,
        activeMs: 0,
        color: result.phaseColor,
      };
      phase.agents.add(agent);
      phase.passes++;
      phase.activeMs += activeMs;
      phases.set(pass.phaseKey, phase);
      const lane = lanes.get(pass.sessionID) ?? {
        passes: 0,
        activeMs: 0,
        outcomes: new Set<string>(),
        segments: [],
      };
      lane.passes++;
      lane.activeMs += activeMs;
      lane.outcomes.add(pass.outcome);
      lane.segments.push(result);
      lanes.set(pass.sessionID, lane);
      const agentTotal = observedAgents.get(agent) ?? { passes: 0, activeMs: 0 };
      agentTotal.passes++;
      agentTotal.activeMs += activeMs;
      observedAgents.set(agent, agentTotal);
      outcomes[pass.outcome] = (outcomes[pass.outcome] ?? 0) + 1;
      if (pass.outcome === "incomplete") warnings.push(`incomplete pass in ${pass.sessionID}`);
      if (pass.phaseKey === "unmapped") warnings.push(`unmapped agent in ${pass.sessionID}`);
      if (pass.repeatEligible) {
        const key = `${agent}\u0000${pass.sessionID}`;
        const repeat = repeats.get(key) ?? {
          agent,
          sessionID: pass.sessionID,
          phaseLabel: pass.phaseLabel,
          passes: 0,
          repeated: false,
        };
        repeat.passes++;
        repeat.repeated = repeat.passes > 1;
        repeats.set(key, repeat);
      }
      return result;
    });
    return {
      beadID: run?.bead_id ?? undefined,
      projectLabel,
      status: run?.status ?? "open",
      selection: selector,
      generatedAt: now,
      finalizedAt: run?.ended_at ?? null,
      timeScale: { start: passStart, end: timelineEnd },
      summary: {
        elapsedMs: Math.max(0, passEnd - passStart),
        activeMs: passes.reduce((sum, pass) => sum + pass.durationMs, 0),
        passes: passes.length,
      },
      phases: [...phases.values()].map((phase) => ({
        label: phase.label,
        agents: [...phase.agents],
        passes: phase.passes,
        activeMs: phase.activeMs,
        color: phase.color,
      })),
      observedAgents: [...observedAgents.entries()].map(([agent, value]) => ({ agent, ...value })),
      lanes: [...lanes.entries()].map(([sessionID, lane]) => ({
        sessionID,
        passes: lane.passes,
        activeMs: lane.activeMs,
        outcomes: [...lane.outcomes],
        segments: lane.segments,
      })),
      passes,
      outcomes,
      repeats: [...repeats.values()],
      warnings: [...new Set(warnings)],
    };
  }
  private ensureSession(input: SessionInput, observedAt: number): void {
    if (input.parentID && input.parentID !== input.sessionID)
      this.db
        .query(
          "INSERT INTO sessions (session_id, project_id, workspace_id, project_label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (session_id) DO NOTHING",
        )
        .run(
          input.parentID,
          input.projectID,
          input.workspaceID ?? null,
          input.projectLabel,
          observedAt,
          observedAt,
        );
    this.db
      .query(
        "INSERT INTO sessions (session_id, parent_id, project_id, workspace_id, project_label, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET parent_id = COALESCE(sessions.parent_id, excluded.parent_id), project_id = excluded.project_id, workspace_id = COALESCE(excluded.workspace_id, sessions.workspace_id), project_label = excluded.project_label, last_seen = excluded.last_seen",
      )
      .run(
        input.sessionID,
        input.parentID && input.parentID !== input.sessionID ? input.parentID : null,
        input.projectID,
        input.workspaceID ?? null,
        input.projectLabel,
        observedAt,
        observedAt,
      );
  }
  private propagateParentAssociation(input: SessionInput): void {
    if (!input.parentID) return;
    const runs = this.db
      .query<{ run_id: string }>("SELECT run_id FROM run_sessions WHERE session_id = ?")
      .all(input.parentID);
    for (const run of runs) {
      this.addAssociation(run.run_id, input.sessionID, "parent-chain");
      this.associateDescendants(run.run_id, input.sessionID);
    }
  }
  private addAssociation(runID: string, sessionID: string, source: AssociationSource): void {
    this.db
      .query(
        "INSERT INTO run_sessions (run_id, session_id, source) VALUES (?, ?, ?) ON CONFLICT (run_id, session_id) DO UPDATE SET source = CASE WHEN run_sessions.source IN ('root', 'explicit-primary') THEN run_sessions.source ELSE excluded.source END",
      )
      .run(runID, sessionID, source);
  }
  private associateDescendants(
    runID: string,
    sessionID: string,
    visited = new Set<string>(),
  ): void {
    if (visited.has(sessionID)) return;
    visited.add(sessionID);
    const children = this.db
      .query<{ session_id: string }>("SELECT session_id FROM sessions WHERE parent_id = ?")
      .all(sessionID);
    for (const child of children) {
      this.addAssociation(runID, child.session_id, "parent-chain");
      this.associateDescendants(runID, child.session_id, visited);
    }
  }
  private attachLaneToRun(run: RunRow, session: SessionInput): void {
    const at = session.observedAt ?? Date.now();
    this.ensureSession(session, at);
    this.addAssociation(run.run_id, session.sessionID, "explicit-primary");
    let parent: string | null = session.parentID ?? null;
    while (parent && parent !== run.root_session_id) {
      this.addAssociation(run.run_id, parent, "parent-chain");
      parent =
        this.db
          .query<{ parent_id: string | null }>(
            "SELECT parent_id FROM sessions WHERE session_id = ?",
          )
          .get(parent)?.parent_id ?? null;
    }
    this.associateDescendants(run.run_id, session.sessionID);
  }
  private transaction<T>(callback: () => T): T {
    return this.db.transaction(callback)();
  }
  private transactionImmediate<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original */
      }
      throw error;
    }
  }
}
function migrate(db: Database): void {
  const version =
    db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version > LATEST_SCHEMA) throw new Error("tracker database schema is newer than supported");
  if (version === LATEST_SCHEMA) return;
  db.transaction(() => {
    if (version < 1) {
      db.exec(MIGRATION_1);
      db.exec("PRAGMA user_version = 1;");
    }
    if (version < 2) {
      db.exec(MIGRATION_2);
      db.exec("PRAGMA user_version = 2;");
    }
    if (version < 3) {
      db.exec(MIGRATION_3);
      db.exec("PRAGMA user_version = 3;");
    }
  })();
}
export type { PhaseMapping };
