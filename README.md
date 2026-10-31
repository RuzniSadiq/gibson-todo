# gibson-todo

A small, fast task list for your terminal — **built and maintained by a
governed AI agent fleet**. You ask for a feature in plain English; the fleet
plans it, waits for your approval, files issues, builds each one in isolation,
has a *different* AI vendor review it, proves every acceptance criterion with
a test, and merges it according to its risk tier.

```
bin/gibson "Let me give tasks a priority and show the urgent ones first"
```

The governance comes from [The Gibson](https://github.com/The-AIE/the-gibson)
contract: the Ten Laws, the Ask Contract, human gates G1–G16 and risk tiers A/B/C.

---

## The product: `todo`

```console
$ todo add "Prepare board deck"
Added   #1  [ ]  Prepare board deck
$ todo add Call the bank
$ todo done 2
Done    #2  [x]  Call the bank
$ todo ls --all
  #1  [ ]  Prepare board deck
  #2  [x]  Call the bank

1 open task · 1 done
$ todo list --json | jq '.[0].title'
"Prepare board deck"
```

| Command | What it does |
|---|---|
| `todo add <title…>` | Add a task |
| `todo list [--all\|--done]` (`ls`) | Show open tasks (or all / completed) |
| `todo done <id…>` | Mark tasks done |
| `todo undo <id…>` | Reopen tasks |
| `todo edit <id> <title…>` | Rename a task |
| `todo rm <id…>` | Delete tasks |
| `todo clear` | Delete all completed tasks |
| `todo help [command]` | Help, with examples |

Every command takes `--json`. Exit codes are a contract: `0` ok · `1` user
error · `2` usage · `3` storage · `70` bug. Tasks live in `$TODO_FILE` or
`~/.local/share/gibson-todo/tasks.json`.

### Architecture

```
src/domain/          Task entity + invariants · TodoError codes        pure
src/application/     TaskService use cases · TaskRepository port       pure
src/infrastructure/  JSON store: versioned schema + migrations,
                     atomic write (fsync + rename), cross-process lock
src/cli/             argv → command → TaskService → Output (text | --json)
```

- **Zero runtime dependencies.** Node ≥ 22.18 runs the TypeScript sources
  directly; `npm run build` emits plain JS to `dist/`.
- **Data safety:** writes are atomic and serialized across processes; a file
  from a newer schema version, or a damaged one, is refused — never overwritten.
- **Testable by construction:** the CLI is a function `run(argv, io, deps)`;
  storage is a port with file and in-memory adapters.

---

## The fleet: `bin/gibson`

```
 you ─"plain English"─▶ PLAN ─▶ you approve ─▶ DECOMPOSE ─▶ for each issue, in dependency order:
                                                              CLAIM    label + own worktree + draft PR
                                                              BUILD    Claude (may edit; may not commit/push/merge)
                                                              GATE     harness re-runs typecheck·lint·test·build + contract
                                                              SECURITY secrets · dependencies · prompt-injection
                                                              REVIEW   Codex: read-only, exact head SHA, six lenses
                                                              UX-EVAL  a separate model drives the live CLI
                                                              CI       the same sensors, from the base branch
                                                              MERGE    Tier A/B automatic · Tier C asks you (G12)
                                                              DEPLOY   rebuild the release + smoke test
                                                              RETRO    cleanup · lessons → MEMORY.md
```

| Command | |
|---|---|
| `bin/gibson "<request>"` | Start a feature request |
| `bin/gibson status` | What shipped, what's in flight, what needs you |
| `bin/gibson approve <pr>` | Approve a Tier C change waiting at the human gate |
| `bin/gibson resume [run]` | Continue a stopped run |
| `bin/gibson doctor` | Check runners, GitHub access, guardrails |
| `bin/gibson halt` / `unhalt` | Kill switch |
| `bin/gibson deploy --install` | Put the released `todo` on your PATH |

### Who does what (routing table — `gibson/config.json`)

| Hat | Runner | Can | Cannot |
|---|---|---|---|
| planner, decomposer | Claude (opus) | read the repo | write anything |
| builder | Claude (opus) | edit files, run the gate | commit, push, call `gh`, install deps |
| reviewer | **Codex** | read (sandboxed) | edit, merge — and it is a different vendor (Law 5) |
| ux-evaluator | Claude (sonnet) | run the built CLI | edit |
| harness | `scripts/gibson/` | commit (signed-off), open/merge PRs | merge without evidence |

### What is enforced, and where

| Rule | Sensor | Where it runs |
|---|---|---|
| Green gate, zero new failures (Law 4) | `scripts/gate.mjs` | pipeline + CI `gate` |
| Every criterion proven by a tagged test (Law 6) | `scripts/contract-met.mjs` | pipeline + CI `contract` |
| Suite never shrinks silently | `scripts/test-integrity.mjs` | CI `test-integrity` (base copy) |
| Diff can't drift above its tier | `scripts/tier-classify.mjs` | pipeline + CI `tier-drift` (base rules) |
| No secrets in diffs (G4) | `scripts/secrets-scan.mjs` | pipeline + CI `secrets` |
| Cross-vendor review at the exact head; owner approval on Tier C (Law 5, G12) | `scripts/review-evidence.mjs` | CI status `gibson/review-evidence` (default-branch copy) |
| Signed-off commits (DCO) | — | CI `dco` |
| Prompt-injection steering an agent (G16) | `scripts/gibson/lib/security.mjs` | pipeline — halts the fleet |
| Merge rules can't be bypassed | branch protection | GitHub (`scripts/apply-branch-protection.sh`) |

### Setup

```sh
npm ci
bin/gibson doctor                                  # claude, codex, gh must be available
bash scripts/apply-branch-protection.sh            # audit + dry-run
bash scripts/apply-branch-protection.sh --apply    # owner applies
```

Read `AGENTS.md` for the repo contract and `gibson/PRODUCT-DIRECTION.md` for
the standing product decisions the fleet follows.
