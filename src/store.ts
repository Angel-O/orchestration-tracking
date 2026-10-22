import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { TrackerOptions } from "./options.js";
import { validateBeadID } from "./validation.js";

/** The clean-break database deliberately does not reuse the legacy tracker file. */
export const DATABASE_FILENAME = "tracker-v2.sqlite";

export type BeadType = "epic" | "task" | "bug" | "feature" | "chore";
export type ActionOutcome = "open" | "completed" | "failed" | "interrupted" | "incomplete";
export type AssociationSource = "creation" | "selection" | "launch-descriptor" | "inherited-lane";

export interface SessionObservation {
  readonly sessionID: string;
  readonly parentSessionID?: string;
  readonly observedAt?: number;
  /** Optional host receipt for session.created. No payload is accepted or stored. */
  readonly receipt?: LifecycleReceipt;
}

export interface ActionStart {
  readonly sessionID: string;
  readonly actionID: string;
  readonly observedRole?: string;
  readonly startedAt?: number;
  readonly receiptID?: string;
}

export interface ActionEnd {
  readonly eventID: string;
  readonly aggregateID: string;
  readonly sequence: number;
  readonly sessionID: string;
  readonly actionID?: string;
  readonly outcome: Exclude<ActionOutcome, "open" | "incomplete">;
  readonly endedAt: number;
}

export interface LifecycleReceipt {
  readonly eventID: string;
  readonly aggregateID: string;
  readonly sequence: number;
  readonly eventType: "session.created" | "session.deleted" | "action.started" | "action.ended";
  readonly observedAt: number;
}

export interface TopologyRecord {
  readonly beadID: string;
  readonly type: BeadType;
  readonly parentBeadID?: string;
  readonly validatedAt?: number;
}

export interface AssociationRecord {
  readonly receiptID: string;
  readonly sessionID: string;
  readonly beadID: string;
  readonly source: AssociationSource;
  readonly observedAt?: number;
  readonly sourceReceiptID?: string;
}

export interface CloseoutRecord {
  readonly receiptID: string;
  readonly beadID: string;
  /** The invoking session, when closeout should reset its exact concrete attribution. */
  readonly sessionID?: string;
  readonly closedAt?: number;
}

export interface ReportMetadata {
  readonly reportID: string;
  /** Relative private artifact key; absolute filesystem paths are rejected. */
  readonly artifactPath: string;
  readonly selectorFingerprint: string;
  readonly policyVersion: string;
  readonly sourceHighWaterMark: number;
  readonly generatedAt?: number;
}

