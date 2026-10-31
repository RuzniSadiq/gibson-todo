import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { failingTests, newFailures, STEPS } from '../gibson/lib/gate.mjs';

const gate = JSON.parse(readFileSync(new URL('../../.agents/gate.json', import.meta.url), 'utf8'));
const step = (name, status, failing = []) => ({ name, status, failingTests: failing, tail: '' });

describe('green gate', () => {
  it('[AC-1.5] .agents/gate.json defines the five steps in order, with real commands', () => {
    assert.deepEqual(STEPS, ['generate', 'typecheck', 'lint', 'test', 'build']);
    for (const s of STEPS) assert.ok(s in gate, `missing ${s}`);
    for (const s of ['typecheck', 'lint', 'test', 'build']) assert.ok(gate[s].trim().length > 0, `${s} must not be empty`);
  });

  it('[AC-1.5] counts only NEW failures versus the branch-point baseline', () => {
    const baseline = { steps: [step('lint', 'pass'), step('test', 'fail', ['old flaky'])] };
    assert.deepEqual(newFailures(baseline, { steps: [step('lint', 'pass'), step('test', 'fail', ['old flaky'])] }), []);
    const fresh = newFailures(baseline, { steps: [step('lint', 'fail'), step('test', 'fail', ['old flaky', 'brand new'])] });
    assert.deepEqual(fresh.map((f) => f.step), ['lint', 'test']);
    assert.match(fresh[1].reason, /brand new/);
    assert.equal(newFailures(null, { steps: [step('build', 'fail')] }).length, 1, 'no baseline = every failure is new');
  });

  it('[AC-1.5] extracts failing test names from spec reporter output', () => {
    const out = '✔ fine (1ms)\n  ✖ [AC-3.1] sorts by priority (2.5ms)\n✖ suite (10ms)\n';
    assert.deepEqual(failingTests(out), ['[AC-3.1] sorts by priority', 'suite']);
  });

  it('[AC-1.5] CI runs the same gate script as local', () => {
    const ci = readFileSync(new URL('../../.github/workflows/gibson-gate.yml', import.meta.url), 'utf8');
    assert.match(ci, /node scripts\/gate\.mjs/);
    assert.match(readFileSync(new URL('../gate.sh', import.meta.url), 'utf8'), /scripts\/gate\.mjs/);
  });
});
