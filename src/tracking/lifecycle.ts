import { Database } from "bun:sqlite";
import { mappingFor, type TrackerOptions } from "../config/options.js";
import { inheritAttribution } from "./associations.js";
import { boundedIdentifier, projectLabel, ROLES, sequence, timestamp } from "./inputs.js";
import {
  rowToAction,
  rowToSession,
  type ActionEnd,
  type ActionRecord,
  type ActionRow,
  type ActionStart,
  type LifecycleReceipt,
  type LifecycleReceiptRecord,
  type SessionObservation,
  type SessionRecord,
  type SessionRow,
} from "./models.js";
import { immediate } from "./transaction.js";

/** Session, action, receipt, and stale-action persistence. */

function sessionRow(db: Database, sessionID: string): SessionRow | undefined {
  return (
    db.query<SessionRow>("SELECT * FROM sessions WHERE session_id = ?").get(sessionID) ?? undefined
  );
}

function actionRow(db: Database, sessionID: string, actionID: string): ActionRow | undefined {
  return (
    db
      .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND action_id = ?")
      .get(sessionID, actionID) ?? undefined
  );
}

function ensureSession(
  db: Database,
  sessionID: string,
  parentSessionID: string | undefined,
  observedAt: number,
  label = "unknown",
): boolean {
  const existing = sessionRow(db, sessionID);
  if (existing) {
    db.query(
      "UPDATE sessions SET parent_session_id = COALESCE(parent_session_id, ?), last_observed_at = MAX(last_observed_at, ?) WHERE session_id = ?",
    ).run(parentSessionID ?? null, observedAt, sessionID);
    return false;
  }
  db.query(
    "INSERT INTO sessions (session_id, parent_session_id, project_label, next_pass_number, first_observed_at, last_observed_at) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(sessionID, parentSessionID ?? null, label, observedAt, observedAt);
  return true;
}

/** Shared receipt insert used by lifecycle operations inside their current transaction. */
export function insertLifecycleReceipt(
  db: Database,
  input: LifecycleReceipt,
  sessionID?: string,
  actionID?: string,
): boolean {
  const result = db
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

export function recordSession(
  db: Database,
  dataDir: string,
  input: SessionObservation,
): SessionRecord {
  const sessionID = boundedIdentifier(input.sessionID, "sessionID");
  const parentSessionID = input.parentSessionID
    ? boundedIdentifier(input.parentSessionID, "parentSessionID")
    : undefined;
  const observedAt = timestamp(input.observedAt);
  const label = projectLabel(input.projectLabel);
  return immediate(db, dataDir, () => {
    if (parentSessionID && parentSessionID !== sessionID)
      ensureSession(db, parentSessionID, undefined, observedAt, label);
    const created = ensureSession(db, sessionID, parentSessionID, observedAt, label);
    if (created && parentSessionID) inheritAttribution(db, sessionID, parentSessionID, observedAt);
    if (input.receipt) insertLifecycleReceipt(db, input.receipt, sessionID);
    return rowToSession(sessionRow(db, sessionID)!);
  });
}

/** Start one host action; the composite session/action key makes retries no-ops. */
export function startAction(
  db: Database,
  dataDir: string,
  options: TrackerOptions,
  input: ActionStart,
): ActionRecord {
  const sessionID = boundedIdentifier(input.sessionID, "sessionID");
  const actionID = boundedIdentifier(input.actionID, "actionID");
  const startedAt = timestamp(input.startedAt);
  const observedRole = ROLES.has(input.observedRole ?? "") ? input.observedRole! : "unknown";
  const mapping = mappingFor(options, observedRole);
  return immediate(db, dataDir, () => {
    ensureSession(db, sessionID, undefined, startedAt);
    const existing = actionRow(db, sessionID, actionID);
    if (existing) return rowToAction(existing);
    const nextPass = db
      .query<{ next_pass_number: number }>(
        "SELECT next_pass_number FROM sessions WHERE session_id = ?",
      )
      .get(sessionID)?.next_pass_number;
    if (nextPass === undefined) throw new Error("session observation was not persisted");
    db.query("UPDATE sessions SET next_pass_number = ? WHERE session_id = ?").run(
      nextPass + 1,
      sessionID,
    );
    if (input.receiptID) {
      if (
        !insertLifecycleReceipt(
          db,
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
    db.query(
      "INSERT INTO actions (session_id, action_id, pass_number, observed_role, phase_key, phase_label, repeat_eligible, started_at, outcome, start_receipt_id, end_receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)",
    ).run(
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
    const attribution = db
      .query<{
        bead_id: string;
        source: "creation" | "selection" | "launch-descriptor" | "inherited-lane";
      }>("SELECT bead_id, source FROM session_attributions WHERE session_id = ?")
      .get(sessionID);
    db.query(
      "INSERT INTO activity_slices (action_id, session_id, bead_id, association_source, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      actionID,
      sessionID,
      attribution?.bead_id ?? null,
      attribution?.source ?? null,
      startedAt,
    );
    return rowToAction(actionRow(db, sessionID, actionID)!);
  });
}

/** End one action and its current slice in the same transaction as the host receipt. */
export function endAction(db: Database, dataDir: string, input: ActionEnd): boolean {
  boundedIdentifier(input.eventID, "eventID");
  boundedIdentifier(input.aggregateID, "aggregateID");
  boundedIdentifier(input.sessionID, "sessionID");
  sequence(input.sequence);
  const endedAt = timestamp(input.endedAt);
  return immediate(db, dataDir, () => {
    const action = input.actionID
      ? actionRow(db, input.sessionID, input.actionID)
      : db
          .query<ActionRow>(
            "SELECT * FROM actions WHERE session_id = ? AND outcome = 'open' ORDER BY started_at DESC LIMIT 1",
          )
          .get(input.sessionID);
    if (!action || action.outcome !== "open") return false;
    if (
      !insertLifecycleReceipt(
        db,
        { ...input, eventType: "action.ended", observedAt: endedAt },
        action.session_id,
        action.action_id,
      )
    )
      return false;
    db.query(
      "UPDATE actions SET ended_at = ?, outcome = ?, end_receipt_id = ? WHERE session_id = ? AND action_id = ? AND outcome = 'open'",
    ).run(endedAt, input.outcome, input.eventID, action.session_id, action.action_id);
    db.query(
      "UPDATE activity_slices SET ended_at = ? WHERE session_id = ? AND action_id = ? AND ended_at IS NULL",
    ).run(endedAt, action.session_id, action.action_id);
    return true;
  });
}

/** Recover only host-identified actions explicitly proven stale by lifecycle facts. */
export function recoverStaleActions(
  db: Database,
  dataDir: string,
  actions: readonly Readonly<{ sessionID: string; actionID: string }>[] = [],
  receipt?: Readonly<LifecycleReceipt & { eventType: "session.deleted" }>,
): number {
  const identities = actions.map((action) => ({
    sessionID: boundedIdentifier(action.sessionID, "sessionID"),
    actionID: boundedIdentifier(action.actionID, "actionID"),
  }));
  if (receipt) {
    boundedIdentifier(receipt.eventID, "eventID");
    boundedIdentifier(receipt.aggregateID, "aggregateID");
    sequence(receipt.sequence);
    timestamp(receipt.observedAt);
  }
  if (identities.length === 0 && !receipt) return 0;
  return immediate(db, dataDir, () => {
    if (receipt && !insertLifecycleReceipt(db, receipt, receipt.aggregateID)) return 0;
    let changes = 0;
    for (const identity of identities) {
      changes += db
        .query(
          "UPDATE actions SET outcome = 'incomplete', ended_at = NULL WHERE session_id = ? AND action_id = ? AND outcome = 'open' AND start_receipt_id IS NOT NULL",
        )
        .run(identity.sessionID, identity.actionID).changes;
    }
    return changes;
  });
}

export function listLifecycleReceipts(db: Database): LifecycleReceiptRecord[] {
  return db
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
