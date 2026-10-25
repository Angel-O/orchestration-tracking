import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { REPORTING_POLICY_VERSION } from "../../src/reporting/models.js";

test("package and reporting policy metadata identify the next minor behavior release", () => {
  const packageJSON = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
  ) as { version?: string };

  expect(packageJSON.version).toBe("0.7.0");
  expect(REPORTING_POLICY_VERSION).toBe("session-attribution-v2");
});
