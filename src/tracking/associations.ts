import { Database } from "bun:sqlite";
import {
  ASSOCIATION_SOURCES,
  BEAD_TYPES,
  boundedIdentifier,
  timestamp,
  validateBeadID,
} from "./inputs.js";
import {
  readBead,
  type ActionRow,
  type AssociationReceiptRecord,
  type AssociationRecord,
  type AssociationSource,
  type BeadRecord,
  type CloseoutRecord,
  type CloseoutRecordView,
  type TopologyRecord,
} from "./models.js";
import { immediate } from "./transaction.js";

/** Immutable topology, attribution receipts, slice boundaries, and closeouts. */

function sessionExists(db: Database, sessionID: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionID));
}

/** Inherit the parent's current attribution while the lifecycle transaction is open. */
export function inheritAttribution(
  db: Database,
  sessionID: string,
  parentSessionID: string,
  observedAt: number,
): void {
  const parent = db
    .query<{ bead_id: string; source: AssociationSource }>(
      "SELECT bead_id, source FROM session_attributions WHERE session_id = ?",
    )
    .get(parentSessionID);
  if (!parent) return;
  const parentReceipt = db
    .query<{ receipt_id: string }>(
      "SELECT receipt_id FROM association_receipts WHERE session_id = ? AND bead_id = ? ORDER BY observed_at DESC, receipt_id DESC LIMIT 1",
    )
    .get(parentSessionID, parent.bead_id);
  const receiptID = `inherit:${sessionID}`;
  db.query(
    "INSERT OR IGNORE INTO association_receipts (receipt_id, session_id, bead_id, source, observed_at, source_receipt_id) VALUES (?, ?, ?, 'inherited-lane', ?, ?)",
  ).run(receiptID, sessionID, parent.bead_id, observedAt, parentReceipt?.receipt_id ?? null);
  db.query(
    "INSERT OR IGNORE INTO session_attributions (session_id, bead_id, source, changed_at) VALUES (?, ?, 'inherited-lane', ?)",
  ).run(sessionID, parent.bead_id, observedAt);
}

