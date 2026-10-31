// Risk-tier classifier (AGENTS.md "Risk tiers"). Tier is the maximum of:
//   the tier declared at decomposition, every changed path's rule tier, and
//   the size rule (>150 lines or >6 files => at least B).
// Diffs may drift INTO Tier C; they never drift out without a reviewer.
import { matches, matchesAny } from './glob.mjs';

const RANK = { A: 1, B: 2, C: 3 };
export const maxTier = (...tiers) =>
  tiers.filter(Boolean).reduce((best, t) => (RANK[t] > RANK[best] ? t : best), 'A');
export const tierAbove = (a, b) => RANK[a] > RANK[b];

/** @param {string[]} paths @param {{tierRules: {tier:string,glob:string,why:string}[], unmatchedTier: string}} config */
export function classifyPaths(paths, config) {
  const reasons = [];
  let tier = 'A';
  for (const path of paths) {
    const hits = config.tierRules.filter((r) => matches(path, r.glob));
    const top = hits.length ? hits.reduce((a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a)) : null;
    const pathTier = top ? top.tier : config.unmatchedTier;
    reasons.push({ path, tier: pathTier, why: top ? top.why : 'no rule matched (default)' });
    tier = maxTier(tier, pathTier);
  }
  return { tier, reasons };
}

/** @param {{files: number, lines: number}} size */
export function sizeTier(size, config) {
  const limit = config.sizeTierB;
  return size.lines > limit.lines || size.files > limit.files ? 'B' : 'A';
}

export const isMemoryOnly = (paths, config) =>
  paths.length > 0 && paths.every((p) => matchesAny(p, config.memoryPaths));

/** Full assessment used by both the pipeline and the CI tier-drift check. */
export function assessTier({ paths, size, declared }, config) {
  const byPath = classifyPaths(paths, config);
  const bySize = sizeTier(size, config);
  const tier = maxTier(declared, byPath.tier, bySize);
  return {
    tier,
    declared,
    byPath: byPath.tier,
    bySize,
    drift: declared ? tierAbove(tier, declared) : false,
    undeclaredTierC: tier === 'C' && declared !== 'C',
    reasons: byPath.reasons.filter((r) => r.tier !== 'A'),
  };
}
