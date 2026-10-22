import { execFile } from "node:child_process";
import type { TrackerStore, BeadType } from "./store.js";
import { validateBeadID } from "./validation.js";

const MAX_WBD_OUTPUT = 64 * 1024;
const WBD_TIMEOUT_MS = 2_000;
const BEAD_TYPES = new Set<BeadType>(["epic", "task", "bug", "feature", "chore"]);

export interface ValidatedBead {
  readonly beadID: string;
  readonly type: BeadType;
  readonly parentBeadID?: string;
}

export type WbdShowRunner = (argv: readonly string[]) => Promise<string>;

/** The only Hub lookup used by attribution. It never exposes command output. */
export function runWbdShow(argv: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "wbd",
      [...argv],
      { shell: false, timeout: WBD_TIMEOUT_MS, maxBuffer: MAX_WBD_OUTPUT },
      (error, stdout) => {
        if (error || typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_WBD_OUTPUT) {
          reject(new Error("authoritative Bead validation failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("authoritative Bead validation failed");
  return value as Record<string, unknown>;
}

/**
 * Parse exactly one `wbd show` record. The caller supplies no topology: both
 * type and direct parent come from this bounded authoritative response.
 */
export async function validateAuthoritativeBead(
  beadID: unknown,
  run: WbdShowRunner = runWbdShow,
): Promise<ValidatedBead> {
  const canonicalID = validateBeadID(beadID);
  let output: string;
  try {
    output = await run(["show", canonicalID, "--json"]);
  } catch {
    throw new Error("authoritative Bead validation failed");
  }
  if (Buffer.byteLength(output) > MAX_WBD_OUTPUT)
    throw new Error("authoritative Bead validation failed");

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("authoritative Bead validation failed");
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length !== 1) throw new Error("authoritative Bead validation failed");

  const value = record(records[0]);
  if (value.id !== canonicalID || typeof value.issue_type !== "string")
    throw new Error("authoritative Bead validation failed");
  if (!BEAD_TYPES.has(value.issue_type as BeadType))
    throw new Error("authoritative Bead validation failed");

  let parentBeadID: string | undefined;
  if (value.parent !== undefined && value.parent !== null && value.parent !== "") {
    try {
      parentBeadID = validateBeadID(value.parent);
    } catch {
      throw new Error("authoritative Bead validation failed");
    }
    if (parentBeadID === canonicalID || value.issue_type === "epic")
      throw new Error("authoritative Bead validation failed");
  }
  return { beadID: canonicalID, type: value.issue_type as BeadType, parentBeadID };
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
    private readonly store: TrackerStore,
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
