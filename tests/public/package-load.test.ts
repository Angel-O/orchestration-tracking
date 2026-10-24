import { expect, test } from "bun:test";
import * as root from "orchestration-tracking";
import * as plugin from "orchestration-tracking/plugin";

test("loads both supported package entry points", () => {
  expect(root.default).toBe(plugin.default);
  expect(root.TrackerPlugin).toBe(plugin.TrackerPlugin);
  expect(typeof root.TrackerStore).toBe("function");
});
