# orchestration-tracking

Standalone OpenCode V2 tracker core. The package is TypeScript-only and runs
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
unaffected. Run association, reporting, archive publication, closeout, and
dotfiles integration are intentionally not part of this package.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests
```
