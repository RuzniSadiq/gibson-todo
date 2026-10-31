// PLAN (stage 0): the cheapest place to be wrong. The planner drafts, the
// OWNER approves — silence never auto-approves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch, render } from '../lib/agents.mjs';
import { syncDetachedWorktree } from '../lib/git.mjs';
import { extractJson } from '../lib/jsonx.mjs';
import { scanInjectionInText } from '../lib/security.mjs';
import * as ui from '../lib/ui.mjs';
import { Park } from './errors.mjs';

const TIER_WORDS = {
  A: 'Tier A — routine (isolated command or wording); merges automatically after checks + independent review',
  B: 'Tier B — elevated (shared code); merges automatically after full-lens independent review',
  C: 'Tier C — sensitive (changes how your data is stored); comes back to YOU before it merges',
};

export function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') return ['no JSON plan found in the reply'];
  for (const key of ['title', 'operatorSummary', 'tier']) if (!plan[key]) problems.push(`missing "${key}"`);
  if (!['A', 'B', 'C'].includes(plan.tier)) problems.push('tier must be A, B or C');
  if (!Array.isArray(plan.deliverables) || plan.deliverables.length === 0) problems.push('no deliverables');
  for (const d of plan.deliverables ?? []) {
    if (!Array.isArray(d.acceptanceCriteria) || d.acceptanceCriteria.length === 0) problems.push(`deliverable ${d.id ?? '?'} has no acceptance criteria (Law 6)`);
  }
  return problems;
}

