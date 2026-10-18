import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mappingFor, type PhaseMapping, type TrackerOptions } from "./options.js";

export type PassOutcome = "open" | "completed" | "failed" | "interrupted" | "incomplete";

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

const LATEST_SCHEMA = 1;

const MIGRATION_1 = `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  project_label TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  pass_number INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  observed_agent TEXT,
  phase_key TEXT NOT NULL,
  phase_label TEXT NOT NULL,
  repeat_eligible INTEGER NOT NULL CHECK (repeat_eligible IN (0, 1)),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('open', 'completed', 'failed', 'interrupted', 'incomplete')),
  UNIQUE (session_id, pass_number),
  UNIQUE (session_id, message_id)
);
CREATE INDEX passes_open_by_session ON passes (session_id, outcome, pass_number DESC);
CREATE TABLE lifecycle_receipts (
  event_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE (aggregate_id, sequence)
);
CREATE INDEX receipts_by_aggregate ON lifecycle_receipts (aggregate_id, sequence DESC);
`;

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

export class TrackerStore {
  private constructor(private readonly db: Database, private readonly options: TrackerOptions) {}

  static open(options: TrackerOptions): TrackerStore {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(options.dataDir, 0o700);
    } catch {
      // The database remains usable on filesystems that do not support chmod.
    }
    const databasePath = join(options.dataDir, "tracker.sqlite");
    const db = new Database(databasePath);
    try {
      try {
        chmodSync(databasePath, 0o600);
      } catch {
        // Keep operating on filesystems that do not expose Unix permissions.
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
    this.transaction(() => this.ensureSession(input, input.observedAt ?? Date.now()));
  }

  admit(input: AdmitInput): PassRecord {
    const now = input.startedAt ?? Date.now();
    const mapping = mappingFor(this.options, input.agent);
    return this.transaction(() => {
      this.ensureSession(input, now);
      const next = this.db.query<{ next_number: number }>(
        "SELECT COALESCE(MAX(pass_number), 0) + 1 AS next_number FROM passes WHERE session_id = ?",
      ).get(input.sessionID)!.next_number;
      this.db.query(`
        INSERT INTO passes
          (session_id, pass_number, message_id, observed_agent, phase_key, phase_label, repeat_eligible, started_at, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
        ON CONFLICT (session_id, message_id) DO NOTHING
      `).run(
        input.sessionID,
        next,
        input.messageID,
        input.agent ?? null,
        mapping.phaseKey,
        mapping.phaseLabel,
        mapping.repeatEligible ? 1 : 0,
        now,
      );
      return rowToPass(this.db.query<PassRow>(
        "SELECT * FROM passes WHERE session_id = ? AND message_id = ?",
      ).get(input.sessionID, input.messageID)!);
    });
  }

  closeExecution(input: ExecutionInput): boolean {
    return this.transactionImmediate(() => {
      const latest = this.db.query<{ sequence: number }>(
        "SELECT sequence FROM lifecycle_receipts WHERE aggregate_id = ? ORDER BY sequence DESC LIMIT 1",
      ).get(input.aggregateID);
      if (latest && input.sequence <= latest.sequence) return false;

      const receipt = this.db.query(`
        INSERT OR IGNORE INTO lifecycle_receipts (event_id, aggregate_id, sequence, event_type, observed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.eventID, input.aggregateID, input.sequence, `session.execution.${input.outcome}`, input.endedAt);
      if (receipt.changes !== 1) return false;

      if (input.session) this.ensureSession(input.session, input.endedAt);
      // Prompt admission has no execution event ID; event time is the durable order key
      // that keeps an older delayed terminal from selecting a later pass.
      const pass = this.db.query<{ id: number }>(
        "SELECT id FROM passes WHERE session_id = ? AND outcome = 'open' AND started_at <= ? ORDER BY pass_number DESC LIMIT 1",
      ).get(input.sessionID, input.endedAt);
      if (!pass) return true;
      this.db.query("UPDATE passes SET outcome = ?, ended_at = ? WHERE id = ? AND outcome = 'open'")
        .run(input.outcome, input.endedAt, pass.id);
      return true;
    });
  }

  /** Crash recovery deliberately keeps ended_at NULL: no terminal observation occurred. */
  recoverOpenPasses(): number {
    return this.db.query(
      "UPDATE passes SET outcome = 'incomplete', ended_at = NULL WHERE outcome = 'open'",
    ).run().changes;
  }

  listPasses(sessionID?: string): PassRecord[] {
    const rows = sessionID === undefined
      ? this.db.query<PassRow>("SELECT * FROM passes ORDER BY id").all()
      : this.db.query<PassRow>("SELECT * FROM passes WHERE session_id = ? ORDER BY id").all(sessionID);
    return rows.map(rowToPass);
  }

  listSessions(): Array<Record<string, unknown>> {
    return this.db.query("SELECT * FROM sessions ORDER BY session_id").all();
  }

  listReceipts(): Array<Record<string, unknown>> {
    return this.db.query("SELECT * FROM lifecycle_receipts ORDER BY event_id").all();
  }

  private ensureSession(input: SessionInput, observedAt: number): void {
    if (input.parentID && input.parentID !== input.sessionID) {
      this.db.query(`
        INSERT INTO sessions (session_id, project_id, workspace_id, project_label, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO NOTHING
      `).run(input.parentID, input.projectID, input.workspaceID ?? null, input.projectLabel, observedAt, observedAt);
    }
    this.db.query(`
      INSERT INTO sessions (session_id, parent_id, project_id, workspace_id, project_label, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        parent_id = COALESCE(sessions.parent_id, excluded.parent_id),
        project_id = excluded.project_id,
        workspace_id = COALESCE(excluded.workspace_id, sessions.workspace_id),
        project_label = excluded.project_label,
        last_seen = excluded.last_seen
    `).run(
      input.sessionID,
      input.parentID && input.parentID !== input.sessionID ? input.parentID : null,
      input.projectID,
      input.workspaceID ?? null,
      input.projectLabel,
      observedAt,
      observedAt,
    );
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
        // Preserve the original failure if rollback itself cannot run.
      }
      throw error;
    }
  }
}

function migrate(db: Database): void {
  const row = db.query<{ user_version: number }>("PRAGMA user_version").get();
  const version = row?.user_version ?? 0;
  if (version > LATEST_SCHEMA) throw new Error("tracker database schema is newer than supported");
  if (version === LATEST_SCHEMA) return;
  db.transaction(() => {
    if (version < 1) {
      db.exec(MIGRATION_1);
      db.exec("PRAGMA user_version = 1;");
    }
  })();
}

export type { PhaseMapping };
