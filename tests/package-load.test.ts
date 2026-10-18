import { describe, expect, test } from "bun:test";
import trackerPlugin, { TrackerPlugin } from "orchestration-tracking";

describe("portable package entrypoint", () => {
  test("loads the V2 plugin from the package root", () => {
    expect(trackerPlugin).toBe(TrackerPlugin);
    expect(trackerPlugin.id).toBe("orchestration-tracking");
    expect(typeof trackerPlugin.setup).toBe("function");
  });
});
