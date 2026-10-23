import { Database } from "bun:sqlite";
import { mappingFor, type TrackerOptions } from "../config/options.js";
import { validateBeadID } from "../shared/validation.js";
import {
  readBead,
  rowToAction,
  rowToSession,
  rowToSlice,
  type ActionEnd,
  type ActionRecord,
  type ActionRow,
  type ActionStart,
  type ActivitySliceRecord,
  type AssociationReceiptRecord,
  type AssociationRecord,
  type AssociationSource,
  type BeadRecord,
  type BeadType,
  type CloseoutRecord,
  type CloseoutRecordView,
  type LifecycleReceipt,
  type LifecycleReceiptRecord,
  type ReportMetadata,
  type ReportMetadataRecord,
  type ReportSnapshot,
  type RetentionCleanupResult,
  type SessionObservation,
  type SessionRecord,
  type SessionRow,
  type SliceRow,
  type TopologyRecord,
} from "./models.js";
import { openTrackerDatabase, protectTrackerDatabaseFiles } from "./schema.js";

export { DATABASE_FILENAME } from "./schema.js";
export type {
  ActionEnd,
  ActionOutcome,
  ActionRecord,
  ActionStart,
  ActivitySliceRecord,
  AssociationReceiptRecord,
  AssociationRecord,
  AssociationSource,
  BeadRecord,
  BeadType,
  CloseoutRecord,
  CloseoutRecordView,
  LifecycleReceipt,
  LifecycleReceiptRecord,
  ReportMetadata,
  ReportMetadataRecord,
  ReportSnapshot,
  RetentionCleanupResult,
  SessionObservation,
  SessionRecord,
  TopologyRecord,
} from "./models.js";

export const UNASSIGNED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RETENTION_CLEANUP_BATCH_SIZE = 1_000;

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

