# Project Guide

`orchestration-tracking` is a standalone OpenCode V2 tracker and reporting package.
It is written in TypeScript and runs on Bun 1.4.4.

## Layout

- `src/` — package implementation
- `tests/` — Bun test suite

## Commands

```sh
bun install --frozen-lockfile
bun run format
bun run format:check
bun test tests
bun run typecheck
bun run lint
```

Keep changes focused, update tests when behavior changes, and avoid committing generated artifacts.