function associateSession(
  db: Database,
  sessionID: string,
  beadID: string,
  source: AssociationSource,
  observedAt: number,
  current: { bead_id: string; source: AssociationSource; changed_at: number } | undefined,
  backfill: boolean,
  actions: readonly ActionRow[],
): void {
  if (backfill)
    db.query(
      "UPDATE activity_slices SET bead_id = ?, association_source = ? WHERE session_id = ? AND bead_id IS NULL AND started_at <= ?",
    ).run(beadID, source, sessionID, observedAt);
  for (const action of actions) {
    const currentSlice = db
      .query<{ bead_id: string | null; started_at: number }>(
        "SELECT bead_id, started_at FROM activity_slices WHERE session_id = ? AND action_id = ? AND ended_at IS NULL ORDER BY slice_id DESC LIMIT 1",
      )
      .get(sessionID, action.action_id);
    if (backfill && currentSlice?.bead_id === beadID && currentSlice.started_at <= observedAt)
      continue;
    const boundary = Math.max(observedAt, action.started_at, current?.changed_at ?? 0);
    db.query(
      "UPDATE activity_slices SET ended_at = ? WHERE session_id = ? AND action_id = ? AND ended_at IS NULL",
    ).run(boundary, sessionID, action.action_id);
    db.query(
      "INSERT INTO activity_slices (action_id, session_id, bead_id, association_source, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run(action.action_id, sessionID, beadID, source, boundary);
  }
  db.query(
    "INSERT INTO session_attributions (session_id, bead_id, source, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET bead_id = excluded.bead_id, source = excluded.source, changed_at = MAX(session_attributions.changed_at, excluded.changed_at)",
  ).run(sessionID, beadID, source, observedAt);
}

function associatePreexistingDescendants(
  db: Database,
  rootSessionID: string,
  beadID: string,
  observedAt: number,
  rootReceiptID: string,
): void {
  const descendants = db
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
    const receiptID = db
      .query("SELECT 1 FROM association_receipts WHERE receipt_id = ?")
      .get(inheritedReceiptID)
      ? `inherit:${rootReceiptID}:${descendant.session_id}`
      : inheritedReceiptID;
    db.query(
      "INSERT OR IGNORE INTO association_receipts (receipt_id, session_id, bead_id, source, observed_at, source_receipt_id) VALUES (?, ?, ?, 'inherited-lane', ?, ?)",
    ).run(receiptID, descendant.session_id, beadID, observedAt, sourceReceiptID);
    const actions = db
      .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND outcome = 'open'")
      .all(descendant.session_id);
    associateSession(
      db,
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

export function recordTopology(db: Database, dataDir: string, input: TopologyRecord): BeadRecord {
  const beadID = validateBeadID(input.beadID);
  if (!BEAD_TYPES.has(input.type)) throw new Error("unsupported bead type");
  const parentBeadID = input.parentBeadID === undefined ? null : validateBeadID(input.parentBeadID);
  if (parentBeadID && (input.type === "epic" || parentBeadID === beadID))
    throw new Error("invalid bead topology");
  const validatedAt = timestamp(input.validatedAt);
  return immediate(db, dataDir, () => {
    if (parentBeadID) {
      const parent = readBead(db.query("SELECT * FROM beads WHERE bead_id = ?").get(parentBeadID));
      if (!parent || parent.type !== "epic") throw new Error("parent topology is not validated");
    }
    const existing = readBead(db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID));
    if (existing) {
      if (existing.type !== input.type || existing.parentBeadID !== parentBeadID)
        throw new Error("bead topology conflicts with immutable record");
      return existing;
    }
    db.query(
      "INSERT INTO beads (bead_id, bead_type, parent_bead_id, validated_at) VALUES (?, ?, ?, ?)",
    ).run(beadID, input.type, parentBeadID, validatedAt);
    return readBead(db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID))!;
  });
}

export function recordAssociation(
  db: Database,
  dataDir: string,
  input: AssociationRecord,
): boolean {
  const receiptID = boundedIdentifier(input.receiptID, "receiptID");
  const sessionID = boundedIdentifier(input.sessionID, "sessionID");
  const beadID = validateBeadID(input.beadID);
  if (!ASSOCIATION_SOURCES.has(input.source)) throw new Error("unsupported association source");
  const observedAt = timestamp(input.observedAt);
  return immediate(db, dataDir, () => {
    if (!sessionExists(db, sessionID)) throw new Error("session is not observed");
    const bead = readBead(db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID));
    if (!bead) throw new Error("bead topology is not validated");
    if (db.query("SELECT 1 FROM closeouts WHERE bead_id = ?").get(beadID) && bead.type !== "epic")
      throw new Error("concrete bead is closed");
    if (
      input.source === "launch-descriptor" &&
      db.query("SELECT 1 FROM actions WHERE session_id = ? LIMIT 1").get(sessionID)
    )
      return false;
    const receipt = db
      .query(
        "INSERT OR IGNORE INTO association_receipts (receipt_id, session_id, bead_id, source, observed_at, source_receipt_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(receiptID, sessionID, beadID, input.source, observedAt, input.sourceReceiptID ?? null);
    if (receipt.changes !== 1) return false;
    const current = db
      .query<{ bead_id: string; source: AssociationSource; changed_at: number }>(
        "SELECT bead_id, source, changed_at FROM session_attributions WHERE session_id = ?",
      )
      .get(sessionID);
    if (current?.bead_id === beadID) return false;
    const actions = db
      .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND outcome = 'open'")
      .all(sessionID);
    associateSession(
      db,
      sessionID,
      beadID,
      input.source,
      observedAt,
      current ?? undefined,
      input.source === "creation",
      actions,
    );
    if (input.source === "creation")
      associatePreexistingDescendants(db, sessionID, beadID, observedAt, receiptID);
    return true;
  });
}

export function recordCloseout(
  db: Database,
  dataDir: string,
  input: CloseoutRecord,
): CloseoutRecordView {
  const receiptID = boundedIdentifier(input.receiptID, "receiptID");
  const beadID = validateBeadID(input.beadID);
  const closedAt = timestamp(input.closedAt);
  return immediate(db, dataDir, () => {
    const bead = readBead(db.query("SELECT * FROM beads WHERE bead_id = ?").get(beadID));
    if (!bead) throw new Error("bead topology is not validated");
    const existing = db
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
    db.query(
      "INSERT INTO closeouts (bead_id, receipt_id, closeout_kind, closed_at) VALUES (?, ?, ?, ?)",
    ).run(beadID, receiptID, kind, closedAt);
    if (input.sessionID && kind === "concrete") {
      const sessionID = boundedIdentifier(input.sessionID, "sessionID");
      const current = db
        .query<{ bead_id: string }>("SELECT bead_id FROM session_attributions WHERE session_id = ?")
        .get(sessionID);
      if (current?.bead_id === beadID) {
        const actions = db
          .query<ActionRow>("SELECT * FROM actions WHERE session_id = ? AND outcome = 'open'")
          .all(sessionID);
        for (const action of actions) {
          const boundary = Math.max(closedAt, action.started_at);
          db.query(
            "UPDATE activity_slices SET ended_at = ? WHERE session_id = ? AND action_id = ? AND ended_at IS NULL",
          ).run(boundary, sessionID, action.action_id);
          db.query(
            "INSERT INTO activity_slices (action_id, session_id, bead_id, association_source, started_at) VALUES (?, ?, NULL, NULL, ?)",
          ).run(action.action_id, sessionID, boundary);
        }
        db.query("DELETE FROM session_attributions WHERE session_id = ?").run(sessionID);
      }
    }
    return { receiptID, beadID, kind, closedAt };
  });
}

export function listAssociationReceipts(db: Database): AssociationReceiptRecord[] {
  return db
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

export function listCloseouts(db: Database): CloseoutRecordView[] {
  return db
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
