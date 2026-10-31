// BUILD → TEST → REVIEW → UX-EVAL → SECURITY → MERGE → DEPLOY+VERIFY for ONE issue.
// The harness, not the builder, decides what is true: it re-runs the gate,
// the contract sensor, the tier classifier and the security layers itself.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from '../lib/agents.mjs';
import { evaluateContract, runTapTests } from '../lib/contract.mjs';
import { OWNER_MARKER, evaluateEvidence } from '../lib/evidence.mjs';
import { must, run as exec } from '../lib/exec.mjs';
import { newFailures, runGate } from '../lib/gate.mjs';
import * as git from '../lib/git.mjs';
import { matchesAny, scopesOverlap } from '../lib/glob.mjs';
import { extractJson } from '../lib/jsonx.mjs';
import { dependencyChanges, scanInjectionInDiff, scanInjectionInText, scanSecrets } from '../lib/security.mjs';
import { assessTier } from '../lib/tier.mjs';
import * as ui from '../lib/ui.mjs';
import { Park } from './errors.mjs';
import { reviewRound, uxEval } from './review.mjs';

const ALWAYS_ALLOWED = ['test/**', 'README.md'];
const base = (config) => `origin/${config.defaultBranch}`;

export function haltCheck(config) {
  if (process.env.GIBSON_HALT === '1') throw new Park('halt', 'GIBSON_HALT=1 is set — kill switch');
  if (existsSync(config.haltFile)) throw new Park('halt', `kill switch file present: ${config.haltFile} (${readFileSync(config.haltFile, 'utf8').trim()})`);
}

// ── CLAIM (Law 2) ────────────────────────────────────────────────────────────
export function claimsFromPrs(prs) {
  return prs.flatMap((pr) => {
    const m = /^- Active-work claim: issue-(\d+) scope=(\S+)/m.exec(pr.body ?? '');
    return m ? [{ pr: pr.number, issue: Number(m[1]), scope: m[2].split(',') }] : [];
  });
}

async function claim(ctx, issue) {
  const { config, gh, run } = ctx;
  ui.stage('CLAIM', `#${issue.number} ${issue.title}`);
  const live = claimsFromPrs(await gh.openPrs()).filter((c) => c.issue !== issue.number);
  const mine = issue.affectedArea.filter((g) => !ALWAYS_ALLOWED.includes(g));
  for (const other of live) {
    const clash = mine.find((g) => other.scope.filter((s) => !ALWAYS_ALLOWED.includes(s)).some((s) => scopesOverlap(g, s)));
    if (clash) throw new Park('blocked', `claim overlap: open PR #${other.pr} (issue #${other.issue}) already holds ${clash} — coordinate, never race`, 'G13');
  }
  await gh.editIssue(issue.number, { addLabels: ['agent-claimed'] });
  issue.branch = `gibson/${issue.number}-${run.id.split('-').slice(2).join('-').slice(0, 24) || 'work'}`;
  issue.worktree = join(config.worktreesDir, `issue-${issue.number}`);
  await git.fetchOrigin(config.root);
  await git.addWorktree(config.root, { path: issue.worktree, branch: issue.branch, from: base(config) });
  await git.git(issue.worktree, ['commit', '--quiet', '--allow-empty', '-s', '-m', `chore(#${issue.number}): claim`]);
  await git.push(issue.worktree, issue.branch);
  const pr = await gh.createPr({
    title: `feat(#${issue.number}): ${issue.title}`, head: issue.branch, base: config.defaultBranch, draft: true,
    labels: [`tier:${issue.tier}`], body: prBody(ctx, issue),
  });
  issue.pr = pr.number;
  issue.prUrl = pr.url;
  issue.status = 'claimed';
  run.journal('CLAIM', `#${issue.number} claimed: worktree ${issue.worktree}, branch ${issue.branch}, draft PR #${pr.number}`);
  ui.ok(`Claimed: label agent-claimed, own worktree + branch, draft PR #${pr.number} carries the claim`);
}

