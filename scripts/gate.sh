#!/usr/bin/env bash
# Green gate (AGENTS.md Law 4). Thin wrapper so humans and agents share one command.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec node scripts/gate.mjs "$@"
