import { expect, test } from "bun:test";
import { sourceReleasePlan } from "../../src/index.js";

test("builds a source release plan from a semver-like version", () => {
  expect(sourceReleasePlan("1.2.3-beta.1")).toEqual({
    tag: "v1.2.3-beta.1",
    archive: "orchestration-tracking-1.2.3-beta.1.tar.gz",
    command:
      "git archive --format=tar.gz --prefix=orchestration-tracking-1.2.3-beta.1/ v1.2.3-beta.1 > orchestration-tracking-1.2.3-beta.1.tar.gz",
  });
  expect(() => sourceReleasePlan("latest")).toThrow(/version must be semver-like/);
});
