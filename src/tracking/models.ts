export type BeadType = "epic" | "task" | "bug" | "feature" | "chore";
export type ActionOutcome = "open" | "completed" | "failed" | "interrupted" | "incomplete";
export type AssociationSource = "creation" | "selection" | "launch-descriptor" | "inherited-lane";

export interface SessionObservation {
  readonly sessionID: string;
  readonly parentSessionID?: string;
  readonly observedAt?: number;
  /** A privacy-safe label only; source paths are rejected. */
  readonly projectLabel?: string;
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
  readonly projectLabel: string;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export interface ActionRecord {
  readonly sessionID: string;
  readonly actionID: string;
  readonly passNumber: number;
  readonly observedRole: string;
  readonly phaseKey: string;
  readonly phaseLabel: string;
  readonly repeatEligible: boolean;
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

/** One read transaction containing every raw fact used by report generation. */
export interface ReportSnapshot {
  readonly sessions: readonly SessionRecord[];
  readonly actions: readonly ActionRecord[];
  readonly slices: readonly ActivitySliceRecord[];
  readonly beads: readonly BeadRecord[];
  readonly associations: readonly AssociationReceiptRecord[];
  readonly closeouts: readonly CloseoutRecordView[];
  readonly sourceHighWaterMark: number;
}

export interface RetentionCleanupResult {
  readonly slicesPruned: number;
  readonly sessionsPruned: number;
}

export type SessionRow = {
  session_id: string;
  parent_session_id: string | null;
  project_label: string;
  next_pass_number: number;
  first_observed_at: number;
  last_observed_at: number;
};

export type ActionRow = {
  session_id: string;
  action_id: string;
  pass_number: number;
  observed_role: string;
  phase_key: string;
  phase_label: string;
  repeat_eligible: number;
  started_at: number;
  ended_at: number | null;
  outcome: ActionOutcome;
  start_receipt_id: string | null;
  end_receipt_id: string | null;
};

export type SliceRow = {
  slice_id: number;
  action_id: string;
  session_id: string;
  bead_id: string | null;
  association_source: AssociationSource | null;
  started_at: number;
  ended_at: number | null;
};

export function rowToSession(row: SessionRow): SessionRecord {
  return {
    sessionID: row.session_id,
    parentSessionID: row.parent_session_id,
    projectLabel: row.project_label,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
  };
}

export function rowToAction(row: ActionRow): ActionRecord {
  return {
    sessionID: row.session_id,
    actionID: row.action_id,
    passNumber: row.pass_number,
    observedRole: row.observed_role,
    phaseKey: row.phase_key,
    phaseLabel: row.phase_label,
    repeatEligible: row.repeat_eligible === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    startReceiptID: row.start_receipt_id,
  };
}

export function rowToSlice(row: SliceRow): ActivitySliceRecord {
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

export function readBead(row: Record<string, unknown> | null | undefined): BeadRecord | undefined {
  if (!row) return undefined;
  return {
    beadID: row.bead_id as string,
    type: row.bead_type as BeadType,
    parentBeadID: (row.parent_bead_id as string | null) ?? null,
    validatedAt: row.validated_at as number,
  };
}
