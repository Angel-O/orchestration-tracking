import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseOptions } from "../../src/config/options.js";
import { DATABASE_FILENAME, TrackerStore } from "../../src/store.js";
import { readBead, rowToAction, rowToSession, rowToSlice } from "../../src/tracking/models.js";
import { SCHEMA, SCHEMA_VERSION } from "../../src/tracking/schema.js";
import { TrackerStore as DirectTrackerStore } from "../../src/tracking/store.js";

function cleanup(directory: string, store: TrackerStore): void {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

test("creates only the new protected schema and never opens the previous-generation file", () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-schema-"));
  writeFileSync(
    join(directory, "tracker-v2.sqlite"),
    "previous-generation prompt response transcript",
  );
  const store = TrackerStore.open(parseOptions({ dataDir: directory }));
  const databasePath = join(directory, DATABASE_FILENAME);
  expect(existsSync(databasePath)).toBe(true);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  store.close();

  const database = new Database(databasePath, { readonly: true });
  expect(database.query<{ journal_mode: string }>("PRAGMA journal_mode").get()?.journal_mode).toBe(
    "wal",
  );
  expect(database.query("PRAGMA foreign_key_list(actions)").all()).not.toHaveLength(0);
  expect(database.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version).toBe(
    1,
  );
  const tables = database
    .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  expect(tables).toEqual([
    "actions",
    "activity_slices",
    "association_receipts",
    "beads",
    "closeouts",
    "lifecycle_receipts",
    "reports",
    "session_attributions",
    "sessions",
    "sqlite_sequence",
  ]);
  database.close();
  expect(readFileSync(join(directory, "tracker-v2.sqlite"), "utf8")).toContain(
    "previous-generation prompt",
  );
  cleanup(directory, { close: () => undefined } as TrackerStore);
});

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
  expect(DirectTrackerStore).toBe(TrackerStore);
});