// ── BUILD ────────────────────────────────────────────────────────────────────
async function prepareWorktree(ctx, issue) {
  ui.info('installing dependencies and recording the green-gate baseline at the branch point…');
  await must('bash', ['-c', ctx.config.commands.install], { cwd: issue.worktree, timeoutSec: 600 });
  await must(process.execPath, ['scripts/gate.mjs', '--baseline'], { cwd: issue.worktree, timeoutSec: ctx.config.timeoutsSec.gate });
  issue.baseline = JSON.parse(readFileSync(join(issue.worktree, '.gibson-baseline.json'), 'utf8'));
  const red = issue.baseline.steps.filter((s) => s.status === 'fail').map((s) => s.name);
  if (red.length) ui.warn(`branch point already fails: ${red.join(', ')} (recorded — not inherited, not hidden)`);
}

async function builder(ctx, issue, extra, label) {
  const { config, run, gh } = ctx;
  const role = config.routing.builder;
  const body = (await gh.issue(issue.number)).body;
  const injection = scanInjectionInText(body, `issue #${issue.number}`);
  if (injection.length) throw new Park('halt', `prompt-injection markers in issue #${issue.number} (${injection.map((i) => `${i.kind} line ${i.line}`).join(', ')})`, 'G16');
  const template = readFileSync(join(config.root, 'gibson/roles/builder.md'), 'utf8');
  const prompt = render(template, {
    worktree: issue.worktree, branch: issue.branch, issueNumber: issue.number, issueTitle: issue.title,
    tier: issue.finalTier ?? issue.tier, issueBody: body, extra: extra ?? '',
    affectedArea: issue.affectedArea.map((g) => `\`${g}\``).join(', '),
    acIds: issue.acs.map((a) => a.id).join(', '), firstAc: issue.acs[0].id,
  });
  const before = await git.headSha(issue.worktree);
  const stop = ui.spinner(`${role.vendor} (${role.model}) ${label}`);
  const res = await ctx.dispatch({ role: 'builder', ...role, access: 'edit', prompt, cwd: issue.worktree, timeoutSec: extra ? config.timeoutsSec.fix : config.timeoutsSec.build, runDir: run.dir });
  stop();
  if (!res.ok) throw new Park('blocked', `builder failed: ${res.error}`);
  if ((await git.headSha(issue.worktree)) !== before) throw new Park('blocked', 'builder created a commit itself — forbidden (only the harness commits, after verification)');
  const changed = await git.workingChanges(issue.worktree);
  if (!changed.length) throw new Park('blocked', 'builder finished without changing any file (a no-op diff never ships)');
  issue.builderReport = extractJson(res.text) ?? { summary: res.text.slice(-800) };
  run.journal('BUILD', `${role.vendor}/${res.model} ${label}: ${changed.length} file(s) in ${Math.round(res.durationMs / 1000)}s`);
  ui.ok(`${role.vendor} changed ${changed.length} file(s) in ${Math.round(res.durationMs / 1000)}s: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', …' : ''}`);
}

