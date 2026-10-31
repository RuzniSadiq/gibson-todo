#!/usr/bin/env bash
# Delivery control (Gibson AGENTS.md): audit → dry-run → explicit human apply.
# Protects main so GitHub itself refuses any merge that skipped a gate.
#
#   bash scripts/apply-branch-protection.sh            # audit + dry-run (read-only, default)
#   bash scripts/apply-branch-protection.sh --apply    # owner only; asks you to type APPLY
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
REPO=$(node -p "require('./gibson/config.json').repo")
BRANCH=$(node -p "require('./gibson/config.json').defaultBranch")
CHECKS=$(node -p "JSON.stringify(require('./gibson/config.json').requiredChecks)")
COUNT=$(node -p "require('./gibson/config.json').requiredChecks.length")

PAYLOAD=$(cat <<JSON
{
  "required_status_checks": { "strict": false, "contexts": $CHECKS },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
)

echo "== AUDIT (read-only): current protection on $REPO@$BRANCH"
if current=$(gh api "repos/$REPO/branches/$BRANCH/protection" --jq '{checks: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled, force_push: .allow_force_pushes.enabled}' 2>/dev/null); then echo "  $current"; else echo "  (none — $BRANCH is unprotected)"; fi
gh api "repos/$REPO" --jq '"  merge settings: squash=\(.allow_squash_merge) merge-commit=\(.allow_merge_commit) rebase=\(.allow_rebase_merge) auto-merge=\(.allow_auto_merge) delete-branch-on-merge=\(.delete_branch_on_merge)"'

echo
echo "== DRY-RUN: this is exactly what --apply would send"
echo "PUT repos/$REPO/branches/$BRANCH/protection"
echo "$PAYLOAD"
echo "PATCH repos/$REPO  {allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: true, delete_branch_on_merge: true}"

[ "${1:-}" = "--apply" ] || { echo; echo "Dry-run only. Nothing changed. Owner applies with: bash scripts/apply-branch-protection.sh --apply"; exit 0; }

echo
echo "What I'm asking: protect '$BRANCH' on $REPO with the settings above."
echo "What it does:    GitHub refuses any merge into $BRANCH unless all $COUNT required checks pass; nobody (you included) can force-push or delete it."
echo "Why:             the fleet's merge rules become enforced by GitHub, not just by the pipeline's good behaviour."
echo "Risks:           low. A broken check would block merges until fixed. Undo: Settings → Branches → delete the rule (or gh api -X DELETE .../protection)."
read -r -p "Type APPLY to proceed: " answer
[ "$answer" = "APPLY" ] || { echo "Not applied."; exit 1; }
echo "$PAYLOAD" | gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - >/dev/null
gh api -X PATCH "repos/$REPO" -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F allow_auto_merge=true -F delete_branch_on_merge=true >/dev/null
echo "Applied. Verify: bin/gibson doctor"
