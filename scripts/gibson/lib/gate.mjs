// The green gate (Law 4): generate -> typecheck -> lint -> test -> build,
// with ZERO NEW failures versus the branch-point baseline.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.mjs';

export const STEPS = ['generate', 'typecheck', 'lint', 'test', 'build'];

export function loadGate(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.agents/gate.json'), 'utf8'));
}

/** Failing test names from node's spec reporter ("✖ name (1.2ms)"). */
export function failingTests(output) {
  return [...new Set([...String(output).matchAll(/^\s*✖ (.+?) \(\d[\d.]*m?s\)\s*$/gm)].map((m) => m[1]))];
}

export async function runGate(cwd, { timeoutSec = 600 } = {}) {
  const gate = loadGate(cwd);
  const steps = [];
  for (const name of STEPS) {
    const command = gate[name];
    if (!command) { steps.push({ name, status: 'n/a' }); continue; }
    const r = await run('bash', ['-c', command], { cwd, timeoutSec, env: { NO_COLOR: '1', FORCE_COLOR: '0', NODE_TEST_CONTEXT: undefined } });
    const output = `${r.stdout}\n${r.stderr}`;
    steps.push({
      name, command, status: r.code === 0 ? 'pass' : 'fail', code: r.code, durationMs: r.durationMs,
      failingTests: name === 'test' ? failingTests(output) : [], tail: r.code === 0 ? '' : output.trim().split('\n').slice(-60).join('\n'),
    });
  }
  return { steps, green: steps.every((s) => s.status !== 'fail') };
}

/**
 * New failures relative to a baseline. A step that failed at the branch point
 * is not this branch's fault — unless NEW tests fail inside it.
 */
export function newFailures(baseline, current) {
  const before = new Map((baseline?.steps ?? []).map((s) => [s.name, s]));
  const fresh = [];
  for (const step of current.steps) {
    if (step.status !== 'fail') continue;
    const prior = before.get(step.name);
    if (!prior || prior.status !== 'fail') { fresh.push({ step: step.name, reason: 'step newly failing', tail: step.tail }); continue; }
    const known = new Set(prior.failingTests ?? []);
    const added = (step.failingTests ?? []).filter((t) => !known.has(t));
    if (added.length) fresh.push({ step: step.name, reason: `new failing tests: ${added.join('; ')}`, tail: step.tail });
  }
  return fresh;
}