// ── VERIFY: gate + contract + scope/tier, run by the harness itself ──────────
async function verify(ctx, issue) {
  const { config, run } = ctx;
  for (let attempt = 0; ; attempt += 1) {
    ui.stage('GATE', `typecheck → lint → test → build, re-run independently by the harness${attempt ? ` (fix attempt ${attempt})` : ''}`);
    const stop = ui.spinner('running the green gate');
    const gate = await runGate(issue.worktree, { timeoutSec: config.timeoutsSec.gate });
    stop();
    const fresh = newFailures(issue.baseline, gate);
    const tap = fresh.length ? null : await runTapTests(issue.worktree, config.testGlobs);
    const contract = tap ? evaluateContract(issue.acs.map((a) => a.id), tap.tests) : null;
    if (!fresh.length && contract && !contract.unmet.length) {
      issue.gate = gate;
      issue.contract = contract;
      issue.testCount = tap.summary.tests;
      ui.ok(`gate GREEN — ${gate.steps.filter((s) => s.status === 'pass').map((s) => s.name).join(' ✓ ')} ✓ · ${tap.summary.tests} tests, zero new failures vs. branch point`);
      ui.ok(`contract MET — ${contract.met.length}/${issue.acs.length} criteria each proven by a passing tagged test`);
      run.journal('GATE', `green; contract ${contract.met.length}/${issue.acs.length}; ${tap.summary.tests} tests`);
      return;
    }
    const problem = fresh.length
      ? fresh.map((f) => `Gate step "${f.step}" — ${f.reason}\n\`\`\`\n${f.tail}\n\`\`\``).join('\n\n')
      : `Contract sensor: these criteria have no passing test tagged with their id:\n${contract.unmet.map((u) => `- ${u.id}${u.failing.length ? ` (failing: ${u.failing.join('; ')})` : ' (no test carries the tag)'}`).join('\n')}`;
    run.journal('GATE', `red (attempt ${attempt + 1}): ${problem.split('\n')[0]}`);
    if (attempt >= config.limits.gateFixAttempts) throw new Park('blocked', `green gate still red after ${attempt} fix attempt(s):\n${problem.slice(0, 3000)}`);
    ui.warn(problem.split('\n')[0]);
    await builder(ctx, issue, `## The harness re-ran the gate and it is NOT green. Fix this (verbatim output):\n${problem.slice(0, 8000)}`, 'is fixing the gate failure');
  }
}

