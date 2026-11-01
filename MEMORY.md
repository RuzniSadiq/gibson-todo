# MEMORY.md — shared agent memory

**Read this early** in any coding, review, or merge session.
**Update it** when the same failure class appears twice (prefer a test/sensor over a long essay).

### Dual-write rule (mandatory)

Whenever an agent writes durable operational memory in a local runtime store,
**also write here** so other agents and machines share the same context.

### No CI loop for memory-only updates

Commits that touch **only** this file (or `memory/**`) skip the product green
gate and the review gate. They still land via a PR (main is protected); the
sensors pass memory-only PRs automatically.

Canonical convention: The Gibson `docs/24-agent-memory-conventions.md`.

_Last updated: 2026-11-01_

---

## Operating notes

| Topic | Rule |
|-------|------|
| Claims | `agent-claimed` label + `- Active-work claim:` line in the draft PR body |
| Green gate | `npm run gate` (see `AGENTS.md` / `.agents/gate.json`) |
| Sensor tagging | Each criterion `AC-<issue>.<n>` needs a passing test named `[AC-<issue>.<n>] …` |
| Deploy | merge to `main` ⇒ release rebuilt at `~/.gibson/gibson-todo/release` + smoke test |
| Kill switch | `bin/gibson halt` (file `~/.gibson/gibson-todo/HALT`) or `GIBSON_HALT=1` |

---

## Lessons (append-only)

### How to add a lesson

1. Branch from the latest `origin/main` in your own worktree.
2. Append a new dated section at the **bottom** — do not rewrite history.
3. Commit **only** memory files; open a PR labelled `memory-only`.
4. Never put secrets, tokens, or connection strings here.

```markdown
## YYYY-MM-DD — <short-slug>

- **What happened:** …
- **Root cause:** …
- **Fix / rule:** …
- **Links:** issue/PR if any
```

---

## 2026-11-01 — adoption-seed

- Repo adopted Gibson agent-memory conventions (AGENTS.md memory block + this file).
- Pure memory commits skip the product green gate; dual-write is mandatory.

## 2026-11-01 — skipped-required-checks-pass

- **What happened:** While wiring CI, a draft design skipped the `gate` job on
  `labeled` events. GitHub treats a *skipped* required check as passing, so a
  later label change could have masked an earlier gate failure on the same head.
- **Fix / rule:** Required-check jobs never skip on a non-draft PR. Checks that
  must re-run on label changes (`tier-drift`) live in their own workflow.
- **Links:** issue #1, PR #2

## 2026-11-01 — nested-node-test-context

- **What happened:** The contract sensor reported "no test carries the tag" for
  tests that existed and passed — but only when the harness itself ran under
  `node --test` (the pipeline end-to-end test).
- **Root cause:** `node --test` sets `NODE_TEST_CONTEXT` for its children; a nested
  `node --test` that inherits it emits the runner's internal protocol, not TAP.
- **Fix / rule:** Sensors that spawn `node --test` drop `NODE_TEST_CONTEXT`
  (`exec.run` treats an `undefined` env value as "unset"). Covered by
  `scripts/tests/pipeline-e2e.test.mjs`.
- **Links:** issue #1, PR #2

## 2026-11-01 — review-caught-lock-and-evidence

- **What happened:** Green gate, 51 passing tests — and the cross-vendor FAN-OUT
  review (Codex) still found 4 blockers: a stale-lock race that could delete a
  live lock, review evidence trusting a typed `Reviewer-Vendor:` field, and two
  criteria whose tests did not really exercise them.
- **Fix / rule:** Locks are broken only when the holder process is dead, by one
  serialized breaker that re-verifies the token; release is ownership-checked.
  Evidence counts only comments posted by `reviewEvidence.reviewerLogins`.
  A criterion's tagged test must exercise the criterion as written (real store,
  real pipeline), not a convenient stand-in.
- **Links:** issue #1, PR #2 (review round 1)

## 2026-10-31 — review-caught-5

- **What happened:** Green gate passed on #5 ("Add optional dueDate to the task store (schema v2 + migration)") but the cross-vendor reviewer requested changes (3 round(s)). First finding: - `src/domain/task.ts:44` — kind: blocker; class: edge-case; trigger: `isCalendarDate("2026-11-14\n")` ⇒ returns `true`, despite the required exact `YYYY-MM-DD` format and the domain test expecting `false`. Use an end assertion that cannot 
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — review-caught-5

- **What happened:** Green gate passed on #5 ("Add optional dueDate to the task store (schema v2 + migration)") but the cross-vendor reviewer requested changes (4 round(s)). First finding: - `src/domain/task.ts:44` — kind: blocker; class: edge-case; trigger: `isCalendarDate("2026-11-14\n")` ⇒ returns `true`, despite the required exact `YYYY-MM-DD` format and the domain test expecting `false`. Use an end assertion that cannot 
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — ci-diverged-5

- **What happened:** Local gate was green on #5 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — review-caught-5

