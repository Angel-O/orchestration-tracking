/** Shared scalar validation; this module intentionally has no package dependencies. */

/** Bead IDs are path keys, never lossy filesystem names. */
export function validateBeadID(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("bead must be a canonical path-safe ID");
  }
  return value;
}

export function parseTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid timestamp`);
  return parsed;
}
