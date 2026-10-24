import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("architecture guide records the supported boundary contract", () => {
  const guide = readFileSync(join(root, "ARCHITECTURE.md"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");

  for (const heading of [
    "## Package boundary",
    "## Modules and dependency direction",
    "## Tracking ownership and invariants",
    "## Types and interfaces",
    "## Test seams and isolation",
    "## Compatibility and deletion",
    "## Change checklist",
  ]) {
    expect(guide).toContain(heading);
  }
  expect(guide).toContain("`orchestration-tracking` maps to [`src/index.ts`](src/index.ts)");
  expect(guide).toContain(
    "`orchestration-tracking/plugin` maps to [`src/plugin.ts`](src/plugin.ts)",
  );
  expect(guide).toContain("## Source root and ambient ownership");
  expect(existsSync(join(root, "src/types/bun-sqlite.d.ts"))).toBe(true);
  expect(existsSync(join(root, "tests/types/bun-test.d.ts"))).toBe(true);
  expect(existsSync(join(root, "src/bun-sqlite.d.ts"))).toBe(false);
  expect(existsSync(join(root, "src/bun-test.d.ts"))).toBe(false);

  const sqliteAmbient = readFileSync(join(root, "src/types/bun-sqlite.d.ts"), "utf8");
  const testAmbient = readFileSync(join(root, "tests/types/bun-test.d.ts"), "utf8");
  expect(sqliteAmbient).toContain("changes: number;");
  expect(sqliteAmbient).not.toContain("lastInsertRowid");
  expect(testAmbient).toContain("export function test");
  expect(testAmbient).not.toContain("export function describe");
  expect(readme).toContain("[ARCHITECTURE.md](ARCHITECTURE.md)");
  expect(readme).not.toContain("src/hub.ts");
});