export function planMarkdown(plan, request) {
  const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  return [
    `# PLAN: ${plan.title}`,
    '', '## Owner request (verbatim)', '', `> ${request}`,
    '', '## Operator summary (contractual)', '', plan.operatorSummary,
    '', '## Problem', '', plan.problem ?? '', '', '## Users', '', plan.users ?? '',
    '', '## Scope', '', list(plan.scope), '', '## Non-scope', '', list(plan.nonScope),
    '', '## Architecture sketch', '', plan.architecture ?? '',
    '', '## Risks', '', list((plan.risks ?? []).map((r) => `**${r.likelihood ?? '?'}** — ${r.risk} → _${r.mitigation ?? ''}_`)),
    '', `## Tier: ${plan.tier}`, '', plan.tierReason ?? '',
    '', '## Deliverables', '',
    ...(plan.deliverables ?? []).flatMap((d) => [`### ${d.id} — ${d.name}`, '', ...d.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`), '']),
    '## Open questions (with proposed defaults)', '',
    list((plan.openQuestions ?? []).map((q) => `${q.question} → **default:** ${q.proposedDefault}`)),
    '', '## Try it afterwards', '', '```sh', ...(plan.demoCommands ?? []), '```',
  ].join('\n');
}

function showPlan(plan) {
  const { c } = ui;
  ui.banner(`PLAN · ${plan.title}`, TIER_WORDS[plan.tier]);
  console.log(`\n  ${c.bold('What you\'ll get')}`);
  for (const l of ui.wrap(plan.operatorSummary)) console.log(`    ${l}`);
  console.log(`\n  ${c.bold('Deliverables')}`);
  for (const d of plan.deliverables) {
    console.log(`    ${c.cyan(d.id)} ${c.bold(d.name)}`);
    d.acceptanceCriteria.forEach((a, i) => ui.wrap(a, 68).forEach((l, j) => console.log(`       ${j ? '  ' : `${i + 1}.`} ${l}`)));
  }
  if (plan.nonScope?.length) {
    console.log(`\n  ${c.bold('Not included')}`);
    for (const n of plan.nonScope) console.log(`    – ${n}`);
  }
  if (plan.risks?.length) {
    console.log(`\n  ${c.bold('Risks')}`);
    for (const r of plan.risks) console.log(`    ${r.likelihood === 'high' ? c.red('●') : r.likelihood === 'medium' ? c.yellow('●') : c.green('●')} ${r.risk} ${c.dim(`→ ${r.mitigation ?? ''}`)}`);
  }
  if (plan.openQuestions?.length) {
    console.log(`\n  ${c.bold('Decisions I made for you')} ${c.dim('(say "revise" to change any)')}`);
    for (const q of plan.openQuestions) console.log(`    ? ${q.question}\n      ${c.green('→')} ${q.proposedDefault}`);
  }
}

async function draft(ctx, request, revisionNote) {
  const { config, run } = ctx;
  await syncDetachedWorktree(config.root, config.snapshotDir, `origin/${config.defaultBranch}`);
  const template = readFileSync(join(config.snapshotDir, 'gibson/roles/planner.md'), 'utf8');
  const prompt = render(template, { request, revisionNote: revisionNote ? `## Owner feedback on the previous draft\n${revisionNote}` : '' });
  const role = config.routing.planner;
  const stop = ui.spinner(`${role.vendor} (${role.model || 'default'}) is drafting the plan`);
  const res = await dispatch({ role: 'planner', ...role, access: 'read', prompt, cwd: config.snapshotDir, timeoutSec: config.timeoutsSec.plan, runDir: run.dir });
  stop();
  if (!res.ok) throw new Park('blocked', `planner failed: ${res.error}`);
  const plan = extractJson(res.text);
  return { plan, problems: validatePlan(plan), res };
}

/** Returns the approved plan, or null if the owner cancelled. */
export async function planStage(ctx) {
  const { run, config } = ctx;
  const request = run.state.request;
  let note = run.state.revisionNote ?? '';
  for (let attempt = 0; attempt <= config.limits.planRevisions; attempt += 1) {
    ui.stage('PLAN', attempt ? 'Revising the plan with your feedback…' : 'The planner is reading the product and drafting a plan…');
    let { plan, problems, res } = await draft(ctx, request, note);
    if (problems.length) {
      ui.warn(`Plan failed validation (${problems.join('; ')}) — asking once more.`);
      ({ plan, problems, res } = await draft(ctx, request, `${note}\nYour previous reply was rejected by the harness: ${problems.join('; ')}. Return valid JSON.`));
      if (problems.length) throw new Park('blocked', `planner returned an invalid plan twice: ${problems.join('; ')}`);
    }
    const injection = scanInjectionInText(JSON.stringify(plan), 'plan');
    if (injection.length) throw new Park('halt', `prompt-injection markers in the planner output (${injection.map((i) => i.kind).join(', ')})`, 'G16');

    run.state.plan = plan;
    run.artifact('PLAN.md', planMarkdown(plan, request));
    run.journal('PLAN', `Planner (${res.vendor}/${res.model}) drafted "${plan.title}" — Tier ${plan.tier}, ${plan.deliverables.length} deliverable(s) in ${Math.round(res.durationMs / 1000)}s`);
    showPlan(plan);

    if (!ctx.interactive) {
      run.state.phase = 'plan';
      run.save();
      throw new Park('awaiting-owner', `plan drafted; approve it with: bin/gibson resume ${run.id}`, 'G10');
    }
    ui.askContract({
      title: 'YOUR DECISION',
      asking: 'Approve this plan so the fleet can start building it?',
      does: 'I break it into GitHub issues, build each on its own branch, have a different AI vendor review every change at its exact version, and merge it per its risk tier.',
      why: 'Changing a plan costs seconds; changing shipped code costs hours. This is the cheapest moment to steer.',
      risks: `Low. Nothing merges without passing tests and an independent review.${plan.tier === 'C' ? ' Tier C parts come back to you before merging.' : ''} Every change is a separate PR that can be reverted.`,
    });
    const answer = (await ui.prompt('[a]pprove · [r]evise · [c]ancel ›')).toLowerCase();
    if (answer.startsWith('a') || answer === 'y' || answer === 'yes') {
      run.state.approval = { at: new Date().toISOString(), by: 'owner (interactive terminal)', attempt };
      run.journal('PLAN', 'Owner APPROVED the plan (human gate, recorded)');
      return plan;
    }
    if (answer.startsWith('c')) {
      run.journal('PLAN', 'Owner cancelled the request');
      return null;
    }
    note = await ui.prompt('What should change?');
    run.journal('PLAN', `Owner asked for a revision: "${note}"`);
  }
  throw new Park('awaiting-owner', 'plan revision limit reached — start a new request with a clearer brief', 'G10');
}

export async function createEpic(ctx, plan) {
  const { gh, run } = ctx;
  const body = [
    planMarkdown(plan, run.state.request),
    '', '---', '## Approval record',
    `Approved by the owner at ${run.state.approval.at} (${run.state.approval.by}). Gibson run \`${run.id}\`.`,
    '', '## Issues', '', '_Filled in by the decomposer._',
  ].join('\n');
  const epic = await gh.createIssue({ title: `Plan: ${plan.title}`, body, labels: ['gibson:plan'] });
  run.state.epic = epic;
  run.journal('PLAN', `Approved plan recorded as epic issue #${epic.number}`);
  ui.ok(`Plan recorded on GitHub as issue #${epic.number} ${ui.c.dim(epic.url)}`);
  return epic;
}
