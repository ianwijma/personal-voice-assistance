# Clock (`clock`)

The local date and time in every turn's context, and the time elsewhere.

- Package: `packages/modules-builtin`: `src/clock.ts`, and new files only under `src/clock/`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 3 (wave A); extended by the core-tools pull request (the extended `current_time`)
- Research: [docs/research/modules/core-tools.md](../research/modules/core-tools.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

An existing module. The core-tools pull request extends it in `src/clock.ts` and in new files only under
`src/clock/` (exported from `clock.ts`; never other files of `modules-builtin`), and fills in this page
(docs/MODULES.md, "What a module pull request may touch").

## What it does

To be written.

## Tools

To be written: each tool and action, its parameters, its risk class, and what it answers (its `spoken` line).

## Settings

To be written.

## What it stores

To be written: each collection, its scope, its `maxChars` and indexes, and how long rows stay.

## What it needs

To be written: `requires`, `uses`, the services and contributions it provides or consumes, outside services.

## What was left out

To be written. In wave A this lists, among the rest, every part of the plan's row that needs a phrase command, a
presentation, a notification or a module's own speech (P7, P9, P10): those do not exist yet and come with wave B.