- **What happened:** Green gate passed on #5 ("Add optional dueDate to the task store (schema v2 + migration)") but the cross-vendor reviewer requested changes (5 round(s)). First finding: - `src/domain/task.ts:44` — kind: blocker; class: edge-case; trigger: `isCalendarDate("2026-11-14\n")` ⇒ returns `true`, despite the required exact `YYYY-MM-DD` format and the domain test expecting `false`. Use an end assertion that cannot 
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — ci-diverged-5

- **What happened:** Local gate was green on #5 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — review-caught-5

- **What happened:** Green gate passed on #5 ("Add optional dueDate to the task store (schema v2 + migration)") but the cross-vendor reviewer requested changes (6 round(s)). First finding: - `src/domain/task.ts:44` — kind: blocker; class: edge-case; trigger: `isCalendarDate("2026-11-14\n")` ⇒ returns `true`, despite the required exact `YYYY-MM-DD` format and the domain test expecting `false`. Use an end assertion that cannot 
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — ci-diverged-5

- **What happened:** Local gate was green on #5 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — review-caught-5

- **What happened:** Green gate passed on #5 ("Add optional dueDate to the task store (schema v2 + migration)") but the cross-vendor reviewer requested changes (6 round(s)). First finding: - `src/domain/task.ts:44` — kind: blocker; class: edge-case; trigger: `isCalendarDate("2026-11-14\n")` ⇒ returns `true`, despite the required exact `YYYY-MM-DD` format and the domain test expecting `false`. Use an end assertion that cannot 
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — ci-diverged-5

- **What happened:** Local gate was green on #5 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — review-caught-5

- **What happened:** Green gate passed on #5 ("Add optional dueDate to the task store (schema v2 + migration)") but the cross-vendor reviewer requested changes (6 round(s)). First finding: - `src/domain/task.ts:44` — kind: blocker; class: edge-case; trigger: `isCalendarDate("2026-11-14\n")` ⇒ returns `true`, despite the required exact `YYYY-MM-DD` format and the domain test expecting `false`. Use an end assertion that cannot 
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — ci-diverged-5

- **What happened:** Local gate was green on #5 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — review-caught-5

- **What happened:** Green gate passed on #5 ("Add optional dueDate to the task store (schema v2 + migration)") but the cross-vendor reviewer requested changes (6 round(s)). First finding: - `src/domain/task.ts:44` — kind: blocker; class: edge-case; trigger: `isCalendarDate("2026-11-14\n")` ⇒ returns `true`, despite the required exact `YYYY-MM-DD` format and the domain test expecting `false`. Use an end assertion that cannot 
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-10-31 — ci-diverged-5

- **What happened:** Local gate was green on #5 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #8 · run `20261031-193635-let-me-give-a-task-a-due-date`

## 2026-11-01 — review-caught-28

- **What happened:** Green gate passed on #28 ("Render `todo list` rows as aligned columns, title last") but the cross-vendor reviewer requested changes (2 round(s)). First finding: - [test/cli/list-columns.test.ts](/Users/gapstars/.gibson/gibson-todo/worktrees/issue-28/test/cli/list-columns.test.ts:195) — kind: blocker; class: test-gap; trigger: `todo list --priority urgent` ⇒ the tagged test expects exit 1, so it doe
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #31 · run `20261101-092245-make-todo-list-easy-to-scan-sh`

## 2026-11-01 — ci-diverged-28

- **What happened:** Local gate was green on #28 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #31 · run `20261101-092245-make-todo-list-easy-to-scan-sh`

## 2026-11-01 — review-caught-28

- **What happened:** Green gate passed on #28 ("Render `todo list` rows as aligned columns, title last") but the cross-vendor reviewer requested changes (3 round(s)). First finding: - [test/cli/list-columns.test.ts](/Users/gapstars/.gibson/gibson-todo/worktrees/issue-28/test/cli/list-columns.test.ts:195) — kind: blocker; class: test-gap; trigger: `todo list --priority urgent` ⇒ the tagged test expects exit 1, so it doe
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #31 · run `20261101-092245-make-todo-list-easy-to-scan-sh`

## 2026-11-01 — ci-diverged-28

- **What happened:** Local gate was green on #28 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #31 · run `20261101-092245-make-todo-list-easy-to-scan-sh`

## 2026-11-01 — review-caught-28

- **What happened:** Green gate passed on #28 ("Render `todo list` rows as aligned columns, title last") but the cross-vendor reviewer requested changes (4 round(s)). First finding: - [test/cli/list-columns.test.ts](/Users/gapstars/.gibson/gibson-todo/worktrees/issue-28/test/cli/list-columns.test.ts:195) — kind: blocker; class: test-gap; trigger: `todo list --priority urgent` ⇒ the tagged test expects exit 1, so it doe
- **Fix / rule:** If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).
- **Links:** PR #31 · run `20261101-092245-make-todo-list-easy-to-scan-sh`

## 2026-11-01 — ci-diverged-28

- **What happened:** Local gate was green on #28 but required CI failed 1 time(s).
- **Fix / rule:** Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.
- **Links:** PR #31 · run `20261101-092245-make-todo-list-easy-to-scan-sh`
