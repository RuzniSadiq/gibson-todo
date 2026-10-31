#!/usr/bin/env node
// Tier sensor. Computes the risk tier of HEAD vs. --base from changed paths
// and size, and fails when it exceeds the declared tier (undeclared drift).
//   node scripts/tier-classify.mjs --base origin/main --declared B [--json]
//   node scripts/tier-classify.mjs --base origin/main --labels '["tier:B"]' --config .base/gibson/config.json
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './gibson/lib/config.mjs';
import { must } from './gibson/lib/exec.mjs';
import { assessTier, isMemoryOnly } from './gibson/lib/tier.mjs';

const { values } = parseArgs({ options: { base: { type: 'string' }, declared: { type: 'string' }, labels: { type: 'string' }, json: { type: 'boolean' }, config: { type: 'string' } }, strict: true });
if (!values.base) { console.error('usage: tier-classify.mjs --base <ref> [--declared A|B|C]'); process.exit(2); }
// --config lets CI grade with the BASE branch's rules, not the PR's own.
const config = values.config ? { ...loadConfig(process.cwd()), ...JSON.parse(readFileSync(values.config, 'utf8')) } : loadConfig(process.cwd());
const paths = (await must('git', ['diff', '--name-only', `${values.base}...HEAD`])).split('\n').filter(Boolean);
const numstat = (await must('git', ['diff', '--numstat', `${values.base}...HEAD`])).split('\n').filter(Boolean);
const size = { files: numstat.length, lines: numstat.reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0) };

let declared = values.declared;
if (!declared && values.labels) {
  const names = JSON.parse(values.labels).map((l) => (typeof l === 'string' ? l : l.name));
  declared = ['C', 'B', 'A'].find((t) => names.includes(`tier:${t}`));
}
if (isMemoryOnly(paths, config)) {
  console.log('tier-drift: memory-only change — not tiered (Law 4 exception).');
  process.exit(0);
}
const result = assessTier({ paths, size, declared }, config);
if (values.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`tier: computed ${result.tier} (paths ${result.byPath}, size ${result.bySize}: ${size.files} files / ${size.lines} lines), declared ${declared ?? 'none'}`);
  for (const r of result.reasons) console.log(`  ${r.tier}  ${r.path} — ${r.why}`);
}
if (!declared) { console.log('tier-drift: FAIL — the PR carries no tier:A|B|C label.'); process.exit(1); }
if (result.drift) { console.log(`tier-drift: FAIL — diff drifted into Tier ${result.tier} but is labeled ${declared}. Relabel (diffs never drift out of a tier silently).`); process.exit(1); }
console.log('tier-drift: OK');
