import { describe, expect, test } from "bun:test";
import { TrackerStore as FacadeTrackerStore } from "../src/store.js";
import { readBead, rowToAction, rowToSession, rowToSlice } from "../src/tracking/models.js";
import { DATABASE_FILENAME, SCHEMA, SCHEMA_VERSION } from "../src/tracking/schema.js";
import { TrackerStore } from "../src/tracking/store.js";

describe("tracking module boundaries", () => {
  test("row adapters keep persisted values in the public model shape", () => {
    expect(
      rowToSession({
        session_id: "session-1",
        parent_session_id: null,
        project_label: "project",
        next_pass_number: 2,
        first_observed_at: 10,
        last_observed_at: 20,
      }),
    ).toEqual({
      sessionID: "session-1",
      parentSessionID: null,
      projectLabel: "project",
      firstObservedAt: 10,
      lastObservedAt: 20,
    });
    expect(
      rowToAction({
        session_id: "session-1",
        action_id: "action-1",
        pass_number: 1,
        observed_role: "worker",
        phase_key: "implementation",
        phase_label: "Implementation",
        repeat_eligible: 1,
        started_at: 10,
        ended_at: null,
        outcome: "open",
        start_receipt_id: null,
        end_receipt_id: null,
      }),
    ).toMatchObject({ sessionID: "session-1", actionID: "action-1", repeatEligible: true });
    expect(
      rowToSlice({
        slice_id: 1,
        action_id: "action-1",
        session_id: "session-1",
        bead_id: null,
        association_source: null,
        started_at: 10,
        ended_at: 20,
      }),
    ).toEqual({
      sliceID: 1,
      actionID: "action-1",
      sessionID: "session-1",
      beadID: null,
      associationSource: null,
      startedAt: 10,
      endedAt: 20,
    });
    expect(readBead(null)).toBeUndefined();
    expect(
      readBead({
        bead_id: "global-abc1",
        bead_type: "task",
        parent_bead_id: null,
        validated_at: 30,
      }),
    ).toEqual({ beadID: "global-abc1", type: "task", parentBeadID: null, validatedAt: 30 });
  });

  test("schema owns static database facts while the facade preserves the concrete store", () => {
    expect(DATABASE_FILENAME).toBe("tracker-v3.sqlite");
    expect(SCHEMA_VERSION).toBe(1);
    expect(SCHEMA).toContain("CREATE TABLE sessions");
    expect(SCHEMA).toContain("CREATE TABLE reports");
    expect(FacadeTrackerStore).toBe(TrackerStore);
  });
});
