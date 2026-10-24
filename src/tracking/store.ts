import { Database } from "bun:sqlite";
import { type TrackerOptions } from "../config/options.js";
import {
  recordAssociation,
  recordCloseout,
  recordTopology,
  listAssociationReceipts,
  listCloseouts,
} from "./associations.js";
import {
  endAction,
  listLifecycleReceipts,
  recoverStaleActions,
  recordSession,
  startAction,
} from "./lifecycle.js";
import {
  type ActionEnd,
  type ActionRecord,
  type ActionStart,
  type ActivitySliceRecord,
  type AssociationReceiptRecord,
  type AssociationRecord,
  type BeadRecord,
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
  type TopologyRecord,
} from "./models.js";
import {
  cleanupUnassigned,
  RETENTION_CLEANUP_BATCH_SIZE,
  UNASSIGNED_RETENTION_MS,
} from "./retention.js";
import {
  listActions,
  listActivitySlices,
  listBeads,
  listReports,
  listSessions,
  readReportSnapshot,
  recordReport,
  sourceHighWaterMark,
} from "./report-state.js";
import { DATABASE_FILENAME, openTrackerDatabase } from "./schema.js";

export { DATABASE_FILENAME, RETENTION_CLEANUP_BATCH_SIZE, UNASSIGNED_RETENTION_MS };
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

/** The one concrete store: database lifetime, public compatibility, and operation composition. */
export class TrackerStore {
  private constructor(
    private readonly db: Database,
    readonly options: TrackerOptions,
  ) {}

  static open(options: TrackerOptions): TrackerStore {
    return new TrackerStore(openTrackerDatabase(options.dataDir), options);
  }

  /** The configured private artifact directory, exposed for report persistence only. */
  get dataDir(): string {
    return this.options.dataDir;
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
    return recordSession(this.db, this.options.dataDir, input);
  }

  startAction(input: ActionStart): ActionRecord {
    return startAction(this.db, this.options.dataDir, this.options, input);
  }

  endAction(input: ActionEnd): boolean {
    return endAction(this.db, this.options.dataDir, input);
  }

  recoverStaleActions(
    actions: readonly Readonly<{ sessionID: string; actionID: string }>[] = [],
    receipt?: Readonly<LifecycleReceipt & { eventType: "session.deleted" }>,
  ): number {
    return recoverStaleActions(this.db, this.options.dataDir, actions, receipt);
  }

  recordTopology(input: TopologyRecord): BeadRecord {
    return recordTopology(this.db, this.options.dataDir, input);
  }

  recordAssociation(input: AssociationRecord): boolean {
    return recordAssociation(this.db, this.options.dataDir, input);
  }

  recordCloseout(input: CloseoutRecord): CloseoutRecordView {
    return recordCloseout(this.db, this.options.dataDir, input);
  }

  recordReport(input: ReportMetadata): ReportMetadataRecord {
    return recordReport(this.db, this.options.dataDir, input);
  }

  cleanupUnassigned(
    now = Date.now(),
    limit = RETENTION_CLEANUP_BATCH_SIZE,
  ): RetentionCleanupResult {
    return cleanupUnassigned(this.db, this.options.dataDir, now, limit);
  }

  listSessions(): SessionRecord[] {
    return listSessions(this.db);
  }

  listActions(): ActionRecord[] {
    return listActions(this.db);
  }

  listActivitySlices(): ActivitySliceRecord[] {
    return listActivitySlices(this.db);
  }

  listBeads(): BeadRecord[] {
    return listBeads(this.db);
  }

  listAssociationReceipts(): AssociationReceiptRecord[] {
    return listAssociationReceipts(this.db);
  }

  listLifecycleReceipts(): LifecycleReceiptRecord[] {
    return listLifecycleReceipts(this.db);
  }

  listCloseouts(): CloseoutRecordView[] {
    return listCloseouts(this.db);
  }

  listReports(): ReportMetadataRecord[] {
    return listReports(this.db);
  }

  readReportSnapshot(): ReportSnapshot {
    return readReportSnapshot(this.db);
  }

  sourceHighWaterMark(): number {
    return sourceHighWaterMark(this.db);
  }
}
