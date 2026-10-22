# orchestration-tracking

Standalone OpenCode V2 tracker foundation. The package runs in Bun and keeps
only privacy-safe lifecycle facts in a local private SQLite database.

## Foundation contract

`TrackerStore` opens `tracker-v3.sqlite` below the configured absolute
`dataDir`. This is a clean break from the previous tracker generation: it never
opens, migrates, or imports `tracker-v2.sqlite`. The store creates a fresh schema
with foreign keys, WAL journaling, a five-second busy timeout, a private
directory (`0700`), and a private database (`0600`).

The raw records are:

- `sessions`: opaque session identity, optional parent identity, a privacy-safe
  project label, and observed time bounds;
- `actions`: opaque host action identity, a replay-stable per-session pass
  number, one fixed observed role, captured phase mapping facts, lifecycle
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
keys only. Association policy, report classification, report rendering, Hub
validation, and managed workflow calls remain outside this foundation.

## Fixed local reporting contract

`generateReport(store, selector, generatedAt)` is the report-generation
boundary and writes the private JSON artifact plus a deterministic Markdown
view. `renderReport(report)` is the pure human-readable renderer. Both read
only local facts and apply the fixed
`session-attribution-v1` policy; neither queries Hub, mutates lifecycle state,
nor accepts caller-supplied phase or purpose language. Selectors may choose one
local Bead, sessions, and an optional time range. A Bead selector automatically
produces a standalone, child, or epic initiative report. Epic reports expose
direct metrics and child summaries, not child lanes or action rows.

The JSON view shape is selected by `report.kind`: standalone and child views
include `sessions` and detailed `actions`, while epic views include only
`children`. Epic metrics keep `directActiveMs`, `summedChildActiveMs`, and
`combinedActiveMs` separate; all three are summed active milliseconds, not
elapsed time. Epic `initiativeState` is `not-started`, `open`, or
`closeout-bounded`, and its `elapsed` window is direct-epic activity bounded by
successful epic closeout when observed. The Markdown epic view prints the
first direct-activity boundary and either the successful closeout boundary or
the generation-time boundary while open. Detailed timelines reserve `open` for
genuinely open actions and show incomplete actions with an unknown end.

Reports contain summed active milliseconds, separately calculated elapsed
windows, outcome/session/action counts, fixed phase totals, lifecycle state,
warnings, a privacy notice, and the two required interpretation notices:
concurrent summed active time can exceed elapsed time, and lifecycle values
are observed tracker states rather than authoritative Hub status. Open and
incomplete actions contribute zero active time. The derived JSON and Markdown
artifacts are written below the private data directory with a stable
selector/policy identity and atomic replacement; report metadata records the
raw-fact high-water mark from the same consistent snapshot used to build them.

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

Closed unassigned slices and recovered incomplete unassigned actions older than
30 days are pruned in bounded local transactions. Incomplete actions retain a
NULL end timestamp; their start time supplies the retention boundary. Mixed
sessions retain their associated slices. Cleanup runs at startup and at most
once per day during prompt activity; it never queries Hub.

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

## Deterministic simulations

`tests/simulation.test.ts` is the end-to-end validation seam. It uses fixed
timestamps and injected authoritative validators, so it does not query live
Hub state or depend on a running orchestration environment. The six scenarios
cover:

- standalone creation, explicit resume, switching, concrete closeout, and
  sequential post-closeout creation;
- epic decomposition/publication, inherited and overridden attribution, child
  delivery phases, direct-versus-child metrics, child closeout from an
  epic-associated coordinator, and epic closeout;
- lifecycle/report replay, stable report identity, mixed-session retention, and
  bounded cleanup;
- unchanged-fact regeneration with advancing open detailed and initiative
  windows;
- database/WAL/report/diagnostic privacy scans using distinct category
  sentinels, including a detectable full-path sentinel; and
- injected authoritative-validation, database, descriptor-removal, and
  post-closeout report/render failures that leave the host operation
  non-blocking.

Run the focused simulation and affected source tests with:

```sh
bun test tests/simulation.test.ts tests/foundation.test.ts tests/attribution.test.ts tests/launch-retention.test.ts tests/report.test.ts
```
