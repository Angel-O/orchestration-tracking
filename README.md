# orchestration-tracking

Standalone OpenCode V2 tracker foundation. The package runs in Bun and keeps
only privacy-safe lifecycle facts in a local private SQLite database.

## Foundation contract

`TrackerStore` opens `tracker-v2.sqlite` below the configured absolute
`dataDir`. This is a clean break from the previous tracker file: it never
opens, migrates, or imports `tracker.sqlite`. The store creates a fresh schema
with foreign keys, WAL journaling, a five-second busy timeout, a private
directory (`0700`), and a private database (`0600`).

The raw records are:

- `sessions`: opaque session identity, optional parent identity, and observed
  time bounds;
- `actions`: opaque host action identity, one fixed observed role, lifecycle
  outcome, and authoritative start/end times;
- `activity_slices`: action portions split at association boundaries;
- `beads`: validated canonical ID, type, and immutable direct epic parent;
- `association_receipts`: validated association boundary facts;
- `lifecycle_receipts`: replay-safe host event identities and sequence facts;
- `closeouts`: first successful concrete or epic closeout;
- `reports`: stable relative artifact metadata and a raw-fact high-water mark.

`TrackerStore.recordSession`, `startAction`, `endAction`, `recordTopology`,
`recordAssociation`, `recordCloseout`, and `recordReport` are the internal
boundary used by later tracker children. Receipt insertion and its state
change run in one immediate transaction. Replayed session/action/receipt,
topology, closeout, and report writes are deterministic no-ops or stable
replacements. Explicit recovery accepts only host-identified stale actions
with recorded start receipts, atomically records the bounded `session.deleted`
receipt, changes them to `incomplete`, and keeps their end time `NULL`; opening
another store instance never performs recovery.

The store accepts no prompts, responses, transcripts, context labels, tool
payloads, tokens, Git metadata, filesystem paths, command output, titles,
descriptions, or arbitrary event payloads. Report artifact paths are relative
keys only. Association policy, phase classification, report rendering, Hub
validation, and managed workflow calls remain outside this foundation.

## Attribution transitions

The tracker exposes three mutation tools: `tracking_bead_created`,
`tracking_bead_select`, and `tracking_closeout`. Each accepts only `{ beadID }`;
the tracker runs `wbd show <beadID> --json` with argv arguments, a short timeout,
and bounded output, then requires exactly one record whose canonical `id`
matches. Bead type and direct epic parent are derived from that record, never
from tool input. Unsupported, ambiguous, unavailable, or conflicting records
produce content-free non-blocking failure results.

Creation registers immutable topology. A parentless Bead associates the
invoking root and may reclassify only that root's preceding unassigned slices
as scoping. A published child registers its validated parent without changing
the publishing epic attribution or creating child activity. Explicit selection
starts at the tool receipt boundary and never revises earlier slices; selecting
the active Bead and replaying a receipt are no-ops. Closeout records the first
validated concrete or epic closeout. Concrete closeout resets only the invoking
session when it is currently associated with that exact Bead; epic closeout
does not alter child workstreams.

## Launch and retention contract

The plugin checks the exact-session metadata key
`orchestration-tracking.launch` immediately before the first action. A valid
descriptor has exactly this shape:

```json
{
  "version": 1,
  "targetSessionID": "<exact-session-id>",
  "beadID": "<canonical-bead-id>"
}
```

The target must match the fetched session. The tracker validates the exact
canonical Bead through the bounded argv-based authoritative Hub boundary and
registers its immutable topology locally before admission. Only an admitted
descriptor associates the first action and removes that one metadata key;
malformed, inherited, mismatched, unavailable, or conflicting descriptors
leave recording unassigned and non-blocking. A child session snapshots its
parent's current attribution once when the child is first observed. Later
parent changes do not rewrite the child, while an explicit association can
override it.

Closed unassigned slices older than 30 days are pruned in bounded local
transactions. Mixed sessions retain their associated slices. Cleanup runs at
startup and at most once per day during prompt activity; it never queries Hub.

The plugin observes `session.created`, prompt action starts, session deletion,
and terminal session execution events. A deletion event is the host lifecycle
fact that permits recovery of that session's receipt-backed open actions;
opening another store instance does not recover anything. Observation
failures are content-free diagnostics and do not block OpenCode delivery.

## Development

```sh
bun install --frozen-lockfile
bun run format
bun run format:check
bun run lint
bun run typecheck
bun test tests/foundation.test.ts
```
