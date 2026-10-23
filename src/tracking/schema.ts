import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** The clean-break database deliberately does not reuse the previous tracker generation. */
export const DATABASE_FILENAME = "tracker-v3.sqlite";
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    project_label TEXT NOT NULL,
    next_pass_number INTEGER NOT NULL,
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL
  );
  CREATE TABLE beads (
    bead_id TEXT PRIMARY KEY,
    bead_type TEXT NOT NULL CHECK (bead_type IN ('epic', 'task', 'bug', 'feature', 'chore')),
    parent_bead_id TEXT REFERENCES beads(bead_id) ON DELETE RESTRICT,
    validated_at INTEGER NOT NULL
  );
  CREATE TABLE session_attributions (
    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    bead_id TEXT NOT NULL REFERENCES beads(bead_id) ON DELETE RESTRICT,
    source TEXT NOT NULL CHECK (source IN ('creation', 'selection', 'launch-descriptor', 'inherited-lane')),
    changed_at INTEGER NOT NULL
  );
  CREATE TABLE actions (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    action_id TEXT NOT NULL,
    pass_number INTEGER NOT NULL,
    observed_role TEXT NOT NULL,
    phase_key TEXT NOT NULL,
    phase_label TEXT NOT NULL,
    repeat_eligible INTEGER NOT NULL CHECK (repeat_eligible IN (0, 1)),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('open', 'completed', 'failed', 'interrupted', 'incomplete')),
    start_receipt_id TEXT,
    end_receipt_id TEXT,
    PRIMARY KEY (session_id, action_id)
  );
  CREATE UNIQUE INDEX actions_pass_number ON actions(session_id, pass_number);
  CREATE INDEX actions_open_by_session ON actions(session_id, outcome, started_at DESC);
  CREATE TABLE activity_slices (
    slice_id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    bead_id TEXT REFERENCES beads(bead_id) ON DELETE RESTRICT,
    association_source TEXT CHECK (association_source IS NULL OR association_source IN ('creation', 'selection', 'launch-descriptor', 'inherited-lane')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    FOREIGN KEY (session_id, action_id) REFERENCES actions(session_id, action_id) ON DELETE CASCADE
  );
  CREATE INDEX slices_by_session ON activity_slices(session_id, started_at);
  CREATE TABLE association_receipts (
    receipt_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    bead_id TEXT NOT NULL REFERENCES beads(bead_id) ON DELETE RESTRICT,
    source TEXT NOT NULL CHECK (source IN ('creation', 'selection', 'launch-descriptor', 'inherited-lane')),
    observed_at INTEGER NOT NULL,
    source_receipt_id TEXT
  );
  CREATE INDEX association_receipts_by_session ON association_receipts(session_id, observed_at);
  CREATE TABLE lifecycle_receipts (
    event_id TEXT PRIMARY KEY,
    aggregate_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('session.created', 'session.deleted', 'action.started', 'action.ended')),
    observed_at INTEGER NOT NULL,
    session_id TEXT,
    action_id TEXT,
    UNIQUE (aggregate_id, sequence)
  );
  CREATE INDEX lifecycle_receipts_by_aggregate ON lifecycle_receipts(aggregate_id, sequence);
  CREATE TABLE closeouts (
    bead_id TEXT PRIMARY KEY REFERENCES beads(bead_id) ON DELETE RESTRICT,
    receipt_id TEXT NOT NULL UNIQUE,
    closeout_kind TEXT NOT NULL CHECK (closeout_kind IN ('epic', 'concrete')),
    closed_at INTEGER NOT NULL
  );
  CREATE TABLE reports (
    report_id TEXT PRIMARY KEY,
    artifact_path TEXT NOT NULL UNIQUE,
    selector_fingerprint TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    source_high_water_mark INTEGER NOT NULL,
    generated_at INTEGER NOT NULL
  );
`;

/** Open and bootstrap the private tracker database without changing its schema contract. */
export function openTrackerDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  protect(dataDir, 0o700);
  const databasePath = join(dataDir, DATABASE_FILENAME);
  const db = new Database(databasePath);
  try {
    protect(databasePath, 0o600);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const version =
      db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version !== 0 && version !== SCHEMA_VERSION)
      throw new Error("tracker database schema is not supported");
    if (version === 0) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      })();
    }
    protectTrackerDatabaseFiles(dataDir);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function protectTrackerDatabaseFiles(dataDir: string): void {
  protect(join(dataDir, DATABASE_FILENAME), 0o600);
  protect(join(dataDir, `${DATABASE_FILENAME}-wal`), 0o600);
  protect(join(dataDir, `${DATABASE_FILENAME}-shm`), 0o600);
}

function protect(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Creation and restrictive directory permissions are the required safeguards; chmod is best effort.
  }
}
