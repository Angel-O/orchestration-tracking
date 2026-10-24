import { validateBeadID } from "../shared/validation.js";
import type { AssociationSource, BeadType } from "./models.js";

/** Store-bound validation and closed input vocabularies. No persistence belongs here. */

export const BEAD_TYPES = new Set<BeadType>(["epic", "task", "bug", "feature", "chore"]);
export const ASSOCIATION_SOURCES = new Set<AssociationSource>([
  "creation",
  "selection",
  "launch-descriptor",
  "inherited-lane",
]);
export const ROLES = new Set([
  "architect",
  "plan",
  "planner",
  "orchestrator",
  "worker",
  "reviewer",
  "integration",
  "build",
  "investigator",
]);

export function boundedIdentifier(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
    throw new Error(`${name} must be a bounded identifier`);
  return value;
}

export function projectLabel(value: string | undefined): string {
  if (value === undefined) return "unknown";
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  )
    throw new Error("project label must be a private label");
  return value;
}

export function relativeArtifact(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === ".." || !/^[A-Za-z0-9._-]+$/u.test(part))
  )
    throw new Error("report artifact path must be a private relative key");
  return value;
}

export function timestamp(value: number | undefined, fallback = Date.now()): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("timestamp must be a safe integer");
  return result;
}

export function sequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("sequence must be a safe integer");
  return value;
}

export { validateBeadID };