async function assessScopeAndTier(ctx, issue) {
  const { config, run, gh } = ctx;
  const files = await git.workingChanges(issue.worktree);
  const allPaths = [...new Set([...(await git.changedFiles(issue.worktree, base(config))), ...files])];
  const outside = allPaths.filter((p) => !matchesAny(p, [...issue.affectedArea, ...ALWAYS_ALLOWED]));
  const numstat = await git.git(issue.worktree, ['diff', '--numstat', base(config)]);
  const untracked = (await git.git(issue.worktree, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const lines = numstat.split('\n').filter(Boolean).reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0)
    + untracked.reduce((n, f) => n + readFileSync(join(issue.worktree, f), 'utf8').split('\n').length, 0);
  const assessment = assessTier({ paths: allPaths, size: { files: allPaths.length, lines }, declared: issue.tier }, config);
  issue.scopeOutside = outside;
  if (outside.length) {
    ui.warn(`outside the claimed area: ${outside.join(', ')} — flagged to the reviewer`);
    issue.notes.push(`Builder touched files outside the claimed area: ${outside.join(', ')}`);
  }
  if (assessment.undeclaredTierC && !issue.tierCAccepted) {
    const why = assessment.reasons.filter((r) => r.tier === 'C').map((r) => `${r.path} (${r.why})`).join('; ');
    run.journal('GATE_HUMAN', `G11: undeclared Tier C surface: ${why}`);
    if (!ctx.interactive) throw new Park('awaiting-owner', `work drifted into an undeclared Tier C surface: ${why}`, 'G11');
    ui.askContract({
      title: 'HUMAN GATE G11 — scope grew into a sensitive area',
      asking: `Let #${issue.number} continue as Tier C (sensitive), or stop it here?`,
      does: 'Continuing upgrades the change to the strictest path: multi-pass adversarial review, and it comes back to you before merging.',
      why: `It was planned as Tier ${issue.tier}, but the builder had to touch: ${why}.`,
      risks: 'Continuing is safe — the stricter gates apply. Stopping leaves the PR parked; nothing merges.',
    });
    const answer = (await ctx.prompt('[c]ontinue as Tier C · [s]top ›')).toLowerCase();
    if (!answer.startsWith('c')) throw new Park('awaiting-owner', 'owner stopped the lane at G11 (undeclared Tier C surface)', 'G11');
    issue.tierCAccepted = true;
    run.journal('GATE_HUMAN', 'Owner accepted Tier C upgrade');
  }
  if (assessment.tier !== (issue.finalTier ?? issue.tier)) {
    ui.info(`tier re-checked from the actual diff: ${issue.finalTier ?? issue.tier} → ${assessment.tier} (${assessment.reasons.map((r) => r.path).slice(0, 3).join(', ') || `${allPaths.length} files / ${lines} lines`})`);
  }
  const previous = issue.finalTier;
  issue.finalTier = assessment.tier;
  issue.tierAssessment = assessment;
  if (issue.pr && previous !== assessment.tier) {
    const stale = ['A', 'B', 'C'].filter((t) => t !== assessment.tier).map((t) => `tier:${t}`);
    await gh.editPr(issue.pr, { addLabels: [`tier:${assessment.tier}`], removeLabels: stale }).catch(() => {});
  }
}

// ── SECURITY layers (local, deterministic) ───────────────────────────────────
async function security(ctx, issue) {
  const { config, run } = ctx;
  ui.stage('SECURITY', 'L1 secrets · L3 supply chain · L7 prompt-injection in the diff');
  const diff = await git.diff(issue.worktree, base(config));
  const secrets = scanSecrets(diff);
  if (secrets.length) throw new Park('awaiting-owner', `secret-like strings in the diff: ${secrets.map((s) => `${s.file}:${s.line} (${s.kind})`).join(', ')} — confirmed leak response is a human gate`, 'G4');
  const injection = scanInjectionInDiff(diff);
  if (injection.length) throw new Park('halt', `prompt-injection markers planted in the diff: ${injection.map((s) => `${s.file}:${s.line} (${s.kind})`).join(', ')}`, 'G16');
  const before = await exec('git', ['show', `${base(config)}:package.json`], { cwd: issue.worktree });
  const deps = dependencyChanges(before.stdout, readFileSync(join(issue.worktree, 'package.json'), 'utf8'));
  const runtime = deps.filter((d) => d.field === 'dependencies' && d.change === 'added');
  if (runtime.length) throw new Park('blocked', `new runtime dependency added (${runtime.map((d) => d.name).join(', ')}) — package.json is a hot file; no casual deps`);
  const report = [
    'L1 secrets: clean', `L3 supply chain: ${deps.length ? deps.map((d) => `${d.change} ${d.field}.${d.name}`).join(', ') : 'no dependency changes'}`,
    'L7 prompt-injection markers in diff: none',
  ];
  issue.securityReport = report;
  for (const r of report) ui.ok(r);
  run.journal('SECURITY', report.join(' · '));
}

// ── COMMIT / PR ──────────────────────────────────────────────────────────────
export function prBody(ctx, issue) {
  const { config } = ctx;
  const g = issue.gate;
  const contractRows = (issue.contract?.rows ?? []).map((r) => {
    const ac = issue.acs.find((a) => a.id === r.id);
    return `- [${r.met ? 'x' : ' '}] ${r.id} — ${ac?.text ?? ''}${r.tests.length ? `  \n  ↳ _${r.tests[0]}_` : ''}`;
  });
  const t = issue.tierAssessment;
  return [
    `## What this does`, '', issue.builderReport?.summary ?? issue.summary, '',
    `Closes #${issue.number}`, '',
    '## Sprint contract (ticked only by the contract sensor)', '',
    ...(contractRows.length ? contractRows : issue.acs.map((a) => `- [ ] ${a.id} — ${a.text}`)), '',
    '## Gibson evidence', '',
    '| Stage | Result |', '|---|---|',
    `| Green gate | ${g ? `${g.steps.map((s) => `${s.name} ${s.status === 'pass' ? '✓' : s.status}`).join(' · ')} — ${issue.testCount} tests, zero new failures vs. branch point` : 'pending'} |`,
    `| Contract | ${issue.contract ? `${issue.contract.met.length}/${issue.acs.length} criteria met by passing tagged tests` : 'pending'} |`,
    `| Tier | ${t ? `**${t.tier}** (declared ${t.declared}; paths → ${t.byPath}; size → ${t.bySize})` : issue.tier} |`,
    `| Security | ${issue.securityReport ? issue.securityReport.join(' · ') : 'pending'} |`,
    `| Scope | ${issue.scopeOutside?.length ? `⚠ outside claim: ${issue.scopeOutside.join(', ')}` : 'within claimed area'} |`,
    '',
    ...(issue.builderReport?.notes ? ['## Builder notes', '', String(issue.builderReport.notes), ''] : []),
    '---',
    `- Active-work claim: issue-${issue.number} scope=${issue.affectedArea.join(',')} builder=${config.routing.builder.vendor}`,
    `Builder-Vendor: ${config.routing.builder.vendor}`,
    `Builder-Model: ${config.routing.builder.model || 'default'}`,
    `Gibson-Run: ${ctx.run.id}`,
  ].join('\n');
}

async function commitAndPush(ctx, issue, subject) {
  const { config, gh, run } = ctx;
  const message = `${subject}\n\n${issue.builderReport?.summary ?? ''}\n\nRefs #${issue.number}\nGibson-Builder: ${config.routing.builder.vendor}/${config.routing.builder.model}\nGibson-Run: ${run.id}`;
  issue.headSha = await git.commitAll(issue.worktree, message);
  // Rebase onto the latest default branch in OUR worktree before pushing.
  await git.fetchOrigin(issue.worktree);
  const behind = Number((await git.git(issue.worktree, ['rev-list', '--count', `HEAD..${base(config)}`])).trim());
  if (behind > 0) {
    const r = await exec('git', ['rebase', '--quiet', base(config)], { cwd: issue.worktree });
    if (r.code !== 0) {
      await exec('git', ['rebase', '--abort'], { cwd: issue.worktree });
      throw new Park('blocked', `rebase onto ${base(config)} conflicts:\n${r.stderr.slice(-1500)}`);
    }
    issue.headSha = await git.headSha(issue.worktree);
    await git.git(issue.worktree, ['push', '--quiet', '--force-with-lease', 'origin', issue.branch]); // own lane branch, never shared (G3)
  } else await git.push(issue.worktree, issue.branch);
  await gh.editPr(issue.pr, { body: prBody(ctx, issue) });
  run.journal('BUILD', `committed + pushed ${issue.headSha.slice(0, 7)} (signed-off)`);
  ui.ok(`committed ${issue.headSha.slice(0, 7)} with Signed-off-by, pushed, PR #${issue.pr} evidence table updated`);
}

function sensorReport(issue) {
  return [
    `- Green gate: ${issue.gate.steps.map((s) => `${s.name}=${s.status}`).join(', ')}; ${issue.testCount} tests; zero new failures vs. branch point.`,
    `- Contract sensor: ${issue.contract.rows.map((r) => `${r.id} ${r.met ? 'MET' : 'UNMET'} by "${r.tests[0] ?? '-'}"`).join('; ')}`,
    `- Tier classifier: ${issue.tierAssessment.tier} (declared ${issue.tierAssessment.declared}); ${issue.tierAssessment.reasons.map((r) => `${r.path}=${r.tier}`).join(', ') || 'all paths tier A'}`,
    `- Security: ${issue.securityReport.join('; ')}`,
    issue.scopeOutside?.length ? `- ⚠ Files outside the claimed area: ${issue.scopeOutside.join(', ')} — judge whether justified.` : '- Scope: within claimed area.',
  ].join('\n');
}

async function fixRound(ctx, issue, why, feedback) {
  await builder(ctx, issue, `## ${why}\nAddress every blocker below, then re-run \`npm run gate\`.\n\n${feedback.slice(0, 10000)}`, `is addressing: ${why.toLowerCase()}`);
  await verify(ctx, issue);
  await assessScopeAndTier(ctx, issue);
  await commitAndPush(ctx, issue, `fix(#${issue.number}): ${why.toLowerCase()}`);
}

// ── CI ───────────────────────────────────────────────────────────────────────
async function waitForChecks(ctx, issue, { allowPendingEvidence }) {
  const { config, gh, run } = ctx;
  ui.stage('MERGE', `waiting for required CI checks on ${issue.headSha.slice(0, 7)}: ${config.requiredChecks.join(', ')}`);
  const deadline = Date.now() + config.timeoutsSec.ci * 1000;
  const stop = ui.spinner('GitHub Actions running the same sensors from the base branch');
  try {
    for (;;) {
      const checks = await gh.checksForSha(issue.headSha);
      const byName = new Map(checks.map((c) => [c.name, c]));
      const required = config.requiredChecks.map((name) => byName.get(name) ?? { name, state: 'pending' });
      const failed = required.filter((c) => c.state === 'fail' && !(allowPendingEvidence && c.name === 'gibson/review-evidence'));
      const pending = required.filter((c) => c.state === 'pending' && !(allowPendingEvidence && c.name === 'gibson/review-evidence'));
      if (failed.length) return { ok: false, failed, required };
      if (!pending.length) return { ok: true, required };
      if (Date.now() > deadline) throw new Park('blocked', `CI did not finish within ${config.timeoutsSec.ci}s (pending: ${pending.map((p) => p.name).join(', ')})`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  } finally {
    stop();
    run.save();
  }
}

// ── MERGE by tier ────────────────────────────────────────────────────────────
async function evidenceFor(ctx, issue) {
  const { gh, config } = ctx;
  const pr = await gh.pr(issue.pr);
  const comments = await gh.prComments(issue.pr);
  return { pr, verdict: evaluateEvidence({ headSha: pr.headRefOid, labels: pr.labels.map((l) => l.name), body: pr.body, files: pr.files.map((f) => f.path), comments }, config) };
}

export async function ownerApprovalGate(ctx, issue) {
  const { run, gh } = ctx;
  const t = issue.tierAssessment;
  const why = t?.reasons?.filter((r) => r.tier === 'C').map((r) => r.why).join('; ') || 'Tier C surface';
  ui.askContract({
    title: 'HUMAN GATE G12 — Tier C merge needs you',
    asking: `Approve merging PR #${issue.pr} "${issue.title}"?`,
    does: `Merges it into main and ships it. It changes a sensitive area: ${why}.`,
    why: `It passed: green gate, ${issue.contract.met.length}/${issue.acs.length} contract criteria, security layers, and a cross-vendor FAN-OUT + adversarial review at this exact version (${issue.headSha.slice(0, 7)}).`,
    risks: 'Storage changes are additive with a migration, so existing task files keep working. Low likelihood of trouble; if it happens, the merge can be reverted as a single commit.',
  });
  ui.info(`review it yourself: ${issue.prUrl}`);
  if (!ctx.interactive) return false;
  const answer = (await ctx.prompt('[y]es, approve & merge · [o]pen the PR in a browser first · [n]o, park it ›')).toLowerCase();
  if (answer.startsWith('o')) {
    await gh.openInBrowser(issue.pr);
    return ownerApprovalGate(ctx, issue);
  }
  if (!answer.startsWith('y')) return false;
  const login = await gh.viewer();
  await gh.commentPr(issue.pr, [
    OWNER_MARKER, `## 🧑‍💼 Owner approval (E4)`, '',
    `Owner-Approval: ${issue.headSha}`, `Approved-By: ${login}`,
    '', `Approved interactively in the owner's terminal at ${new Date().toISOString()} after reviewing the Ask Contract summary. Bound to the exact head \`${issue.headSha.slice(0, 7)}\` — any new push invalidates it.`,
  ].join('\n'));
  run.journal('GATE_HUMAN', `Owner approved Tier C PR #${issue.pr} at ${issue.headSha.slice(0, 7)}`);
  return true;
}

async function merge(ctx, issue) {
  const { gh, run } = ctx;
  if (issue.finalTier === 'C' && !issue.ownerApproved) {
    const approved = await ownerApprovalGate(ctx, issue);
    if (!approved) {
      await gh.editPr(issue.pr, { addLabels: ['gibson:awaiting-owner'] });
      await gh.commentPr(issue.pr, `⏸️ **Parked at human gate G12** (Tier C). Everything automated has passed. To approve, the owner runs:\n\n\`\`\`\nbin/gibson approve ${issue.pr}\n\`\`\``);
      throw new Park('awaiting-owner', `Tier C PR #${issue.pr} is waiting for your approval — run: bin/gibson approve ${issue.pr}`, 'G12');
    }
    issue.ownerApproved = issue.headSha;
    run.save();
    const ci = await waitForChecks(ctx, issue, { allowPendingEvidence: false });
    if (!ci.ok) throw new Park('blocked', `checks failed after owner approval: ${ci.failed.map((f) => `${f.name}${f.description ? ` (${f.description})` : ''}`).join(', ')}`);
  }
  const { pr, verdict } = await evidenceFor(ctx, issue);
  if (pr.headRefOid !== issue.headSha) throw new Park('blocked', `head moved from ${issue.headSha.slice(0, 7)} to ${pr.headRefOid.slice(0, 7)} — stale review cannot be reused`);
  if (verdict.state !== 'success') throw new Park('blocked', `review evidence not satisfied: ${verdict.description}`);
  const { signoff } = await git.identity(issue.worktree);
  await gh.squashMerge(issue.pr, {
    subject: `feat(#${issue.number}): ${issue.title} (#${issue.pr})`,
    body: `${issue.builderReport?.summary ?? issue.summary}\n\nCloses #${issue.number}\nTier: ${issue.finalTier} · Review: ${verdict.description}\nGibson-Run: ${run.id}\n\n${signoff}`,
    headSha: issue.headSha,
  });
  issue.status = 'merged';
  issue.mergedAt = new Date().toISOString();
  run.journal('MERGE', `PR #${issue.pr} squash-merged at ${issue.headSha.slice(0, 7)} (Tier ${issue.finalTier}; ${verdict.description})`);
  ui.ok(`MERGED PR #${issue.pr} — ${issue.finalTier === 'C' ? 'owner-approved Tier C' : `Tier ${issue.finalTier}: checks + independent review = authorization`} · ${verdict.description}`);
}

// ── DEPLOY + VERIFY, then CLEANUP (Law 10) ───────────────────────────────────
export async function deployAndVerify(ctx, label = 'main') {
  const { config, run } = ctx;
  ui.stage('DEPLOY', `building the merged ${label} into the release directory and smoke-testing it`);
  await git.fetchOrigin(config.root);
  await git.syncDetachedWorktree(config.root, config.releaseDir, base(config));
  await must('bash', ['-c', config.commands.install], { cwd: config.releaseDir, timeoutSec: 600 });
  await must('bash', ['-c', config.commands.build], { cwd: config.releaseDir, timeoutSec: 300 });
  const sandbox = mkdtempSync(join(tmpdir(), 'gibson-smoke-'));
  try {
    const env = { TODO_FILE: join(sandbox, 'tasks.json'), NO_COLOR: '1' };
    const bin = join(config.releaseDir, config.commands.bin);
    const step = (args) => must(process.execPath, [bin, ...args], { env, timeoutSec: 30 });
    const version = (await step(['--version'])).trim();
    await step(['add', 'Gibson smoke test']);
    const listed = JSON.parse(await step(['list', '--json']));
    if (listed[0]?.title !== 'Gibson smoke test') throw new Error('smoke test: added task not listed');
    await step(['done', '1']);
    await step(['help']);
    const sha = (await git.headSha(config.releaseDir)).slice(0, 7);
    run.journal('DEPLOY', `release ${version} @ ${sha} built and smoke-tested`);
    ui.ok(`release v${version} @ ${sha} built · smoke test passed (add → list --json → done → help)`);
    return { version, sha };
  } catch (error) {
    run.journal('DEPLOY', `smoke test FAILED: ${error.message}`);
    throw new Park('halt', `post-merge smoke test failed on main — stopping the fleet before more merges: ${error.message}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

export async function cleanup(ctx, issue) {
  const { config, gh, run } = ctx;
  ui.stage('RETRO', `cleaning up #${issue.number}: worktree, branch, claim`);
  await git.removeWorktree(config.root, issue.worktree, issue.branch);
  await exec('git', ['push', '--quiet', 'origin', '--delete', issue.branch], { cwd: config.root });
  await gh.editIssue(issue.number, { removeLabels: ['agent-claimed'] }).catch(() => {});
  const state = (await gh.issue(issue.number)).state;
  if (state !== 'CLOSED') await gh.closeIssue(issue.number, `Delivered in #${issue.pr}.`);
  issue.status = 'done';
  run.journal('RETRO', `#${issue.number} cleaned up: worktree removed, branch deleted, claim released, issue closed`);
  ui.ok('worktree removed · branch deleted · claim released · issue closed');
}

// ── The lane ─────────────────────────────────────────────────────────────────
export async function deliverIssue(ctx, issue) {
  const { config, run } = ctx;
  const save = () => run.save();
  haltCheck(config);
  ui.banner(`#${issue.number} · ${issue.title}`, `Tier ${issue.finalTier ?? issue.tier} · ${issue.acs.length} acceptance criteria · ${issue.prUrl ?? issue.url}`);

  if (!issue.pr) { await claim(ctx, issue); save(); }
  if (!issue.headSha) {
    if (!issue.baseline) await prepareWorktree(ctx, issue);
    ui.stage('BUILD', `${config.routing.builder.vendor} implements the issue in its own worktree (cannot commit, push or merge)`);
    await builder(ctx, issue, '', 'is implementing');
    await verify(ctx, issue);
    await assessScopeAndTier(ctx, issue);
    await security(ctx, issue);
    await commitAndPush(ctx, issue, `feat(#${issue.number}): ${issue.title}`);
    await ctx.gh.markReady(issue.pr);
    issue.status = 'in-review';
    save();
  }

  const caps = config.limits;
  if (issue.status === 'in-review') {
    for (;;) {
      haltCheck(config);
      if (!issue.securityReport) await security(ctx, issue);
      issue.sensorReport = sensorReport(issue);
      const review = await reviewRound(ctx, issue);
      save();
      if (review.verdict === 'REQUEST_CHANGES') {
        if (issue.reviewRounds > caps.reviewRounds[issue.finalTier]) {
          throw new Park('blocked', `review round cap (${caps.reviewRounds[issue.finalTier]} fix rounds for Tier ${issue.finalTier}) reached; latest findings:\n${review.findingsText.slice(0, 2500)}`);
        }
        issue.securityReport = null;
        await fixRound(ctx, issue, `Reviewer requested changes (round ${issue.reviewRounds})`, review.findingsText);
        continue;
      }
      const ux = await uxEval(ctx, issue);
      if (!ux.pass) {
        if (issue.uxRounds >= caps.uxFixRounds) throw new Park('blocked', `UX evaluation still below the bar (${ux.score}/5): ${(ux.findings ?? []).join('; ')}`);
        issue.uxRounds += 1;
        issue.securityReport = null;
        await fixRound(ctx, issue, `UX evaluator found problems in the live CLI (score ${ux.score}/5)`, (ux.findings ?? []).map((f) => `- ${f}`).join('\n'));
        continue;
      }
      const ci = await waitForChecks(ctx, issue, { allowPendingEvidence: issue.finalTier === 'C' });
      if (!ci.ok) {
        const names = ci.failed.map((f) => `${f.name}${f.description ? ` (${f.description})` : ''}`).join(', ');
        run.journal('MERGE', `CI failed: ${names}`);
        if (issue.ciFixes >= caps.ciFixAttempts || ci.failed.every((f) => f.name === 'gibson/review-evidence')) throw new Park('blocked', `required checks failed: ${names}`);
        issue.ciFixes += 1;
        issue.securityReport = null;
        ui.warn(`CI failed (${names}) — sending the log to the builder`);
        await fixRound(ctx, issue, `CI failed: ${names}`, await ctx.gh.failedRunLog(issue.headSha));
        continue;
      }
      ui.ok(`all required checks green: ${ci.required.filter((c) => c.state === 'pass').map((c) => c.name).join(', ')}`);
      issue.status = 'ready-to-merge';
      save();
      break;
    }
  }
  if (issue.status === 'ready-to-merge') { await merge(ctx, issue); save(); }
  if (issue.status === 'merged') {
    issue.release = await deployAndVerify(ctx, `#${issue.number}`);
    await cleanup(ctx, issue);
    save();
  }
}
