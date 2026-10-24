import {
  validateAuthoritativeBead,
  type ValidatedBead,
} from "../attribution/authoritative-bead.js";
import type { AttributionStore } from "../attribution/transitions.js";
import { validateBeadID } from "../shared/validation.js";

/** Metadata key used by the host to admit a launch into the first action. */
export const LAUNCH_METADATA_KEY = "orchestration-tracking.launch";

type LaunchDescriptor = {
  readonly version: 1;
  readonly targetSessionID: string;
  readonly beadID: string;
};

export type LaunchSession = {
  readonly id: string;
  readonly metadata?: Record<string, unknown>;
};

/** The host capability required to remove an admitted launch descriptor. */
export interface LaunchSessionAPI {
  readonly update?: (input: {
    readonly sessionID: string;
    readonly metadata: Record<string, unknown>;
  }) => Promise<unknown>;
}

type Diagnose = (message: string, error: unknown) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLaunchDescriptor(value: unknown): LaunchDescriptor {
  if (!isRecord(value)) throw new Error("invalid launch descriptor");
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "version" || key === "targetSessionID" || key === "beadID")
  )
    throw new Error("invalid launch descriptor");
  if (
    value.version !== 1 ||
    typeof value.targetSessionID !== "string" ||
    value.targetSessionID.length === 0 ||
    value.targetSessionID.length > 256
  )
    throw new Error("invalid launch descriptor");
  return {
    version: 1,
    targetSessionID: value.targetSessionID,
    beadID: validateBeadID(value.beadID),
  };
}

/** Admit one exact-session launch descriptor without blocking host delivery. */
export async function consumeLaunchDescriptor(
  sessionAPI: LaunchSessionAPI,
  store: AttributionStore,
  session: LaunchSession,
  observedAt: number,
  diagnose: Diagnose,
): Promise<void> {
  const metadata = session.metadata;
  if (!isRecord(metadata) || !Object.prototype.hasOwnProperty.call(metadata, LAUNCH_METADATA_KEY))
    return;

  let descriptor: LaunchDescriptor;
  try {
    descriptor = parseLaunchDescriptor(metadata[LAUNCH_METADATA_KEY]);
    if (descriptor.targetSessionID !== session.id) throw new Error("launch target mismatch");
    const bead = await validateAuthoritativeBead(descriptor.beadID);
    const topologies: ValidatedBead[] = [];
    if (bead.parentBeadID !== undefined) {
      const parent = await validateAuthoritativeBead(bead.parentBeadID);
      if (parent.type !== "epic" || parent.parentBeadID !== undefined)
        throw new Error("authoritative parent topology is invalid");
      topologies.push(parent);
    }
    topologies.push(bead);
    const localBeads = new Map(store.listBeads().map((localBead) => [localBead.beadID, localBead]));
    for (const topology of topologies) {
      const existing = localBeads.get(topology.beadID);
      if (
        existing &&
        (existing.type !== topology.type ||
          existing.parentBeadID !== (topology.parentBeadID ?? null))
      )
        throw new Error("authoritative validation conflicts with local topology");
    }
    for (const topology of topologies)
      store.recordTopology({ ...topology, validatedAt: observedAt });
    if (
      !store.recordAssociation({
        receiptID: `launch:${session.id}:v1`,
        sessionID: session.id,
        beadID: descriptor.beadID,
        source: "launch-descriptor",
        observedAt,
      })
    )
      return;
  } catch (error) {
    diagnose("launch descriptor ignored; delivery continues", error);
    return;
  }

  try {
    const remaining = { ...metadata };
    delete remaining[LAUNCH_METADATA_KEY];
    if (!sessionAPI.update) throw new Error("session metadata update unavailable");
    await sessionAPI.update({ sessionID: session.id, metadata: remaining });
  } catch (error) {
    diagnose("launch descriptor removal failed; delivery continues", error);
  }
}