export interface SessionRecord {
  readonly sessionID: string;
  readonly parentSessionID: string | null;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export interface ActionRecord {
  readonly sessionID: string;
  readonly actionID: string;
  readonly observedRole: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: ActionOutcome;
  readonly startReceiptID: string | null;
}

export interface ActivitySliceRecord {
  readonly sliceID: number;
  readonly actionID: string;
  readonly sessionID: string;
  readonly beadID: string | null;
  readonly associationSource: AssociationSource | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface BeadRecord {
  readonly beadID: string;
  readonly type: BeadType;
  readonly parentBeadID: string | null;
  readonly validatedAt: number;
}

export interface AssociationReceiptRecord {
  readonly receiptID: string;
  readonly sessionID: string;
  readonly beadID: string;
  readonly source: AssociationSource;
  readonly observedAt: number;
  readonly sourceReceiptID: string | null;
}

export interface LifecycleReceiptRecord {
  readonly eventID: string;
  readonly aggregateID: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly observedAt: number;
}

export interface CloseoutRecordView {
  readonly receiptID: string;
  readonly beadID: string;
  readonly kind: "epic" | "concrete";
  readonly closedAt: number;
}

export interface ReportMetadataRecord {
  readonly reportID: string;
  readonly artifactPath: string;
  readonly selectorFingerprint: string;
  readonly policyVersion: string;
  readonly sourceHighWaterMark: number;
  readonly generatedAt: number;
}

type SessionRow = {
  session_id: string;
  parent_session_id: string | null;
  first_observed_at: number;
  last_observed_at: number;
};
type ActionRow = {
  session_id: string;
  action_id: string;
  observed_role: string;
  started_at: number;
  ended_at: number | null;
  outcome: ActionOutcome;
  start_receipt_id: string | null;
};
type SliceRow = {
  slice_id: number;
  action_id: string;
  session_id: string;
  bead_id: string | null;
  association_source: AssociationSource | null;
  started_at: number;
  ended_at: number | null;
};

const SCHEMA_VERSION = 2;
const SCHEMA = `
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
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
    observed_role TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('open', 'completed', 'failed', 'interrupted', 'incomplete')),
    start_receipt_id TEXT,
    PRIMARY KEY (session_id, action_id)
  );
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

const BEAD_TYPES = new Set<BeadType>(["epic", "task", "bug", "feature", "chore"]);
const ASSOCIATION_SOURCES = new Set<AssociationSource>([
  "creation",
  "selection",
  "launch-descriptor",
  "inherited-lane",
]);
const ROLES = new Set([
  "architect",
  "plan",
  "planner",
  "orchestrator",
  "worker",
  "reviewer",
  "integration",
  "build",
  "investigator",
]);

function nonEmpty(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
    throw new Error(`${name} must be a bounded identifier`);
  return value;
}

function relativeArtifact(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === ".." || !/^[A-Za-z0-9._-]+$/u.test(part))
  )
    throw new Error("report artifact path must be a private relative key");
  return value;
}

function timestamp(value: number | undefined, fallback = Date.now()): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("timestamp must be a safe integer");
  return result;
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    sessionID: row.session_id,
    parentSessionID: row.parent_session_id,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
  };
}

function rowToAction(row: ActionRow): ActionRecord {
  return {
    sessionID: row.session_id,
    actionID: row.action_id,
    observedRole: row.observed_role,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    startReceiptID: row.start_receipt_id,
  };
}

function rowToSlice(row: SliceRow): ActivitySliceRecord {
  return {
    sliceID: row.slice_id,
    actionID: row.action_id,
    sessionID: row.session_id,
    beadID: row.bead_id,
    associationSource: row.association_source,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function readBead(row: Record<string, unknown> | null | undefined): BeadRecord | undefined {
  if (!row) return undefined;
  return {
    beadID: row.bead_id as string,
    type: row.bead_type as BeadType,
    parentBeadID: (row.parent_bead_id as string | null) ?? null,
    validatedAt: row.validated_at as number,
  };
}

/**
 * Private raw-facts store. It intentionally has no report classifier, Hub client, or run ID.
 * Associations are stored as immutable receipts plus the current session snapshot so later
 * policy/reporting work can derive slices without retaining host payloads.
 */
export class TrackerStore {
  private constructor(
    private readonly db: Database,
    readonly options: TrackerOptions,
  ) {}

  static open(options: TrackerOptions): TrackerStore {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    protect(options.dataDir, 0o700);
    const databasePath = join(options.dataDir, DATABASE_FILENAME);
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
      const store = new TrackerStore(db, options);
      protect(databasePath, 0o600);
      protect(join(options.dataDir, `${DATABASE_FILENAME}-wal`), 0o600);
      protect(join(options.dataDir, `${DATABASE_FILENAME}-shm`), 0o600);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best effort: the directory remains private even if a checkpoint is unavailable.
    }
    this.db.close();
  }

  recordSession(input: SessionObservation): SessionRecord {
    const sessionID = nonEmpty(input.sessionID, "sessionID");
    const parentSessionID = input.parentSessionID
      ? nonEmpty(input.parentSessionID, "parentSessionID")
      : undefined;
    const observedAt = timestamp(input.observedAt);
    return this.immediate(() => {
      if (parentSessionID && parentSessionID !== sessionID)
        this.ensureSession(parentSessionID, undefined, observedAt);
      this.ensureSession(sessionID, parentSessionID, observedAt);
      if (input.receipt) this.insertLifecycleReceipt(input.receipt);
      return rowToSession(this.sessionRow(sessionID)!);
    });
  }

  /** Start one host action; the composite session/action key makes retries no-ops. */
  startAction(input: ActionStart): ActionRecord {
    const sessionID = nonEmpty(input.sessionID, "sessionID");
    const actionID = nonEmpty(input.actionID, "actionID");
    const startedAt = timestamp(input.startedAt);
    const observedRole = ROLES.has(input.observedRole ?? "") ? input.observedRole! : "unknown";
    return this.immediate(() => {
      this.ensureSession(sessionID, undefined, startedAt);
      const existing = this.actionRow(sessionID, actionID);
      if (existing) return rowToAction(existing);
      if (input.receiptID) {
        if (
          !this.insertLifecycleReceipt({
            eventID: input.receiptID,
            aggregateID: actionID,
            sequence: 0,
            eventType: "action.started",
            observedAt: startedAt,
          })
        )
          throw new Error("action start receipt already belongs to another observation");
      }
      this.db
        .query(
          "INSERT INTO actions (session_id, action_id, observed_role, started_at, outcome, start_receipt_id) VALUES (?, ?, ?, ?, 'open', ?)",
        )
        .run(sessionID, actionID, observedRole, startedAt, input.receiptID ?? null);
      const attribution = this.db
        .query<{ bead_id: string; source: AssociationSource }>(
          "SELECT bead_id, source FROM session_attributions WHERE session_id = ?",
        )
        .get(sessionID);
      this.db
        .query(
          "INSERT INTO activity_slices (action_id, session_id, bead_id, association_source, started_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          actionID,
          sessionID,
          attribution?.bead_id ?? null,
          attribution?.source ?? null,
          startedAt,
        );
      return rowToAction(this.actionRow(sessionID, actionID)!);
    });
  }

  /** End one action and its current slice in the same transaction as the host receipt. */
  endAction(input: ActionEnd): boolean {
    nonEmpty(input.eventID, "eventID");
    nonEmpty(input.aggregateID, "aggregateID");
    nonEmpty(input.sessionID, "sessionID");
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0)
      throw new Error("sequence must be a safe integer");
    const endedAt = timestamp(input.endedAt);
    return this.immediate(() => {
      const action = input.actionID
        ? this.actionRow(input.sessionID, input.actionID)
        : this.db
            .query<ActionRow>(
              "SELECT * FROM actions WHERE session_id = ? AND outcome = 'open' ORDER BY started_at DESC LIMIT 1",
            )
            .get(input.sessionID);
      if (!action || action.outcome !== "open") return false;
      if (
        !this.insertLifecycleReceipt({ ...input, eventType: "action.ended", observedAt: endedAt })
      )
        return false;
      this.db
        .query(
          "UPDATE actions SET ended_at = ?, outcome = ? WHERE session_id = ? AND action_id = ? AND outcome = 'open'",
        )
        .run(endedAt, input.outcome, action.session_id, action.action_id);
      this.db
        .query(
          "UPDATE activity_slices SET ended_at = ? WHERE session_id = ? AND action_id = ? AND ended_at IS NULL",
        )
        .run(endedAt, action.session_id, action.action_id);
      return true;
    });
  }

  /**
   * Recover only host-identified actions explicitly proven stale by the caller's lifecycle facts.
   * Actions without a recorded start receipt are never recovered by this safety boundary.
   */
  recoverStaleActions(
    actions: readonly Readonly<{ sessionID: string; actionID: string }>[] = [],
    receipt?: Readonly<LifecycleReceipt & { eventType: "session.deleted" }>,
  ): number {
    const identities = actions.map((action) => ({
      sessionID: nonEmpty(action.sessionID, "sessionID"),
      actionID: nonEmpty(action.actionID, "actionID"),
    }));
    if (receipt) {
      nonEmpty(receipt.eventID, "eventID");
      nonEmpty(receipt.aggregateID, "aggregateID");
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0)
        throw new Error("sequence must be a safe integer");
      timestamp(receipt.observedAt);
    }
    if (identities.length === 0 && !receipt) return 0;
    return this.immediate(() => {
      if (receipt && !this.insertLifecycleReceipt(receipt)) return 0;
      let changes = 0;
      for (const identity of identities) {
        changes += this.db
          .query(
            "UPDATE actions SET outcome = 'incomplete', ended_at = NULL WHERE session_id = ? AND action_id = ? AND outcome = 'open' AND start_receipt_id IS NOT NULL",
          )
          .run(identity.sessionID, identity.actionID).changes;
      }
      return changes;
    });
  }

  recordTopology(input: TopologyRecord): BeadRecord {
    const beadID = validateBeadID(input.beadID);
    if (!BEAD_TYPES.has(input.type)) throw new Error("unsupported bead type");
    const parentBeadID =
      input.parentBeadID === undefined ? null : validateBeadID(input.parentBeadID);
    if (parentBeadID && (input.type === "epic" || parentBeadID === beadID))
      throw new Error("invalid bead topology");
    const validatedAt = timestamp(input.validatedAt);
    return this.immediate(() => {
      if (parentBeadID) {
        const parent = readBead(
          this.db.query("SELECT * FROM beads WHERE bead_id = ?").get(parentBeadID),
        );
        if (!parent || parent.type !== "epic") throw new Error("parent topology is not validated");
      }
      const existing = readBead(this.db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID));
      if (existing) {
        if (existing.type !== input.type || existing.parentBeadID !== parentBeadID)
          throw new Error("bead topology conflicts with immutable record");
        return existing;
      }
      this.db
        .query(
          "INSERT INTO beads (bead_id, bead_type, parent_bead_id, validated_at) VALUES (?, ?, ?, ?)",
        )
        .run(beadID, input.type, parentBeadID, validatedAt);
      return readBead(this.db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID))!;
    });
  }

  /** Record a validated association and split all currently open actions at its receipt boundary. */
  recordAssociation(input: AssociationRecord): boolean {
    const receiptID = nonEmpty(input.receiptID, "receiptID");
    const sessionID = nonEmpty(input.sessionID, "sessionID");
    const beadID = validateBeadID(input.beadID);
    if (!ASSOCIATION_SOURCES.has(input.source)) throw new Error("unsupported association source");
    const observedAt = timestamp(input.observedAt);
    return this.immediate(() => {
      if (!this.sessionRow(sessionID)) throw new Error("session is not observed");
      const bead = readBead(this.db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID));
      if (!bead) throw new Error("bead topology is not validated");
      if (
        this.db.query("SELECT 1 FROM closeouts WHERE bead_id = ?").get(beadID) &&
        bead.type !== "epic"
      )
        throw new Error("concrete bead is closed");
      const receipt = this.db
        .query(
          "INSERT OR IGNORE INTO association_receipts (receipt_id, session_id, bead_id, source, observed_at, source_receipt_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(receiptID, sessionID, beadID, input.source, observedAt, input.sourceReceiptID ?? null);
      if (receipt.changes !== 1) return false;
      const current = this.db
        .query<{ bead_id: string; source: AssociationSource }>(
          "SELECT bead_id, source FROM session_attributions WHERE session_id = ?",
        )
        .get(sessionID);
      if (current?.bead_id === beadID && current.source === input.source) return true;
      const actions = this.db
        .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND outcome = 'open'")
        .all(sessionID);
      for (const action of actions) {
        const boundary = Math.max(observedAt, action.started_at);
        this.db
          .query(
            "UPDATE activity_slices SET ended_at = ? WHERE session_id = ? AND action_id = ? AND ended_at IS NULL",
          )
          .run(boundary, sessionID, action.action_id);
        this.db
          .query(
            "INSERT INTO activity_slices (action_id, session_id, bead_id, association_source, started_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(action.action_id, sessionID, beadID, input.source, boundary);
      }
      this.db
        .query(
          "INSERT INTO session_attributions (session_id, bead_id, source, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET bead_id = excluded.bead_id, source = excluded.source, changed_at = excluded.changed_at",
        )
        .run(sessionID, beadID, input.source, observedAt);
      return true;
    });
  }

  recordCloseout(input: CloseoutRecord): CloseoutRecordView {
    const receiptID = nonEmpty(input.receiptID, "receiptID");
    const beadID = validateBeadID(input.beadID);
    const closedAt = timestamp(input.closedAt);
    return this.immediate(() => {
      const bead = readBead(this.db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID));
      if (!bead) throw new Error("bead topology is not validated");
      const existing = this.db
        .query<{
          receipt_id: string;
          bead_id: string;
          closeout_kind: "epic" | "concrete";
          closed_at: number;
        }>("SELECT * FROM closeouts WHERE bead_id = ?")
        .get(beadID);
      if (existing)
        return {
          receiptID: existing.receipt_id,
          beadID: existing.bead_id,
          kind: existing.closeout_kind,
          closedAt: existing.closed_at,
        };
      const kind = bead.type === "epic" ? "epic" : "concrete";
      this.db
        .query(
          "INSERT INTO closeouts (bead_id, receipt_id, closeout_kind, closed_at) VALUES (?, ?, ?, ?)",
        )
        .run(beadID, receiptID, kind, closedAt);
      if (input.sessionID && kind === "concrete") {
        const sessionID = nonEmpty(input.sessionID, "sessionID");
        const current = this.db
          .query<{ bead_id: string }>(
            "SELECT bead_id FROM session_attributions WHERE session_id = ?",
          )
          .get(sessionID);
        if (current?.bead_id === beadID) {
          const actions = this.db
            .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND outcome = 'open'")
            .all(sessionID);
          for (const action of actions) {
            const boundary = Math.max(closedAt, action.started_at);
            this.db
              .query(
                "UPDATE activity_slices SET ended_at = ? WHERE session_id = ? AND action_id = ? AND ended_at IS NULL",
              )
              .run(boundary, sessionID, action.action_id);
            this.db
              .query(
                "INSERT INTO activity_slices (action_id, session_id, bead_id, association_source, started_at) VALUES (?, ?, NULL, NULL, ?)",
              )
              .run(action.action_id, sessionID, boundary);
          }
          this.db.query("DELETE FROM session_attributions WHERE session_id = ?").run(sessionID);
        }
      }
      return { receiptID, beadID, kind, closedAt };
    });
  }

  recordReport(input: ReportMetadata): ReportMetadataRecord {
    const reportID = nonEmpty(input.reportID, "reportID");
    const artifactPath = relativeArtifact(input.artifactPath);
    const selectorFingerprint = nonEmpty(input.selectorFingerprint, "selectorFingerprint");
    const policyVersion = nonEmpty(input.policyVersion, "policyVersion");
    if (!Number.isSafeInteger(input.sourceHighWaterMark) || input.sourceHighWaterMark < 0)
      throw new Error("source high-water mark must be a safe integer");
    const generatedAt = timestamp(input.generatedAt);
    return this.immediate(() => {
      this.db
        .query(
          "INSERT INTO reports (report_id, artifact_path, selector_fingerprint, policy_version, source_high_water_mark, generated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(report_id) DO UPDATE SET artifact_path = excluded.artifact_path, selector_fingerprint = excluded.selector_fingerprint, policy_version = excluded.policy_version, source_high_water_mark = excluded.source_high_water_mark, generated_at = excluded.generated_at",
        )
        .run(
          reportID,
          artifactPath,
          selectorFingerprint,
          policyVersion,
          input.sourceHighWaterMark,
          generatedAt,
        );
      return {
        reportID,
        artifactPath,
        selectorFingerprint,
        policyVersion,
        sourceHighWaterMark: input.sourceHighWaterMark,
        generatedAt,
      };
    });
  }

  listSessions(): SessionRecord[] {
    return this.db
      .query<SessionRow>("SELECT * FROM sessions ORDER BY session_id")
      .all()
      .map(rowToSession);
  }
  listActions(): ActionRecord[] {
    return this.db
      .query<ActionRow>("SELECT * FROM actions ORDER BY session_id, started_at, action_id")
      .all()
      .map(rowToAction);
  }
  listActivitySlices(): ActivitySliceRecord[] {
    return this.db
      .query<SliceRow>("SELECT * FROM activity_slices ORDER BY slice_id")
      .all()
      .map(rowToSlice);
  }
  listBeads(): BeadRecord[] {
    return this.db
      .query("SELECT * FROM beads ORDER BY bead_id")
      .all()
      .map((row) => readBead(row)!)
      .filter(Boolean);
  }
  listAssociationReceipts(): AssociationReceiptRecord[] {
    return this.db
      .query<{
        receipt_id: string;
        session_id: string;
        bead_id: string;
        source: AssociationSource;
        observed_at: number;
        source_receipt_id: string | null;
      }>("SELECT * FROM association_receipts ORDER BY observed_at, receipt_id")
      .all()
      .map((row) => ({
        receiptID: row.receipt_id,
        sessionID: row.session_id,
        beadID: row.bead_id,
        source: row.source,
        observedAt: row.observed_at,
        sourceReceiptID: row.source_receipt_id,
      }));
  }
  listLifecycleReceipts(): LifecycleReceiptRecord[] {
    return this.db
      .query<{
        event_id: string;
        aggregate_id: string;
        sequence: number;
        event_type: string;
        observed_at: number;
      }>("SELECT * FROM lifecycle_receipts ORDER BY event_id")
      .all()
      .map((row) => ({
        eventID: row.event_id,
        aggregateID: row.aggregate_id,
        sequence: row.sequence,
        eventType: row.event_type,
        observedAt: row.observed_at,
      }));
  }
  listCloseouts(): CloseoutRecordView[] {
    return this.db
      .query<{
        receipt_id: string;
        bead_id: string;
        closeout_kind: "epic" | "concrete";
        closed_at: number;
      }>("SELECT * FROM closeouts ORDER BY bead_id")
      .all()
      .map((row) => ({
        receiptID: row.receipt_id,
        beadID: row.bead_id,
        kind: row.closeout_kind,
        closedAt: row.closed_at,
      }));
  }
  listReports(): ReportMetadataRecord[] {
    return this.db
      .query<{
        report_id: string;
        artifact_path: string;
        selector_fingerprint: string;
        policy_version: string;
        source_high_water_mark: number;
        generated_at: number;
      }>("SELECT * FROM reports ORDER BY report_id")
      .all()
      .map((row) => ({
        reportID: row.report_id,
        artifactPath: row.artifact_path,
        selectorFingerprint: row.selector_fingerprint,
        policyVersion: row.policy_version,
        sourceHighWaterMark: row.source_high_water_mark,
        generatedAt: row.generated_at,
      }));
  }

  private sessionRow(sessionID: string): SessionRow | undefined {
    return (
      this.db.query<SessionRow>("SELECT * FROM sessions WHERE session_id = ?").get(sessionID) ??
      undefined
    );
  }
  private actionRow(sessionID: string, actionID: string): ActionRow | undefined {
    return (
      this.db
        .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND action_id = ?")
        .get(sessionID, actionID) ?? undefined
    );
  }
  private ensureSession(
    sessionID: string,
    parentSessionID: string | undefined,
    observedAt: number,
  ): void {
    const existing = this.sessionRow(sessionID);
    if (existing) {
      this.db
        .query(
          "UPDATE sessions SET parent_session_id = COALESCE(parent_session_id, ?), last_observed_at = MAX(last_observed_at, ?) WHERE session_id = ?",
        )
        .run(parentSessionID ?? null, observedAt, sessionID);
      return;
    }
    this.db
      .query(
        "INSERT INTO sessions (session_id, parent_session_id, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionID, parentSessionID ?? null, observedAt, observedAt);
  }
  private insertLifecycleReceipt(input: LifecycleReceipt): boolean {
    const result = this.db
      .query(
        "INSERT OR IGNORE INTO lifecycle_receipts (event_id, aggregate_id, sequence, event_type, observed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.eventID,
        input.aggregateID,
        input.sequence,
        input.eventType,
        timestamp(input.observedAt),
      );
    return result.changes === 1;
  }
  private immediate<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      this.protectDatabaseFiles();
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }
  private protectDatabaseFiles(): void {
    protect(join(this.options.dataDir, DATABASE_FILENAME), 0o600);
    protect(join(this.options.dataDir, `${DATABASE_FILENAME}-wal`), 0o600);
    protect(join(this.options.dataDir, `${DATABASE_FILENAME}-shm`), 0o600);
  }
}

function protect(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Creation and restrictive directory permissions are the required safeguards; chmod is best effort.
  }
}
