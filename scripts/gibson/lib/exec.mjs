// Process execution with a hard deadline. Liveness Contract: nothing the
// harness spawns may hang the pipeline — every call has a timeout and the
// whole process group is killed when it expires.
import { spawn } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, env?: Record<string,string|undefined>, timeoutSec?: number}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean, durationMs: number}>}
 */
export function run(cmd, args, opts = {}) {
  const { cwd, input, env, timeoutSec = 300 } = opts;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: String(error), timedOut: false, durationMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }, 5000).unref();
      } catch { /* already gone */ }
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(error), timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    child.stdin.end(input ?? '');
  });
}

/** Like run(), but throws with the verbatim stderr on a non-zero exit (Law 8). */
export async function must(cmd, args, opts = {}) {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) {
    const what = `${cmd} ${args.join(' ')}`.slice(0, 200);
    const why = result.timedOut ? `timed out after ${opts.timeoutSec ?? 300}s` : `exit ${result.code}`;
    throw new Error(`${what} — ${why}\n${(result.stderr || result.stdout).trim().slice(-2000)}`);
  }
  return result.stdout;
}
