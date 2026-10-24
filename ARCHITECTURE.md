# Architecture guide

This is the maintainer guide for the current package boundaries. The source
tree and `package.json#exports` are authoritative when this document drifts.
This guide describes contracts and ownership; implementation detail belongs in
the source and tests.

## Package boundary

The package has exactly two supported entry points:

- `orchestration-tracking` maps to [`src/index.ts`](src/index.ts).
- `orchestration-tracking/plugin` maps to [`src/plugin.ts`](src/plugin.ts).

The root facade preserves the current runtime and type exports. The plugin
entry point preserves the default and named `TrackerPlugin` exports plus
`LAUNCH_METADATA_KEY`. [`src/index.ts`](src/index.ts) and
[`src/plugin.ts`](src/plugin.ts) are export facades, not alternate behavior
layers. Internal paths such as [`src/tracking/`](src/tracking/),
[`src/reporting/`](src/reporting/), [`src/attribution/`](src/attribution/), and
[`src/runtime/`](src/runtime/) are unsupported
package paths unless a separate explicit contract adds them. Do not add
directory barrel files or new package exports to make internal imports public.

## Source root and ambient ownership

Only [`src/index.ts`](src/index.ts) and [`src/plugin.ts`](src/plugin.ts) are
direct files under `src/`; they are the two package entry points. Source-owned
ambient declarations live under [`src/types/`](src/types/), and test-only
ambient declarations live under [`tests/types/`](tests/types/). The existing
`src/**/*.ts` and `tests/**/*.ts` include globs discover those declarations, so
do not add `typeRoots`, triple-slash references, imports, barrels, or
dependencies for them.

## Modules and dependency direction

The package remains one TypeScript package with feature directories:

| Area                               | Owns                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`config/`](src/config/)           | option parsing and phase defaults                                                                      |
| [`shared/`](src/shared/)           | genuinely shared scalar validation                                                                     |
| [`tracking/`](src/tracking/)       | SQLite schema, records, transactions, lifecycle, associations, retention, and report-state persistence |
| [`attribution/`](src/attribution/) | authoritative Bead validation and attribution transitions                                              |
| [`reporting/`](src/reporting/)     | report models, pure projections/renderers, artifact persistence, and local viewer delivery             |
| [`runtime/`](src/runtime/)         | host launch admission, tools, lifecycle wiring, and composition                                        |
| [`release/`](src/release/)         | source-release planning                                                                                |

Higher-level consumers depend on lower-level modules. `shared` uses platform
APIs; `config` may use `shared`; `tracking` may use `config`, `shared`, and
platform APIs; `attribution` may use tracking data contracts and shared
validation; reporting models/builders may use tracking data contracts and
shared validation; and `runtime` composes these capabilities. Lower modules do
not import `runtime`. Reporting renderers use report values, not a store.
Effectful reporting code uses its narrow reporting contracts. Export facades
only re-export owning modules.

## Tracking ownership and invariants

[`TrackerStore`](src/tracking/store.ts) is the one concrete public store. It owns database lifetime,
the existing public method surface, and delegation; it does not become a
repository or class-per-table framework. Its operation modules own the
following responsibilities:

- [`models.ts`](src/tracking/models.ts): persisted input/output data contracts and row conversion;
- [`schema.ts`](src/tracking/schema.ts): database bootstrap, schema version, filename, and file
  protection;
- [`inputs.ts`](src/tracking/inputs.ts): bounded store inputs and supported constants;
- [`transaction.ts`](src/tracking/transaction.ts): immediate transaction, rollback/commit, and post-commit
  protection;
- [`lifecycle.ts`](src/tracking/lifecycle.ts): sessions, actions, lifecycle receipts, and stale-action
  recovery;
- [`associations.ts`](src/tracking/associations.ts): topology, association receipts, attribution, and
  closeout behavior;
- [`retention.ts`](src/tracking/retention.ts): bounded cleanup of expired unassigned facts;
- [`report-state.ts`](src/tracking/report-state.ts): projections, report metadata, snapshots, and the source
  high-water mark.

