import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The canonical checkout this harness was launched from (read-only, Law 3). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadConfig(root = REPO_ROOT) {
  const config = JSON.parse(readFileSync(join(root, 'gibson/config.json'), 'utf8'));
  const stateDir = config.stateDir.replace(/^~(?=\/|$)/, homedir());
  return {
    ...config,
    root,
    stateDir,
    runsDir: join(stateDir, 'runs'),
    worktreesDir: join(stateDir, 'worktrees'),
    releaseDir: join(stateDir, 'release'),
    snapshotDir: join(stateDir, 'worktrees', '_snapshot'),
    haltFile: join(stateDir, 'HALT'),
  };
}

/** Law 5 at configuration time: refuse a routing table where a builder reviews itself. */
export function validateRouting(config) {
  const { builder, reviewer, uxEvaluator } = config.routing;
  const problems = [];
  if (builder.vendor === reviewer.vendor) {
    problems.push(`builder and reviewer are both "${builder.vendor}" — Law 5 needs a different reviewer (cross-vendor).`);
  }
  if (uxEvaluator.vendor === builder.vendor && uxEvaluator.model === builder.model) {
    problems.push('ux-evaluator must be a separate identity from the builder (different vendor or model, D-012 E2).');
  }
  return problems;
}
