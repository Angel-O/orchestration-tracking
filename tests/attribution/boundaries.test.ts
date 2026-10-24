import { expect, test } from "bun:test";
import type { AttributionStore } from "../../src/attribution/transitions.js";
import type { TrackerStore } from "../../src/tracking/store.js";

const capability: AttributionStore = {
  listSessions: () => [],
  listBeads: () => [],
  listCloseouts: () => [],
  recordTopology: () => ({
    beadID: "bead",
    type: "task",
    parentBeadID: null,
    validatedAt: 0,
  }),
  recordAssociation: () => false,
  recordCloseout: () => ({
    receiptID: "receipt",
    beadID: "bead",
    kind: "concrete",
    closedAt: 0,
  }),
};

const acceptsAttributionStore = (store: AttributionStore): AttributionStore => store;
const trackerStoreSatisfiesAttributionStore: (store: TrackerStore) => AttributionStore =
  acceptsAttributionStore;

test("AttributionStore is the exact consumer-owned topology and association surface", () => {
  expect(Object.keys(capability)).toEqual([
    "listSessions",
    "listBeads",
    "listCloseouts",
    "recordTopology",
    "recordAssociation",
    "recordCloseout",
  ]);
  expect(typeof trackerStoreSatisfiesAttributionStore).toBe("function");
});
