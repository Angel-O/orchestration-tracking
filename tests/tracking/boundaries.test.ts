import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const trackingDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../src/tracking");
const operationModules = [
  "inputs.ts",
  "transaction.ts",
  "lifecycle.ts",
  "associations.ts",
  "retention.ts",
  "report-state.ts",
];

test("tracking operation modules keep the store and policy layers below them", () => {
  for (const file of operationModules) {
    const source = readFileSync(join(trackingDirectory, file), "utf8");
    expect(source).not.toMatch(
      /tracking\/store|from ["']\.\.\/runtime|from ["']\.\.\/attribution|from ["']\.\.\/reporting/u,
    );
  }
});

test("TrackerStore retains only lifetime, public methods, and delegation", () => {
  const source = readFileSync(join(trackingDirectory, "store.ts"), "utf8");
  expect(source).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/u);
  expect(source).not.toContain("BEGIN IMMEDIATE");
  expect(source).toContain("openTrackerDatabase");
  expect(source).toContain("wal_checkpoint");
});
