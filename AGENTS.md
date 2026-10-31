# AGENTS.md — gibson-todo

This repository is developed by a governed agent fleet under
[The Gibson](https://github.com/The-AIE/the-gibson) contract. The Gibson's
`AGENTS.md` (Ten Laws, Ask Contract, human gates G1–G16, risk tiers) binds
every agent here. This file states **repo facts only** — doctrine lives in
the harness, this file instantiates it (template:
`the-gibson/templates/target-repo/AGENTS-section.md`).

## Autonomous development contract

Machine-readable companion: `.agents/gate.json` (same commands, parseable).
Harness configuration (routing table, tier rules, limits): `gibson/config.json`.
Owner product direction (the fleet's proxy for the owner): `gibson/PRODUCT-DIRECTION.md`.

### Shared agent memory

- **Read** `MEMORY.md` at session start before mutating work.
- **Dual-write:** durable lessons go in `MEMORY.md`, not only in a local runtime store.
- **No CI loop for pure memory commits:** a change touching **only** `MEMORY.md`
  (or `memory/**`) skips the green gate and the review gate (Gibson Law 4
  exception). It still lands through a PR because `main` is protected; the
  sensors recognise it as memory-only and pass it.
- **Append-only**; no secrets in memory files.

### Gate commands (the definition of "green" here)
```bash
npm run typecheck   # tsc --noEmit, strict + erasableSyntaxOnly
npm run lint        # eslint (typescript-eslint strict)
npm test            # node:test — product tests + harness sensor tests
npm run build       # tsc → dist/
```
`npm run gate` runs all four via `scripts/gate.mjs`, comparing against the
branch-point baseline (`.gibson-baseline.json`): **zero new failures**.
CI (`.github/workflows/gibson-gate.yml`) runs the same script.

### Ground rules for machine contributors
1. **Never mutate the shared checkout.** One issue = one branch = one git
   worktree under `~/.gibson/gibson-todo/worktrees/`.
2. **Claim before you touch.** Claim = `agent-claimed` label on the issue +
   a `- Active-work claim: issue-<n> scope=<globs> builder=<vendor>` line in
   the draft PR body. Overlapping live claim ⇒ stop and coordinate.
3. **Never review or approve your own work.** The reviewer is a different
   vendor (`gibson/config.json` → `routing`), read-only, bound to the exact head SHA.
4. **Acceptance criteria are the contract.** Every criterion `AC-<issue>.<n>`
   must be proven by a passing test whose name contains `[AC-<issue>.<n>]`
   (`scripts/contract-met.mjs`, required check `contract`).
5. **Report failures verbatim.** Never mark done what you did not verify.
6. **Clean up:** remove the worktree, delete the branch, release the claim.
7. **Builders do not commit, push, merge or call `gh`.** The harness commits
   (signed-off) only after re-running the gate itself.

### Architecture (respect the layers)
```
src/domain/          Task entity + invariants, TodoError codes      (pure, no I/O)
src/application/     TaskService use cases, ports (TaskRepository)  (no I/O)
src/infrastructure/  JSON file store (atomic write + lock), schema, migrations, config
src/cli/             parse → command → TaskService → Output (text | --json)
```
Dependencies point inward only. One file per command in `src/cli/commands/`,
registered in `src/cli/registry.ts`. User-facing failures throw `TodoError`;
the CLI maps codes to exit statuses (0 ok · 1 user · 2 usage · 3 storage · 70 bug).

### Hot files (single claimant, own PR)
| File | Rule |
|---|---|
| `src/infrastructure/storage/schema.ts` | **Tier C.** Additive-only: bump `CURRENT_SCHEMA_VERSION`, add a migration, never remove/rename stored fields. Own issue. Non-additive change = human gate G1. |
| `src/infrastructure/storage/migrations.ts` | **Tier C.** Forward-only, pure, tested against a previous-version fixture. |
| `package.json` | No runtime dependencies (the product has none). Dev deps only with a stated need, own commit. |
| `.github/**`, `scripts/**`, `gibson/**`, `.agents/**`, `bin/**`, `AGENTS.md` | **Tier C** — harness and gates are security boundaries. |
| `MEMORY.md` | Append-only lessons; pure updates skip the product CI loop. |

### Risk tiers here (machine source: `gibson/config.json` → `tierRules`)
| Tier | Paths | Merge path |
|---|---|---|
| A | `src/cli/**`, `test/**`, docs | checks + cross-vendor review ⇒ auto-merge |
| B | `src/domain/**`, `src/application/**`, `src/infrastructure/**`, `package.json`, configs; or >150 lines / >6 files | checks + full-lens cross-vendor review ⇒ auto-merge |
| C | storage schema + migrations, harness, CI | FAN-OUT + adversarial review **and** owner approval at the exact head (G12) |

### Framework warnings
- Node ≥ 22.18 runs `.ts` directly (type stripping). Source imports use `.ts`
  extensions; `tsc` rewrites them to `.js` on build (`rewriteRelativeImportExtensions`).
- `erasableSyntaxOnly` is on: **no enums, no namespaces, no constructor
  parameter properties** — use `#private` fields assigned in the constructor.
- `exactOptionalPropertyTypes` is on: pass `undefined` explicitly only where the type allows it.

### Deployment truth (verified 2026-11-01)
- Product: a CLI. "Production" = the release build at
  `~/.gibson/gibson-todo/release` (a detached worktree of `origin/main`).
- Merge to `main` ⇒ the pipeline rebuilds the release and smoke-tests it
  (add → list --json → done → help). A failed smoke test halts the fleet.
- `bin/gibson deploy --install` links `todo` onto the owner's PATH (owner-confirmed).

### Stop and ask a human for
- Money: none in this product (no billing surface).
- Auth / authorization boundaries: none in the product; repo access and
  branch protection are owner-only (G14).
- PII / consent: task titles are personal data on the user's own disk; never
  transmit them anywhere (no network code in `src/`).
- Security boundaries: `.github/**`, `scripts/**`, `gibson/**` (Tier C).
- Destructive data / schema operations: any non-additive storage change (G1).
- Secret values, public launches, anything sent to humans (G4, G7, G8).

### Commit and PR conventions
- `git commit -s` on every commit (DCO; required check `dco`). The squash
  body carries the `Signed-off-by` trailer.
- Branches: `gibson/<issue>-<slug>`. PR title `feat(#<issue>): …`, body has
  `Closes #<issue>`, the claim line and `Builder-Vendor:`.
- Required checks on `main`: `gate`, `dco`, `test-integrity`, `secrets`,
  `contract`, `tier-drift`, `gibson/review-evidence`.
- Agents may merge their own lane's PR only through the harness merge step,
  which re-verifies review evidence at the exact head (Tier A/B). Tier C
  merges only after the owner's approval comment for that head.
