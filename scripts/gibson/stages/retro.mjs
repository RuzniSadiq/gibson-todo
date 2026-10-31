// RETRO (Law 9 — feed the ratchet). When the harness let something through
// that a later stage caught (the reviewer found a blocker after a green gate,
// CI failed after a green local gate, the gate needed fixes), record a lesson
// in MEMORY.md. Pure memory commits skip the product CI loop (Law 4 exception)
// but still land through a PR, because main is protected.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { must } from '../lib/exec.mjs';
import * as git from '../lib/git.mjs';
import * as ui from '../lib/ui.mjs';

export function lessonsFrom(run) {
  const lessons = [];
  for (const issue of run.state.issues) {
    if (issue.findings?.length) {
      const first = issue.findings[0].text.split('\n').find((l) => /kind:\s*blocker/i.test(l) || /^\s*-\s*`[^`]+:\d+`/.test(l)) ?? issue.findings[0].text.split('\n').find(Boolean) ?? '';
      lessons.push({
        slug: `review-caught-${issue.number}`,
        what: `Green gate passed on #${issue.number} ("${issue.title}") but the cross-vendor reviewer requested changes (${issue.reviewRounds} round(s)). First finding: ${first.trim().slice(0, 240)}`,
        rule: 'If this finding class recurs, add a test or lint rule so the gate catches it before review (prefer a sensor over prose).',
        links: `PR #${issue.pr}`,
      });
    }
    if (issue.ciFixes) {
      lessons.push({
        slug: `ci-diverged-${issue.number}`,
        what: `Local gate was green on #${issue.number} but required CI failed ${issue.ciFixes} time(s).`,
        rule: 'Local gate and CI must run the same commands (.agents/gate.json). Find the divergence and close it.',
        links: `PR #${issue.pr}`,
      });
    }
  }
  return lessons;
}

export async function retro(ctx) {
  const { config, gh, run } = ctx;
  const lessons = lessonsFrom(run);
  ui.stage('RETRO', lessons.length ? `${lessons.length} lesson(s) for the shared memory (Law 9)` : 'nothing slipped past a gate this run — no lesson needed');
  if (!lessons.length) return null;
  const branch = `memory/${run.id}`.slice(0, 60);
  const path = join(config.worktreesDir, `memory-${run.id}`);
  await git.fetchOrigin(config.root);
  await git.addWorktree(config.root, { path, branch, from: `origin/${config.defaultBranch}` });
  try {
    const date = new Date().toISOString().slice(0, 10);
    const text = lessons.map((l) => `\n## ${date} — ${l.slug}\n\n- **What happened:** ${l.what}\n- **Fix / rule:** ${l.rule}\n- **Links:** ${l.links} · run \`${run.id}\`\n`).join('');
    appendFileSync(join(path, 'MEMORY.md'), text);
    await git.commitAll(path, `docs(memory): lessons from run ${run.id}`);
    await git.push(path, branch);
    const pr = await gh.createPr({
      title: `memory: lessons from ${run.state.plan?.title ?? run.id}`, head: branch, base: config.defaultBranch, draft: false,
      labels: ['memory-only'], body: `Memory-only change (AGENTS.md Law 4 exception: no product CI loop, no review gate).\n\n${text}`,
    });
    run.journal('RETRO', `lessons proposed in memory-only PR #${pr.number}`);
    ui.ok(`lessons recorded in memory-only PR #${pr.number} (auto-merges once its fast checks report)`);
    await must('gh', ['pr', 'merge', String(pr.number), '--squash', '--auto', '-R', config.repo], { timeoutSec: 60 }).catch(() => {
      ui.info(`auto-merge not enabled on the repo; merge PR #${pr.number} when its checks pass`);
    });
    return pr;
  } finally {
    await git.removeWorktree(config.root, path, branch);
  }
}
