import type {
  AssociationRecord,
  BeadRecord,
  CloseoutRecord,
  CloseoutRecordView,
  SessionRecord,
  TopologyRecord,
} from "../tracking/models.js";
import { validateAuthoritativeBead, type ValidatedBead } from "./authoritative-bead.js";

/** Attribution's complete topology and association capability, not a database facade. */
export interface AttributionStore {
  listSessions(): SessionRecord[];
  listBeads(): BeadRecord[];
  listCloseouts(): CloseoutRecordView[];
  recordTopology(input: TopologyRecord): BeadRecord;
  recordAssociation(input: AssociationRecord): boolean;
  recordCloseout(input: CloseoutRecord): CloseoutRecordView;
}

export interface TransitionContext {
  readonly sessionID: string;
  readonly receiptID: string;
  readonly observedAt?: number;
}

export interface TransitionResult {
  readonly ok: boolean;
  readonly changed: boolean;
}

type Validator = (beadID: unknown) => Promise<ValidatedBead>;

function rejected(): TransitionResult {
  return { ok: false, changed: false };
}

function usableContext(context: TransitionContext): boolean {
  return (
    typeof context.sessionID === "string" &&
    context.sessionID.length > 0 &&
    typeof context.receiptID === "string" &&
    context.receiptID.length > 0 &&
    (context.observedAt === undefined ||
      (Number.isSafeInteger(context.observedAt) && context.observedAt >= 0))
  );
}

/**
 * The small mutation surface deliberately owns no Hub state. Every operation
 * validates first, then uses only the foundation store's public methods.
 */
export class AttributionTransitions {
  constructor(
    private readonly store: AttributionStore,
    private readonly validate: Validator = (beadID) => validateAuthoritativeBead(beadID),
  ) {}

  async beadCreated(beadID: unknown, context: TransitionContext): Promise<TransitionResult> {
    try {
      if (!usableContext(context)) return rejected();
      const bead = await this.validate(beadID);
      const existing = await this.registerTopology(bead);
      if (existing) return { ok: true, changed: false };
      const session = this.store
        .listSessions()
        .find((candidate) => candidate.sessionID === context.sessionID);
      if (bead.parentBeadID === undefined && (!session || session.parentSessionID !== null))
        return rejected();

      // Child publication registers immutable topology only. Planner activity
      // remains attributed to the already-selected epic.
      if (bead.parentBeadID !== undefined) return { ok: true, changed: !existing };

      const associated = this.store.recordAssociation({
        receiptID: context.receiptID,
        sessionID: context.sessionID,
        beadID: bead.beadID,
        source: "creation",
        observedAt: context.observedAt,
      });
      return { ok: true, changed: !existing || associated };
    } catch {
      return rejected();
    }
  }

  async beadSelected(beadID: unknown, context: TransitionContext): Promise<TransitionResult> {
    try {
      if (!usableContext(context)) return rejected();
      const bead = await this.validate(beadID);
      if (!this.store.listSessions().some((session) => session.sessionID === context.sessionID))
        return rejected();
      const existing = await this.registerTopology(bead);
      const changed = this.store.recordAssociation({
        receiptID: context.receiptID,
        sessionID: context.sessionID,
        beadID: bead.beadID,
        source: "selection",
        observedAt: context.observedAt,
      });
      return { ok: true, changed: changed || !existing };
    } catch {
      return rejected();
    }
  }

  async closeout(beadID: unknown, context: TransitionContext): Promise<TransitionResult> {
    try {
      if (!usableContext(context)) return rejected();
      const bead = await this.validate(beadID);
      if (!this.store.listSessions().some((session) => session.sessionID === context.sessionID))
        return rejected();
      await this.registerTopology(bead);
      const alreadyClosed = this.store
        .listCloseouts()
        .some((closeout) => closeout.beadID === bead.beadID);
      this.store.recordCloseout({
        receiptID: context.receiptID,
        beadID: bead.beadID,
        sessionID: context.sessionID,
        closedAt: context.observedAt,
      });
      return { ok: true, changed: !alreadyClosed };
    } catch {
      return rejected();
    }
  }

  private async registerTopology(bead: ValidatedBead): Promise<boolean> {
    if (bead.parentBeadID !== undefined) {
      const parent = await this.validate(bead.parentBeadID);
      if (
        parent.beadID !== bead.parentBeadID ||
        parent.type !== "epic" ||
        parent.parentBeadID !== undefined
      )
        throw new Error("authoritative parent topology is invalid");
      this.store.recordTopology({ beadID: parent.beadID, type: parent.type });
    }
    const existing = this.store.listBeads().some((entry) => entry.beadID === bead.beadID);
    this.store.recordTopology({
      beadID: bead.beadID,
      type: bead.type,
      parentBeadID: bead.parentBeadID,
    });
    return existing;
  }
}
