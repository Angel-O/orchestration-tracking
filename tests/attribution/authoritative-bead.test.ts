import { expect, test } from "bun:test";
import { AttributionTransitions, validateAuthoritativeBead } from "../../src/attribution.js";
import { validateAuthoritativeBead as directValidateAuthoritativeBead } from "../../src/attribution/authoritative-bead.js";
import { AttributionTransitions as DirectAttributionTransitions } from "../../src/attribution/transitions.js";

test("keeps the attribution facade mapped to the approved boundaries", () => {
  expect(validateAuthoritativeBead).toBe(directValidateAuthoritativeBead);
  expect(AttributionTransitions).toBe(DirectAttributionTransitions);
});

test("uses bounded argv validation and exact canonical matching", async () => {
  const calls: string[][] = [];
  const bead = await validateAuthoritativeBead("bead-alpha", async (argv) => {
    calls.push([...argv]);
    return JSON.stringify([{ id: "bead-alpha", issue_type: "task", parent: null }]);
  });
  expect(calls).toEqual([["show", "bead-alpha", "--json"]]);
  expect(bead).toEqual({ beadID: "bead-alpha", type: "task" });

  try {
    await validateAuthoritativeBead("bead-alpha", async () =>
      JSON.stringify([
        { id: "bead-alpha", issue_type: "task" },
        { id: "bead-other", issue_type: "task" },
      ]),
    );
    throw new Error("expected validation failure");
  } catch (error) {
    expect((error as Error).message).toBe("authoritative Bead validation failed");
  }
  try {
    await validateAuthoritativeBead("bead-alpha", async () =>
      JSON.stringify([{ id: "bead-alpha", issue_type: "todo" }]),
    );
    throw new Error("expected validation failure");
  } catch (error) {
    expect((error as Error).message).toBe("authoritative Bead validation failed");
  }
  try {
    await validateAuthoritativeBead("bead-alpha", async () => "x".repeat(64 * 1024 + 1));
    throw new Error("expected validation failure");
  } catch (error) {
    expect((error as Error).message).toBe("authoritative Bead validation failed");
  }
});
