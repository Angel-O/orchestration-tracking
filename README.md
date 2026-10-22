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
