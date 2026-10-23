import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const reportingDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../src/reporting");

test("pure reporting modules do not acquire effect dependencies", () => {
  for (const file of ["models.ts", "build.ts", "markdown.ts", "html.ts"]) {
    const source = readFileSync(join(reportingDirectory, file), "utf8");
    expect(source).not.toMatch(/from ["']node:/u);
    expect(source).not.toMatch(/TrackerStore/u);
    expect(source).not.toMatch(/(?:readFile|writeFile|mkdir|createServer|spawn)/u);
  }
});

test("effectful reporting modules are isolated to the approved boundaries", () => {
  const artifacts = readFileSync(join(reportingDirectory, "artifacts.ts"), "utf8");
  const viewer = readFileSync(join(reportingDirectory, "viewer.ts"), "utf8");
  expect(artifacts).toContain('from "node:fs"');
  expect(artifacts).toContain("recordReport");
  expect(viewer).toContain('from "node:http"');
  expect(viewer).toContain("createServer");
});
