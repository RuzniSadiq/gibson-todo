#!/usr/bin/env node
// Test-integrity ratchet: a PR may not shrink the suite or add skips unless
// its body carries a visible waiver in the exact form:
//   Test-integrity: removed <n> for <reason>
//   Test-integrity: skip +<n> for <reason>
// CI runs the BASE branch's copy of this script, so a PR cannot weaken it.
//   node scripts/test-integrity.mjs --base-dir base --head-dir head [--pr-body-file f]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runTapTests } from './gibson/lib/contract.mjs';

const { values } = parseArgs({ options: { 'base-dir': { type: 'string' }, 'head-dir': { type: 'string' }, 'pr-body-file': { type: 'string' } }, strict: true });
if (!values['base-dir'] || !values['head-dir']) { console.error('usage: test-integrity.mjs --base-dir <dir> --head-dir <dir>'); process.exit(2); }

const globsFor = (dir) => JSON.parse(readFileSync(join(dir, 'gibson/config.json'), 'utf8')).testGlobs;
const count = async (dir) => {
  if (!existsSync(join(dir, 'gibson/config.json'))) return { tests: 0, skip: 0, fail: 0 };
  return (await runTapTests(dir, globsFor(dir))).summary;
};
const base = await count(values['base-dir']);
const head = await count(values['head-dir']);
const body = values['pr-body-file'] && existsSync(values['pr-body-file']) ? readFileSync(values['pr-body-file'], 'utf8') : '';
const removedWaiver = Number(/^Test-integrity: removed (\d+) for \S.+$/m.exec(body)?.[1] ?? 0);
const skipWaiver = Number(/^Test-integrity: skip \+(\d+) for \S.+$/m.exec(body)?.[1] ?? 0);

const skipsBase = base.skip + base.todo;
const skipsHead = head.skip + head.todo;
console.log(`test-integrity: base ${base.tests} tests (${skipsBase} skipped) → head ${head.tests} tests (${skipsHead} skipped)`);
const problems = [];
if (head.tests + removedWaiver < base.tests) problems.push(`suite shrank by ${base.tests - head.tests} without a matching "Test-integrity: removed <n> for <reason>" waiver`);
if (skipsHead > skipsBase + skipWaiver) problems.push(`skips grew by ${skipsHead - skipsBase} without a matching "Test-integrity: skip +<n> for <reason>" waiver`);
if (removedWaiver || skipWaiver) console.log('test-integrity: WAIVER accepted — reviewer must verify it is intentional (reviewer playbook §4b).');
for (const p of problems) console.log(`test-integrity: FAIL — ${p}`);
if (!problems.length) console.log('test-integrity: OK');
process.exit(problems.length ? 1 : 0);
