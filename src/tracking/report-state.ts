import { Database } from "bun:sqlite";
import { boundedIdentifier, relativeArtifact, timestamp } from "./inputs.js";
import {
  readBead,
  rowToAction,
  rowToSession,
  rowToSlice,
  type ActionRecord,
  type ActionRow,
  type ActivitySliceRecord,
  type BeadRecord,
  type ReportMetadata,
  type ReportMetadataRecord,
  type ReportSnapshot,
  type SessionRecord,
  type SessionRow,
  type SliceRow,
} from "./models.js";
import { immediate } from "./transaction.js";
import { listAssociationReceipts, listCloseouts } from "./associations.js";
import { listLifecycleReceipts } from "./lifecycle.js";

/** Read projections, report metadata, consistent snapshots, and source high-water marks. */

export function listSessions(db: Database): SessionRecord[] {
  return db.query<SessionRow>("SELECT * FROM sessions ORDER BY session_id").all().map(rowToSession);
}

export function listActions(db: Database): ActionRecord[] {
  return db
    .query<ActionRow>("SELECT * FROM actions ORDER BY session_id, started_at, action_id")
    .all()
    .map(rowToAction);
}

export function listActivitySlices(db: Database): ActivitySliceRecord[] {
  return db
    .query<SliceRow>("SELECT * FROM activity_slices ORDER BY slice_id")
    .all()
    .map(rowToSlice);
}

export function listBeads(db: Database): BeadRecord[] {
  return db
    .query("SELECT * FROM beads ORDER BY bead_id")
    .all()
    .map((row) => readBead(row)!)
    .filter(Boolean);
}

export function listReports(db: Database): ReportMetadataRecord[] {
  return db
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

export function recordReport(
  db: Database,
  dataDir: string,
  input: ReportMetadata,
): ReportMetadataRecord {
  const reportID = boundedIdentifier(input.reportID, "reportID");
  const artifactPath = relativeArtifact(input.artifactPath);
  const selectorFingerprint = boundedIdentifier(input.selectorFingerprint, "selectorFingerprint");
  const policyVersion = boundedIdentifier(input.policyVersion, "policyVersion");
  if (!Number.isSafeInteger(input.sourceHighWaterMark) || input.sourceHighWaterMark < 0)
    throw new Error("source high-water mark must be a safe integer");
  const generatedAt = timestamp(input.generatedAt);
  return immediate(db, dataDir, () => {
    db.query(
      "INSERT INTO reports (report_id, artifact_path, selector_fingerprint, policy_version, source_high_water_mark, generated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(report_id) DO UPDATE SET artifact_path = excluded.artifact_path, selector_fingerprint = excluded.selector_fingerprint, policy_version = excluded.policy_version, source_high_water_mark = excluded.source_high_water_mark, generated_at = excluded.generated_at",
    ).run(
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

export function readReportSnapshot(db: Database): ReportSnapshot {
  return db.transaction(() => {
    const sessions = listSessions(db);
    const actions = listActions(db);
    const slices = listActivitySlices(db);
    const beads = listBeads(db);
    const associations = listAssociationReceipts(db);
    const closeouts = listCloseouts(db);
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
      ...listLifecycleReceipts(db).map((record) => record.observedAt),
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
export function sourceHighWaterMark(db: Database): number {
  return readReportSnapshot(db).sourceHighWaterMark;
}
