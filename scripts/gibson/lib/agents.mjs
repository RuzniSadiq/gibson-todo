// Vendor adapters: how each hat is dispatched to each runtime. Capabilities
// are enforced HERE, not requested politely in the prompt:
//   read  — may read the repo only (planner, decomposer, reviewer)
//   edit  — may edit files and run the gate; may NOT commit, push, call gh,
//           or install packages (builder). The orchestrator commits.
//   probe — may read and execute the built CLI only (ux-evaluator)
// Every dispatch has a hard timeout (Liveness Contract) and a transcript.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.mjs';

export const CLAUDE_TOOLS = {
  read: ['Read', 'Glob', 'Grep'],
  edit: [
    'Read', 'Glob', 'Grep', 'Edit', 'Write',
    'Bash(npm run gate)', 'Bash(npm run typecheck)', 'Bash(npm run lint)', 'Bash(npm run build)', 'Bash(npm test)',
    'Bash(node --test:*)', 'Bash(node src/cli/main.ts:*)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)',
  ],
  probe: ['Read', 'Glob', 'Grep', 'Bash(node dist/cli/main.js:*)', 'Bash(./dist/cli/main.js:*)', 'Bash(TODO_FILE=*)'],
};
const CLAUDE_DENY = [
  'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(gh:*)',
  'Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(rm -rf:*)', 'Bash(curl:*)', 'WebFetch', 'WebSearch',
];
const CODEX_SANDBOX = { read: 'read-only', probe: 'read-only', edit: 'workspace-write' };

// Builders and evaluators run without GitHub/SSH credentials: even code they
// write and execute (tests) cannot push, call the GitHub API, or reach the
// owner's keys. Residual risk (files on disk) is caught by the post-build
// tamper check in deliver.mjs; full isolation needs an OS sandbox.
export function scrubbedEnv(access, extra = {}) {
  if (access === 'read') return { env: extra };
  // Allowlist, not denylist: only what a CLI runner needs survives; every
  // other variable (API keys, tokens, agent sockets) is dropped.
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return { env: { ...env, ...extra, GH_CONFIG_DIR: '/nonexistent-gibson', GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0' }, clean: true };
}

const envFor = (job) => { const { env, clean } = scrubbedEnv(job.access, job.env); return { env, cleanEnv: Boolean(clean) }; };

let counter = 0;

/**
 * @param {{role: string, vendor: 'claude'|'codex', model?: string, access: 'read'|'edit'|'probe',
 *          prompt: string, cwd: string, timeoutSec: number, runDir: string, env?: object}} job
 * @returns {Promise<{ok: boolean, text: string, vendor: string, model: string, sessionId: string|null,
 *                    durationMs: number, error?: string, transcript: string, costUsd?: number}>}
 */
export async function dispatch(job) {
  const n = String(++counter).padStart(2, '0');
  const transcript = join(job.runDir, `agent-${n}-${job.role}-${job.vendor}.log`);
  const result = job.vendor === 'claude' ? await viaClaude(job) : job.vendor === 'codex' ? await viaCodex(job, transcript) : unknownVendor(job);
  writeFileSync(
    transcript,
    [`# ${job.role} via ${job.vendor} (${result.model || 'default model'})`, `cwd: ${job.cwd}`, `access: ${job.access}`,
      `ok: ${result.ok} ${result.error ?? ''}`, '', '## Prompt', job.prompt, '', '## Output', result.text, '', '## Stderr', result.stderr ?? ''].join('\n'),
  );
  return { ...result, transcript };
}

async function viaClaude(job) {
  const args = [
    '-p', '--output-format', 'json', '--no-session-persistence',
    '--setting-sources', 'project', '--strict-mcp-config',
    '--permission-mode', job.access === 'edit' ? 'acceptEdits' : 'default',
    '--allowedTools', ...CLAUDE_TOOLS[job.access],
    '--disallowedTools', ...CLAUDE_DENY,
  ];
  if (job.model) args.push('--model', job.model);
  const r = await run('claude', args, { cwd: job.cwd, input: job.prompt, timeoutSec: job.timeoutSec, ...envFor(job) });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* reported below */ }
  const text = parsed?.result ?? r.stdout;
  const model = parsed?.modelUsage ? Object.keys(parsed.modelUsage).join('+') : job.model ?? '';
  const ok = r.code === 0 && parsed !== null && !parsed.is_error;
  return {
    ok, text: String(text ?? ''), vendor: 'claude', model, sessionId: parsed?.session_id ?? null,
    durationMs: r.durationMs, costUsd: parsed?.total_cost_usd, stderr: r.stderr,
    error: ok ? undefined : r.timedOut ? `timed out after ${job.timeoutSec}s` : `exit ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`,
  };
}

async function viaCodex(job, transcript) {
  const lastMessage = `${transcript}.last.txt`;
  const args = ['exec', '--skip-git-repo-check', '-s', CODEX_SANDBOX[job.access], '-C', job.cwd, '-o', lastMessage];
  if (job.model) args.push('-m', job.model);
  args.push('-');
  const r = await run('codex', args, { cwd: job.cwd, input: job.prompt, timeoutSec: job.timeoutSec, ...envFor(job) });
  let text = '';
  try { text = readFileSync(lastMessage, 'utf8'); } catch { text = r.stdout; }
  const model = /^model:\s*(\S+)/m.exec(`${r.stderr}\n${r.stdout}`)?.[1] ?? job.model ?? '';
  const session = /^session id:\s*(\S+)/m.exec(`${r.stderr}\n${r.stdout}`)?.[1] ?? null;
  const ok = r.code === 0 && text.trim().length > 0;
  return {
    ok, text, vendor: 'codex', model, sessionId: session, durationMs: r.durationMs, stderr: r.stderr,
    error: ok ? undefined : r.timedOut ? `timed out after ${job.timeoutSec}s` : `exit ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`,
  };
}

function unknownVendor(job) {
  return { ok: false, text: '', vendor: job.vendor, model: '', sessionId: null, durationMs: 0, error: `no adapter for vendor "${job.vendor}"` };
}

/** Fill {{placeholders}} in a role prompt. Unfilled placeholders are a bug: fail loudly. */
export function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`role prompt placeholder {{${key}}} has no value`);
    return String(vars[key]);
  });
}
