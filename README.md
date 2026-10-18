# orchestration-tracking

Standalone OpenCode V2 tracker and reporting package. The package is TypeScript-only and runs
inside Bun using the Promise plugin API exposed by `@opencode/plugin`.

## Supported contract

- OpenCode V2 Promise plugins, baseline `@opencode/plugin` 2.0.16 or newer
  within major version 2.
- Source entrypoint: `src/plugin.ts`, exporting
  `Plugin.define({ id: "orchestration-tracking", setup })`.
- Options use `schemaVersion: 1`, optional absolute `dataDir`, and
  `phaseMappings`. The default directory is
  `~/.local/share/opencode/orchestration-tracker/`.
- Default mappings preserve Coordination & Scoping, Planning,
  Architecture and Decomposition, and Build (Direct). `plan` and `planner`
  remain distinct observed agents while sharing the approved architecture
  phase. `investigator`, `worker`, `reviewer`, and `integration` map to
  Investigation, Implementation, Review, and Integration validation; only the
  built-in `build` agent maps to Build (Direct). Unknown agents snapshot as
  `unmapped`; orchestrator repeat warnings are disabled.

The database is local `bun:sqlite` only. It enables WAL, foreign keys, and a
bounded busy timeout, and applies transactional forward migrations through
`PRAGMA user_version`. The core stores session identities, privacy-safe project
identifiers/labels, pass lifecycle fields, mapping snapshots, and durable
lifecycle receipts. It never stores prompts, responses, transcripts, context
labels, tool payloads, tokens, Git metadata, full filesystem paths, or arbitrary
event payloads.

Telemetry and storage errors are reported as content-free local diagnostics and
are swallowed at the plugin boundary so OpenCode startup and delivery remain
unaffected. The stable tools are `tracking_run_start({ beadID })`,
`tracking_lane_attach({ runID, sessionID })`, `tracking_closeout({ beadID })`,
and read-only `tracking_report({ bead?, sessions?, from?, to? })`. Session and
time selectors intersect; malformed timestamps and unknown sessions fail, and
there is no `allRuns` or multi-run selector.
With no report arguments, the invoking OpenCode session is selected; when it
belongs to a tracked Bead run, that associated run is selected instead.

Runs associate only the invoking root, known parent chains, and explicitly
attached primary sessions. A successful closeout marks stale open passes
`incomplete` without inventing an end time, then atomically regenerates the
private self-contained HTML report. Bead reports always use
`reports/beads/<bead-id>/report.html` and never expose the internal run ID.
Reports retain generation/finalization times, observed-agent totals, phase-
colored session lanes, and individual pass rows while remaining
private-permissioned and free of network assets. Use
`sourceReleasePlan(version)` to prepare an immutable `git archive` release;
publication is deliberately performed by the delivery controller.

## Development

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test tests
```
