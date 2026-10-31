#!/usr/bin/env node
// Green gate runner. Same obligation locally and in CI.
//   node scripts/gate.mjs                 run; compare against .gibson-baseline.json if present
//   node scripts/gate.mjs --baseline      record the branch-point baseline
//   node scripts/gate.mjs --base origin/main --skip-if-memory-only   (CI)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './gibson/lib/config.mjs';
import { must } from './gibson/lib/exec.mjs';
import { newFailures, runGate } from './gibson/lib/gate.mjs';
import { isMemoryOnly } from './gibson/lib/tier.mjs';

const { values } = parseArgs({ options: { baseline: { type: 'boolean' }, base: { type: 'string' }, 'skip-if-memory-only': { type: 'boolean' }, json: { type: 'boolean' } }, strict: true });
const BASELINE = '.gibson-baseline.json';

if (values['skip-if-memory-only'] && values.base) {
  const files = (await must('git', ['diff', '--name-only', `${values.base}...HEAD`])).split('\n').filter(Boolean);
  if (isMemoryOnly(files, loadConfig())) {
    console.log('gate: memory-only change — green gate skipped (AGENTS.md Law 4 exception).');
    process.exit(0);
  }
}

const result = await runGate(process.cwd());
for (const s of result.steps) console.log(`gate: ${s.name.padEnd(9)} ${s.status.toUpperCase()}${s.durationMs ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : ''}`);

if (values.baseline) {
  writeFileSync(BASELINE, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...result }, null, 2)}\n`);
  console.log(`gate: baseline recorded (${result.green ? 'green' : 'pre-existing failures noted'}).`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
const fresh = newFailures(baseline, result);
if (values.json) console.log(JSON.stringify({ ...result, newFailures: fresh }, null, 2));
for (const f of fresh) console.log(`\ngate: NEW FAILURE in ${f.step} — ${f.reason}\n${f.tail}`);
const preexisting = result.steps.filter((s) => s.status === 'fail').length - fresh.length;
if (preexisting > 0) console.log(`gate: ${preexisting} pre-existing failing step(s) recorded at branch point — not inherited, not hidden.`);
console.log(fresh.length ? 'gate: RED' : 'gate: GREEN (zero new failures vs. branch point)');
process.exit(fresh.length ? 1 : 0);