Receipt insertion and its state change stay in one immediate transaction.
Replay-safe writes remain deterministic no-ops or stable replacements. Recovery
requires the host deletion fact and recorded start receipts; opening another
store does not recover actions. The database remains private, report artifact
keys are relative, and the tracker stores only privacy-safe lifecycle facts.
Prompts, responses, transcripts, payloads, tokens, paths, command output, and
arbitrary event data do not enter the store. Existing SQL, schema, ordering,
idempotency, permissions, and transaction boundaries are part of the contract.

## Types and interfaces

Use type aliases for unions, literal sets, callbacks, immutable values, and
shape composition. Existing exported data interfaces remain stable data
contracts; do not mass-convert them for style.

Add an interface only when it describes behavior or a host capability, the
consumer owns it, it is narrower than the implementation, and a demonstrated
external host, test, or multiple-consumer substitution needs it. The approved
capabilities are:

- `AttributionStore` in [`attribution/transitions.ts`](src/attribution/transitions.ts);
- `ReportSnapshotReader` and `ReportArtifactStore` in [`reporting/contracts.ts`](src/reporting/contracts.ts);
- `LaunchSessionAPI` in [`runtime/launch.ts`](src/runtime/launch.ts);
- `ToolRegistrar` in [`runtime/tools.ts`](src/runtime/tools.ts).

`TrackerStore` satisfies the store capabilities structurally. Callbacks remain
function types. Do not add `ITrackerStore`, generic or per-table repositories,
adapters, renderer interfaces, dependency-injection containers, or factories
for a single implementation.

## Test seams and isolation

Tests follow behavior boundaries rather than physical implementation size:

- [`tests/public/`](tests/public/) protects both declared entry points and the complete root
  export surface;
- [`tests/tracking/`](tests/tracking/) uses real temporary SQLite databases for schema, lifecycle,
  attribution, retention, and boundary rules;
- [`tests/attribution/`](tests/attribution/) isolates authoritative validation and transitions;
- [`tests/reporting/`](tests/reporting/) separates pure model/rendering checks, artifact effects,
  and loopback viewer behavior;
- [`tests/runtime/`](tests/runtime/) uses host launch, tool, and lifecycle seams;
- [`tests/integration/simulation.test.ts`](tests/integration/simulation.test.ts) remains deterministic end-to-end
  coverage with injected validation and fixed timestamps;
- [`tests/support/`](tests/support/) contains only shared fixtures such as temporary stores and
  fake `wbd` execution.

Pure builders and renderers receive values and do not access SQLite, Hub,
network, or filesystem APIs. Effectful tests make those boundaries explicit.
No test contacts a live Hub.

## Compatibility and deletion

Preserve both `package.json#exports` entries, every current root runtime/type
export, plugin identity, and observable behavior. Internal physical paths are
not compatibility promises. Move implementation behind the two facades only
when the declared package contract remains unchanged; do not create a
replacement facade solely for an unsupported historical path.

Before deleting a candidate, search source, tests, docs, scripts, and package
exports; classify public, runtime-discovered, ambient/type, or internal use;
confirm neither declared entry point reaches it; and run the applicable checks.
Publicly exported candidates remain by default. Deletion requires direct
reference evidence, export analysis, and passing validation; public API or
behavior removal requires separate approval. Remove one candidate per
reviewable change so rollback stays clear.

## Change checklist

Before review, confirm:

- [ ] The change stays within an owning module and follows the dependency
      direction; no lower module imports runtime.
- [ ] `package.json#exports` remains exactly `.` and `./plugin`, and root
      runtime/type exports and plugin identity remain intact.
- [ ] No unsupported internal path becomes a new package contract, and no
      architecture framework, dependency, generated artifact, repository, or
      factory is added without separate approval.
- [ ] Any new interface is consumer-owned, narrow, and justified by a real
      capability or substitution seam; callbacks and data contracts remain
      simple types where appropriate.
- [ ] Tracking changes preserve immediate transactions, replay behavior,
      privacy, relative artifact keys, schema, permissions, and deterministic
      output.
- [ ] Pure/effectful boundaries and test isolation remain explicit; no test
      contacts a live Hub.
- [ ] Focused tests for the changed boundary pass first, followed by the
      affected validation set. Run `bun run format:check`, `bun run lint`,
      `bun run typecheck`, and the applicable full `bun test tests` check before
      declaring a boundary change complete.
- [ ] This guide and the user-facing README link are updated in the same
      change when a documented boundary changes.
