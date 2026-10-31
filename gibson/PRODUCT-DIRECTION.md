# Product direction — gibson-todo

The owner's proxy (Gibson `gibson-direct` Mode 2). The planner and builders
answer product questions **from this file** (cite the line) and ask the owner
only when a question is genuinely new — then the answer is recorded here.
Tier C: only the owner changes this file.

## Goal

A small, fast, trustworthy task list for people who live in a terminal. It
should feel like a well-made Unix tool: instant, predictable, scriptable,
and impossible to lose data with.

## Users

- **Primary:** a busy professional who keeps a terminal open all day and wants
  to capture and finish tasks without leaving it.
- **Secondary:** scripts and other tools, via `--json` and stable exit codes.

## Non-goals (out of scope unless the owner says otherwise)

- No accounts, cloud sync, network access or telemetry. Tasks never leave the machine.
- No runtime dependencies. No GUI/TUI frameworks.
- No multi-user collaboration.

## CLI style guide (standing taste rules)

1. **Commands are verbs** (`add`, `done`, `edit`); flags are long-form words
   with optional single-letter shorts (`--all`/`-a`). Common aliases are welcome (`ls`).
2. **Every command supports `--json`**: one JSON document on stdout; errors as
   `{"error":{"code","message","hint"}}` on stderr. JSON field names are camelCase
   and stable — adding fields is fine, renaming is a breaking change.
3. **Text output is calm and scannable**: one line per task,
   `  #3  [ ]  Title`, then a dim summary footer. No emoji. Colour only when
   stdout is a terminal; respect `NO_COLOR`.
4. **Errors say what happened and what to do**: `error: <message>` plus
   `hint: <next step>`. Never print a stack trace for a user mistake.
5. **Exit codes are a contract**: 0 ok · 1 user error · 2 usage · 3 storage · 70 bug.
6. **Help is part of the feature**: every command has a summary, usage line
   and at least one example (`todo help <command>`).
7. **Data safety beats convenience**: never overwrite a file we don't
   understand; writes are atomic; storage changes are additive with migrations.
8. Dates: ISO-8601 in JSON and storage; friendly in text (e.g. `due Fri 14 Nov`,
   `overdue 2d`). Local time zone for display.

## Decisions log (owner, in their words — append only)

- 2026-11-01 — Owner: "Keep it sophisticated but not too complex; it should look
  like a senior architect built it." → layered architecture, zero runtime deps.
- 2026-11-01 — Owner: the repo is public so GitHub enforces merge rules itself.
