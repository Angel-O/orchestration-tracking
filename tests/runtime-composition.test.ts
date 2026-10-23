import { expect, test } from "bun:test";
import * as facade from "../src/plugin.js";
import * as runtime from "../src/runtime/plugin.js";
import { LAUNCH_METADATA_KEY as runtimeLaunchKey } from "../src/runtime/launch.js";

test("plugin facade preserves runtime identity and launch metadata contract", () => {
  expect(facade.TrackerPlugin).toBe(runtime.TrackerPlugin);
  expect(facade.default).toBe(runtime.default);
  expect(facade.LAUNCH_METADATA_KEY).toBe(runtimeLaunchKey);
  expect(facade.TrackerPlugin.id).toBe("orchestration-tracking");
});