function projectLabel(value: string | undefined): string {
  if (value === undefined) return "unknown";
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  )
    throw new Error("project label must be a private label");
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
    return new TrackerStore(openTrackerDatabase(options.dataDir), options);
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
    const label = projectLabel(input.projectLabel);
    return this.immediate(() => {
      if (parentSessionID && parentSessionID !== sessionID)
        this.ensureSession(parentSessionID, undefined, observedAt, label);
      const created = this.ensureSession(sessionID, parentSessionID, observedAt, label);
      if (created && parentSessionID)
        this.inheritAttribution(sessionID, parentSessionID, observedAt);
      if (input.receipt) this.insertLifecycleReceipt(input.receipt, sessionID);
      return rowToSession(this.sessionRow(sessionID)!);
    });
  }

  /** Start one host action; the composite session/action key makes retries no-ops. */
  startAction(input: ActionStart): ActionRecord {
    const sessionID = nonEmpty(input.sessionID, "sessionID");
    const actionID = nonEmpty(input.actionID, "actionID");
    const startedAt = timestamp(input.startedAt);
    const observedRole = ROLES.has(input.observedRole ?? "") ? input.observedRole! : "unknown";
    const mapping = mappingFor(this.options, observedRole);
    return this.immediate(() => {
      this.ensureSession(sessionID, undefined, startedAt);
      const existing = this.actionRow(sessionID, actionID);
      if (existing) return rowToAction(existing);
      const nextPass = this.db
        .query<{ next_pass_number: number }>(
          "SELECT next_pass_number FROM sessions WHERE session_id = ?",
        )
        .get(sessionID)?.next_pass_number;
      if (nextPass === undefined) throw new Error("session observation was not persisted");
      this.db
        .query("UPDATE sessions SET next_pass_number = ? WHERE session_id = ?")
        .run(nextPass + 1, sessionID);
      if (input.receiptID) {
        if (
          !this.insertLifecycleReceipt(
            {
              eventID: input.receiptID,
              aggregateID: actionID,
              sequence: 0,
              eventType: "action.started",
              observedAt: startedAt,
            },
            sessionID,
            actionID,
          )
        )
          throw new Error("action start receipt already belongs to another observation");
      }
      this.db
        .query(
          "INSERT INTO actions (session_id, action_id, pass_number, observed_role, phase_key, phase_label, repeat_eligible, started_at, outcome, start_receipt_id, end_receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)",
        )
        .run(
          sessionID,
          actionID,
          nextPass,
          observedRole,
          mapping.phaseKey,
          mapping.phaseLabel,
          mapping.repeatEligible ? 1 : 0,
          startedAt,
          input.receiptID ?? null,
        );
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
        !this.insertLifecycleReceipt(
          { ...input, eventType: "action.ended", observedAt: endedAt },
          action.session_id,
          action.action_id,
        )
      )
        return false;
      this.db
        .query(
          "UPDATE actions SET ended_at = ?, outcome = ?, end_receipt_id = ? WHERE session_id = ? AND action_id = ? AND outcome = 'open'",
        )
        .run(endedAt, input.outcome, input.eventID, action.session_id, action.action_id);
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
      if (receipt && !this.insertLifecycleReceipt(receipt, receipt.aggregateID)) return 0;
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

  /**
   * Record a validated association and split all currently open actions at its receipt boundary.
   * Creation also backfills the uninterrupted, still-unassigned descendant tree observed before
   * its receipt; later observations continue to use normal parent inheritance.
   */
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
      if (
        input.source === "launch-descriptor" &&
        this.db.query("SELECT 1 FROM actions WHERE session_id = ? LIMIT 1").get(sessionID)
      )
        return false;
      const receipt = this.db
        .query(
          "INSERT OR IGNORE INTO association_receipts (receipt_id, session_id, bead_id, source, observed_at, source_receipt_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(receiptID, sessionID, beadID, input.source, observedAt, input.sourceReceiptID ?? null);
      if (receipt.changes !== 1) return false;
      const current = this.db
        .query<{ bead_id: string; source: AssociationSource; changed_at: number }>(
          "SELECT bead_id, source, changed_at FROM session_attributions WHERE session_id = ?",
        )
        .get(sessionID);
      if (current?.bead_id === beadID) return false;
      const actions = this.db
        .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND outcome = 'open'")
        .all(sessionID);

      this.associateSession(
        sessionID,
        beadID,
        input.source,
        observedAt,
        current ?? undefined,
        input.source === "creation",
        actions,
      );
      if (input.source === "creation")
        this.associatePreexistingDescendants(sessionID, beadID, observedAt, receiptID);
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

  /**
   * Prune expired unassigned slices, including recovered incomplete actions.
   * Incomplete actions age from their start and keep a NULL end timestamp.
   * The bounded transaction leaves associated slices in mixed sessions untouched.
   */
  cleanupUnassigned(
    now = Date.now(),
    limit = RETENTION_CLEANUP_BATCH_SIZE,
  ): RetentionCleanupResult {
    const cutoff = timestamp(now) - UNASSIGNED_RETENTION_MS;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("cleanup limit must be positive");
    return this.immediate(() => {
      const slices = this.db
        .query<{ slice_id: number }>(
          "SELECT slice_id FROM activity_slices WHERE bead_id IS NULL AND ( (ended_at IS NOT NULL AND ended_at < ?) OR (ended_at IS NULL AND EXISTS (SELECT 1 FROM actions WHERE actions.session_id = activity_slices.session_id AND actions.action_id = activity_slices.action_id AND actions.outcome = 'incomplete' AND actions.started_at < ?)) ) ORDER BY slice_id LIMIT ?",
        )
        .all(cutoff, cutoff, limit);
      for (const slice of slices)
        this.db.query("DELETE FROM activity_slices WHERE slice_id = ?").run(slice.slice_id);

      const emptyActions = this.db
        .query<{
          session_id: string;
          action_id: string;
          start_receipt_id: string | null;
          end_receipt_id: string | null;
        }>(
          "SELECT session_id, action_id, start_receipt_id, end_receipt_id FROM actions WHERE started_at < ? AND (ended_at IS NOT NULL OR outcome = 'incomplete') AND NOT EXISTS (SELECT 1 FROM activity_slices WHERE activity_slices.session_id = actions.session_id AND activity_slices.action_id = actions.action_id) LIMIT ?",
        )
        .all(cutoff, limit);
      for (const action of emptyActions) {
        for (const receiptID of [action.start_receipt_id, action.end_receipt_id])
          if (receiptID)
            this.db.query("DELETE FROM lifecycle_receipts WHERE event_id = ?").run(receiptID);
        this.db
          .query("DELETE FROM actions WHERE session_id = ? AND action_id = ?")
          .run(action.session_id, action.action_id);
      }

      const emptySessions = this.db
        .query<{ session_id: string }>(
          "SELECT session_id FROM sessions WHERE last_observed_at < ? AND NOT EXISTS (SELECT 1 FROM actions WHERE actions.session_id = sessions.session_id) AND NOT EXISTS (SELECT 1 FROM session_attributions WHERE session_attributions.session_id = sessions.session_id) LIMIT ?",
        )
        .all(cutoff, limit);
      for (const session of emptySessions) {
        this.db
          .query("DELETE FROM lifecycle_receipts WHERE aggregate_id = ?")
          .run(session.session_id);
        this.db.query("DELETE FROM sessions WHERE session_id = ?").run(session.session_id);
      }
      return { slicesPruned: slices.length, sessionsPruned: emptySessions.length };
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

  readReportSnapshot(): ReportSnapshot {
    return this.db.transaction(() => {
      const sessions = this.listSessions();
      const actions = this.listActions();
      const slices = this.listActivitySlices();
      const beads = this.listBeads();
      const associations = this.listAssociationReceipts();
      const closeouts = this.listCloseouts();
      const timestamps = [
        ...sessions.map((record) => record.lastObservedAt),
        ...actions.flatMap((record) =>
          record.endedAt === null ? [record.startedAt] : [record.startedAt, record.endedAt],
        ),
        ...slices.flatMap((record) =>
          record.endedAt === null ? [record.startedAt] : [record.startedAt, record.endedAt],
        ),
        ...beads.map((record) => record.validatedAt),
        ...associations.map((record) => record.observedAt),
        ...this.listLifecycleReceipts().map((record) => record.observedAt),
        ...closeouts.map((record) => record.closedAt),
      ];
      return {
        sessions,
        actions,
        slices,
        beads,
        associations,
        closeouts,
        sourceHighWaterMark: timestamps.length === 0 ? 0 : Math.max(...timestamps),
      };
    })();
  }

  /** Latest timestamp in raw local facts used by deterministic regeneration. */
  sourceHighWaterMark(): number {
    return this.readReportSnapshot().sourceHighWaterMark;
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
    label = "unknown",
  ): boolean {
    const existing = this.sessionRow(sessionID);
    if (existing) {
      this.db
        .query(
          "UPDATE sessions SET parent_session_id = COALESCE(parent_session_id, ?), last_observed_at = MAX(last_observed_at, ?) WHERE session_id = ?",
        )
        .run(parentSessionID ?? null, observedAt, sessionID);
      return false;
    }
    this.db
      .query(
        "INSERT INTO sessions (session_id, parent_session_id, project_label, next_pass_number, first_observed_at, last_observed_at) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(sessionID, parentSessionID ?? null, label, observedAt, observedAt);
    return true;
  }
  private inheritAttribution(sessionID: string, parentSessionID: string, observedAt: number): void {
    const parent = this.db
      .query<{ bead_id: string; source: AssociationSource }>(
        "SELECT bead_id, source FROM session_attributions WHERE session_id = ?",
      )
      .get(parentSessionID);
    if (!parent) return;
    const parentReceipt = this.db
      .query<{ receipt_id: string }>(
        "SELECT receipt_id FROM association_receipts WHERE session_id = ? AND bead_id = ? ORDER BY observed_at DESC, receipt_id DESC LIMIT 1",
      )
      .get(parentSessionID, parent.bead_id);
    const receiptID = `inherit:${sessionID}`;
    this.db
      .query(
        "INSERT OR IGNORE INTO association_receipts (receipt_id, session_id, bead_id, source, observed_at, source_receipt_id) VALUES (?, ?, ?, 'inherited-lane', ?, ?)",
      )
      .run(receiptID, sessionID, parent.bead_id, observedAt, parentReceipt?.receipt_id ?? null);
    this.db
      .query(
        "INSERT OR IGNORE INTO session_attributions (session_id, bead_id, source, changed_at) VALUES (?, ?, 'inherited-lane', ?)",
      )
      .run(sessionID, parent.bead_id, observedAt);
  }
  private associateSession(
    sessionID: string,
    beadID: string,
    source: AssociationSource,
    observedAt: number,
    current: { bead_id: string; source: AssociationSource; changed_at: number } | undefined,
    backfill: boolean,
    actions: readonly ActionRow[],
  ): void {
    if (backfill)
      this.db
        .query(
          "UPDATE activity_slices SET bead_id = ?, association_source = ? WHERE session_id = ? AND bead_id IS NULL AND started_at <= ?",
        )
        .run(beadID, source, sessionID, observedAt);
    for (const action of actions) {
      const currentSlice = this.db
        .query<{ bead_id: string | null; started_at: number }>(
          "SELECT bead_id, started_at FROM activity_slices WHERE session_id = ? AND action_id = ? AND ended_at IS NULL ORDER BY slice_id DESC LIMIT 1",
        )
        .get(sessionID, action.action_id);
      if (backfill && currentSlice?.bead_id === beadID && currentSlice.started_at <= observedAt)
        continue;
      const boundary = Math.max(observedAt, action.started_at, current?.changed_at ?? 0);
      this.db
        .query(
          "UPDATE activity_slices SET ended_at = ? WHERE session_id = ? AND action_id = ? AND ended_at IS NULL",
        )
        .run(boundary, sessionID, action.action_id);
      this.db
        .query(
          "INSERT INTO activity_slices (action_id, session_id, bead_id, association_source, started_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(action.action_id, sessionID, beadID, source, boundary);
    }
    this.db
      .query(
        "INSERT INTO session_attributions (session_id, bead_id, source, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET bead_id = excluded.bead_id, source = excluded.source, changed_at = MAX(session_attributions.changed_at, excluded.changed_at)",
      )
      .run(sessionID, beadID, source, observedAt);
  }
  private associatePreexistingDescendants(
    rootSessionID: string,
    beadID: string,
    observedAt: number,
    rootReceiptID: string,
  ): void {
    const descendants = this.db
      .query<{
        session_id: string;
        parent_session_id: string;
        depth: number;
      }>(
        `WITH RECURSIVE eligible(session_id, parent_session_id, depth, path) AS (
           SELECT session_id, parent_session_id, 1, '|' || session_id || '|'
           FROM sessions
           WHERE parent_session_id = ?
             AND first_observed_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM session_attributions
               WHERE session_attributions.session_id = sessions.session_id
             )
           UNION ALL
           SELECT child.session_id, child.parent_session_id, eligible.depth + 1,
                  eligible.path || child.session_id || '|'
           FROM sessions AS child
           JOIN eligible ON child.parent_session_id = eligible.session_id
           WHERE child.first_observed_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM session_attributions
               WHERE session_attributions.session_id = child.session_id
             )
             AND instr(eligible.path, '|' || child.session_id || '|') = 0
         )
         SELECT session_id, parent_session_id, depth
         FROM eligible
         ORDER BY depth, session_id`,
      )
      .all(rootSessionID, observedAt, observedAt);
    const receiptBySession = new Map([[rootSessionID, rootReceiptID]]);
    for (const descendant of descendants) {
      const sourceReceiptID = receiptBySession.get(descendant.parent_session_id);
      if (!sourceReceiptID) throw new Error("descendant attribution ancestry is incomplete");
      const inheritedReceiptID = `inherit:${descendant.session_id}`;
      const receiptID = this.db
        .query("SELECT 1 FROM association_receipts WHERE receipt_id = ?")
        .get(inheritedReceiptID)
        ? `inherit:${rootReceiptID}:${descendant.session_id}`
        : inheritedReceiptID;
      this.db
        .query(
          "INSERT OR IGNORE INTO association_receipts (receipt_id, session_id, bead_id, source, observed_at, source_receipt_id) VALUES (?, ?, ?, 'inherited-lane', ?, ?)",
        )
        .run(receiptID, descendant.session_id, beadID, observedAt, sourceReceiptID);
      const actions = this.db
        .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND outcome = 'open'")
        .all(descendant.session_id);
      this.associateSession(
        descendant.session_id,
        beadID,
        "inherited-lane",
        observedAt,
        undefined,
        true,
        actions,
      );
      receiptBySession.set(descendant.session_id, receiptID);
    }
  }
  private insertLifecycleReceipt(
    input: LifecycleReceipt,
    sessionID?: string,
    actionID?: string,
  ): boolean {
    const result = this.db
      .query(
        "INSERT OR IGNORE INTO lifecycle_receipts (event_id, aggregate_id, sequence, event_type, observed_at, session_id, action_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.eventID,
        input.aggregateID,
        input.sequence,
        input.eventType,
        timestamp(input.observedAt),
        sessionID ?? null,
        actionID ?? null,
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
    protectTrackerDatabaseFiles(this.options.dataDir);
  }
}
