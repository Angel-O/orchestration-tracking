import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BeadType } from "./store.js";
import { validateBeadID } from "./validation.js";

const execFileAsync = promisify(execFile);
const HUB_TIMEOUT_MS = 5_000;
const HUB_MAX_OUTPUT_BYTES = 256 * 1024;
const BEAD_TYPES = new Set<BeadType>(["epic", "task", "bug", "feature", "chore"]);

export interface AuthoritativeTopology {
  readonly beadID: string;
  readonly type: BeadType;
  readonly parentBeadID?: string;
}

type HubRecord = {
  readonly id?: unknown;
  readonly issue_type?: unknown;
  readonly parent?: unknown;
};

async function show(beadID: string): Promise<HubRecord> {
  const result = await execFileAsync("wbd", ["show", beadID, "--json"], {
    timeout: HUB_TIMEOUT_MS,
    maxBuffer: HUB_MAX_OUTPUT_BYTES,
    windowsHide: true,
    encoding: "utf8",
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("authoritative validation returned invalid data");
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length !== 1 || !records[0] || typeof records[0] !== "object")
    throw new Error("authoritative validation was ambiguous");
  const record = records[0] as HubRecord;
  if (record.id !== beadID) throw new Error("authoritative validation did not match");
  return record;
}

function topology(beadID: string, record: HubRecord): AuthoritativeTopology {
  if (typeof record.issue_type !== "string" || !BEAD_TYPES.has(record.issue_type as BeadType))
    throw new Error("authoritative validation returned unsupported type");
  if (record.parent !== undefined && record.parent !== null && typeof record.parent !== "string")
    throw new Error("authoritative validation returned conflicting topology");
  return {
    beadID,
    type: record.issue_type as BeadType,
    ...(record.parent ? { parentBeadID: validateBeadID(record.parent) } : {}),
  };
}

/** Validate a descriptor bead and its direct epic parent through bounded argv-only Hub calls. */
export async function validateAuthoritativeTopology(
  beadID: string,
): Promise<AuthoritativeTopology[]> {
  const canonicalID = validateBeadID(beadID);
  const bead = topology(canonicalID, await show(canonicalID));
  if (!bead.parentBeadID) return [bead];
  const parent = topology(bead.parentBeadID, await show(bead.parentBeadID));
  if (parent.type !== "epic" || parent.parentBeadID)
    throw new Error("authoritative validation returned conflicting topology");
  return [parent, bead];
}
