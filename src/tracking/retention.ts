import { Database } from "bun:sqlite";
import { timestamp } from "./inputs.js";
import type { RetentionCleanupResult } from "./models.js";
import { immediate } from "./transaction.js";

/** Bounded removal of expired unassigned evidence and newly empty lifecycle rows. */
export const UNASSIGNED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RETENTION_CLEANUP_BATCH_SIZE = 1_000;

export function cleanupUnassigned(
  db: Database,
  dataDir: string,
  now = Date.now(),
  limit = RETENTION_CLEANUP_BATCH_SIZE,
): RetentionCleanupResult {
  const cutoff = timestamp(now) - UNASSIGNED_RETENTION_MS;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("cleanup limit must be positive");
  return immediate(db, dataDir, () => {
    const slices = db
      .query<{ slice_id: number }>(
        "SELECT slice_id FROM activity_slices WHERE bead_id IS NULL AND ( (ended_at IS NOT NULL AND ended_at < ?) OR (ended_at IS NULL AND EXISTS (SELECT 1 FROM actions WHERE actions.session_id = activity_slices.session_id AND actions.action_id = activity_slices.action_id AND actions.outcome = 'incomplete' AND actions.started_at < ?)) ) ORDER BY slice_id LIMIT ?",
      )
      .all(cutoff, cutoff, limit);
    for (const slice of slices)
      db.query("DELETE FROM activity_slices WHERE slice_id = ?").run(slice.slice_id);

    const emptyActions = db
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
        if (receiptID) db.query("DELETE FROM lifecycle_receipts WHERE event_id = ?").run(receiptID);
      db.query("DELETE FROM actions WHERE session_id = ? AND action_id = ?").run(
        action.session_id,
        action.action_id,
      );
    }

    const emptySessions = db
      .query<{ session_id: string }>(
        "SELECT session_id FROM sessions WHERE last_observed_at < ? AND NOT EXISTS (SELECT 1 FROM actions WHERE actions.session_id = sessions.session_id) AND NOT EXISTS (SELECT 1 FROM session_attributions WHERE session_attributions.session_id = sessions.session_id) LIMIT ?",
      )
      .all(cutoff, limit);
    for (const session of emptySessions) {
      db.query("DELETE FROM lifecycle_receipts WHERE aggregate_id = ?").run(session.session_id);
      db.query("DELETE FROM sessions WHERE session_id = ?").run(session.session_id);
    }
    return { slicesPruned: slices.length, sessionsPruned: emptySessions.length };
  });
}
