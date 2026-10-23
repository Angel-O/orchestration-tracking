import { execFile } from "node:child_process";
import type { BeadType } from "../store.js";
import { validateBeadID } from "../shared/validation.js";

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
