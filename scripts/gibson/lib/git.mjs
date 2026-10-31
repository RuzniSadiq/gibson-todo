// Git operations. All mutation happens inside worktrees under stateDir; the
// canonical checkout is only ever used for `git fetch` and `worktree add` (Law 3).
import { existsSync } from 'node:fs';
import { must, run } from './exec.mjs';

export const git = (cwd, args, opts = {}) => must('git', args, { cwd, timeoutSec: 180, ...opts });

export async function fetchOrigin(root) {
  await git(root, ['fetch', '--quiet', '--prune', 'origin']);
}

export async function addWorktree(root, { path, branch, from }) {
  if (existsSync(path)) return path;
  await git(root, ['worktree', 'add', '--quiet', '-b', branch, path, from]);
  return path;
}

/** Detached worktree that tracks origin/<branch> (release + read-only snapshot). */
export async function syncDetachedWorktree(root, path, ref) {
  if (!existsSync(path)) await git(root, ['worktree', 'add', '--quiet', '--detach', path, ref]);
  else {
    await git(path, ['fetch', '--quiet', 'origin']);
    await git(path, ['checkout', '--quiet', '--detach', '--force', ref]);
    await git(path, ['clean', '-fdq', '-e', 'node_modules']);
  }
  return path;
}

export async function removeWorktree(root, path, branch) {
  if (existsSync(path)) await run('git', ['worktree', 'remove', '--force', path], { cwd: root });
  await run('git', ['worktree', 'prune'], { cwd: root });
  if (branch) await run('git', ['branch', '-D', branch], { cwd: root });
}

export const headSha = async (cwd) => (await git(cwd, ['rev-parse', 'HEAD'])).trim();

export async function changedFiles(cwd, base) {
  const out = await git(cwd, ['diff', '--name-only', `${base}...HEAD`]);
  return out.split('\n').filter(Boolean);
}

export async function workingChanges(cwd) {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1));
}

export async function diffStat(cwd, base) {
  const out = await git(cwd, ['diff', '--numstat', `${base}...HEAD`]);
  const rows = out.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const lines = rows.reduce((n, [a, d]) => n + (Number(a) || 0) + (Number(d) || 0), 0);
  return { files: rows.length, lines };
}

/** Review diff. Lockfiles are excluded: the supply-chain layer audits them, and they drown the signal. */
export const diff = (cwd, base) => git(cwd, ['diff', `${base}...HEAD`, '--', '.', ':(exclude)package-lock.json']);

export async function commitAll(cwd, message) {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '--quiet', '-s', '-F', '-'], { input: message });
  return headSha(cwd);
}

export async function push(cwd, branch) {
  await git(cwd, ['push', '--quiet', '-u', 'origin', branch]);
}

export async function identity(cwd) {
  const name = (await git(cwd, ['config', 'user.name'])).trim();
  const email = (await git(cwd, ['config', 'user.email'])).trim();
  return { name, email, signoff: `Signed-off-by: ${name} <${email}>` };
}
