import { describe, expect, test } from "bun:test";
import { parseTimestamp, validateBeadID } from "../src/shared/validation.js";

describe("shared scalar validation", () => {
  test("accepts canonical Bead IDs and rejects path-like values", () => {
    expect(validateBeadID("example-123")).toBe("example-123");
    expect(() => validateBeadID("../example-123")).toThrow(/bead must be a canonical path-safe ID/);
  });

  test("parses optional timestamps without changing absent values", () => {
    expect(parseTimestamp(undefined, "observedAt")).toBeUndefined();
    expect(parseTimestamp("2026-10-23T00:00:00.000Z", "observedAt")).toBe(
      Date.parse("2026-10-23T00:00:00.000Z"),
    );
    expect(() => parseTimestamp("not-a-timestamp", "observedAt")).toThrow(
      /observedAt must be a valid timestamp/,
    );
  });
});
