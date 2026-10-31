// Law 6: acceptance criteria are the contract, verified by a sensor.
// Each criterion has an id (AC-<issue>.<n>). A criterion is MET only when at
// least one test whose name contains "[AC-<issue>.<n>]" ran and passed.
import { run } from './exec.mjs';

export function acIdsFromBody(body) {
  return [...new Set([...String(body ?? '').matchAll(/\bAC-(\d+)\.(\d+)\b/g)].map((m) => m[0]))];
}

/** Parses node:test TAP output (any nesting depth). */
export function parseTap(text) {
  const tests = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line);
    if (m) tests.push({ name: m[2], ok: m[1] === 'ok', skipped: Boolean(m[3]) });
  }
  const count = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
  return { tests, summary: { tests: count('tests'), pass: count('pass'), fail: count('fail'), skip: count('skipped') + count('skip'), todo: count('todo') } };
}

export function evaluateContract(ids, tests) {
  const rows = ids.map((id) => {
    const covering = tests.filter((t) => t.name.includes(`[${id}]`));
    const passing = covering.filter((t) => t.ok && !t.skipped);
    return { id, met: passing.length > 0 && passing.length === covering.length, tests: covering.map((t) => t.name), failing: covering.filter((t) => !t.ok).map((t) => t.name) };
  });
  return { met: rows.filter((r) => r.met), unmet: rows.filter((r) => !r.met), rows };
}

export async function runTapTests(cwd, globs, timeoutSec = 600) {
  const r = await run(process.execPath, ['--test', '--test-reporter=tap', ...globs], { cwd, timeoutSec, env: { NO_COLOR: '1' } });
  return { ...parseTap(r.stdout), code: r.code, raw: r.stdout, stderr: r.stderr };
}
