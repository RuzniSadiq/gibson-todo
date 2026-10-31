// The Gibson pipeline for this repo:
//   plan → decompose → build → test → review → ux-eval → security → merge → deploy → retro
// Owner interruptions happen ONLY at AGENTS.md human gates (plan approval G10,
// scope growth G11, Tier C merge G12, secrets G4, injection G16).
import { writeFileSync } from 'node:fs';
import { loadConfig, validateRouting } from './lib/config.mjs';
import { run as exec } from './lib/exec.mjs';
import { GitHub } from './lib/github.mjs';
import { Run } from './lib/run-state.mjs';
import * as ui from './lib/ui.mjs';
import { decomposeStage } from './stages/decompose.mjs';
import { deliverIssue, haltCheck } from './stages/deliver.mjs';
import { Park } from './stages/errors.mjs';
import { createEpic, planStage } from './stages/plan.mjs';
import { retro } from './stages/retro.mjs';

export function context(run, overrides = {}) {
  const config = loadConfig();
  return { config, run, gh: new GitHub(config.repo), interactive: ui.isInteractive(), ...overrides };
}

/** Preflight: refuse to start a run that could not finish honestly. */
export async function doctor(config, { quiet = false } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  for (const problem of validateRouting(config)) add('routing (Law 5)', false, problem);
  if (!validateRouting(config).length) add('routing (Law 5)', true, `builder=${config.routing.builder.vendor}, reviewer=${config.routing.reviewer.vendor}, ux=${config.routing.uxEvaluator.vendor}/${config.routing.uxEvaluator.model}`);
  const vendors = [...new Set(Object.values(config.routing).filter((r) => r?.vendor).map((r) => r.vendor))];
  for (const v of vendors) {
    const r = await exec(v, ['--version'], { timeoutSec: 30 });
    add(`runner: ${v}`, r.code === 0, r.code === 0 ? r.stdout.trim().split('\n')[0] : 'not installed or not on PATH');
  }
  const auth = await exec('gh', ['auth', 'status'], { timeoutSec: 30 });
  add('GitHub auth', auth.code === 0, auth.code === 0 ? 'gh is authenticated' : (auth.stderr || auth.stdout).trim().split('\n')[0]);
  const repo = await exec('gh', ['repo', 'view', config.repo, '--json', 'name'], { timeoutSec: 30 });
  add('repository', repo.code === 0, config.repo);
  const prot = await exec('gh', ['api', `repos/${config.repo}/branches/${config.defaultBranch}/protection`], { timeoutSec: 30 });
  add('branch protection', prot.code === 0, prot.code === 0 ? `${config.defaultBranch} is protected (required checks enforced by GitHub)` : 'not applied — run: bash scripts/apply-branch-protection.sh (owner step)');
  try { haltCheck(config); add('kill switch', true, 'not engaged'); } catch (e) { add('kill switch', false, e.message); }
  if (!quiet) {
    ui.banner('Gibson doctor', config.repo);
    for (const c of checks) (c.ok ? ui.ok : ui.fail)(`${c.name.padEnd(18)} ${ui.c.dim(c.detail)}`);
  }
  const fatal = checks.filter((c) => !c.ok && c.name !== 'branch protection');
  return { ok: fatal.length === 0, checks };
}

function report(ctx, park, issue) {
  const { run } = ctx;
  const where = issue ? `#${issue.number}` : 'run';
  if (issue) {
    issue.status = park.kind === 'awaiting-owner' ? 'awaiting-owner' : park.kind === 'halt' ? 'halted' : 'blocked';
    issue.parkReason = park.message;
  }
  run.journal(park.gate ?? park.kind.toUpperCase(), `${where} stopped: ${park.message}`);
  const label = park.kind === 'awaiting-owner' ? ui.c.yellow(`⏸  WAITING FOR YOU${park.gate ? ` (${park.gate})` : ''}`) : park.kind === 'halt' ? ui.c.red(`⛔ FLEET HALTED${park.gate ? ` (${park.gate})` : ''}`) : ui.c.red('■ BLOCKED');
  console.log(`\n            ${label} ${where}: ${park.message.split('\n')[0]}`);
  for (const l of park.message.split('\n').slice(1, 12)) console.log(`              ${ui.c.dim(l)}`);
}

async function postPark(ctx, park, issue) {
  if (!issue?.pr) return;
  const label = park.kind === 'awaiting-owner' ? 'gibson:awaiting-owner' : 'gibson:blocked';
  await ctx.gh.editPr(issue.pr, { addLabels: [label] }).catch(() => {});
  await ctx.gh.commentPr(issue.pr, `${park.kind === 'awaiting-owner' ? '⏸️' : '■'} **Gibson lane stopped — ${park.kind}${park.gate ? ` (${park.gate})` : ''}**\n\n\`\`\`\n${park.message.slice(0, 6000)}\n\`\`\`\n\nState is saved; resume with \`bin/gibson resume ${ctx.run.id}\`.`).catch(() => {});
}

/** Deliver every pending issue in dependency order; one lane at a time. */
export async function deliverAll(ctx) {
  const { run } = ctx;
  run.state.phase = 'deliver';
  run.save();
  for (const issue of run.state.issues) {
    if (issue.status === 'done') continue;
    const unmet = issue.dependsOn.filter((n) => run.issue(n)?.status !== 'done');
    if (unmet.length) {
      issue.status = 'waiting-on-dependency';
      issue.parkReason = `waits for #${unmet.join(', #')}`;
      run.journal('DELIVER', `#${issue.number} skipped: ${issue.parkReason}`);
      ui.warn(`#${issue.number} waits for #${unmet.join(', #')} — skipped this pass`);
      continue;
    }
    try {
      await deliverIssue(ctx, issue);
    } catch (caught) {
      // Unexpected failures are reported verbatim (Law 8); state is kept and the run moves on.
      const park = caught instanceof Park ? caught : new Park('blocked', `unexpected error: ${caught.stack ?? caught.message}`);
      report(ctx, park, issue);
      await postPark(ctx, park, issue);
      run.save();
      if (park.kind === 'halt') {
        if (park.gate === 'G16' || park.gate === 'G15') writeFileSync(ctx.config.haltFile, `${park.gate}: ${park.message}\n`);
        throw park;
      }
    }
  }
}

async function finish(ctx) {
  const { run, gh } = ctx;
  try { await retro(ctx); } catch (e) { ui.warn(`retro could not record lessons: ${e.message.split('\n')[0]}`); }
  const all = run.state.issues;
  if (run.state.epic && all.length && all.every((i) => i.status === 'done')) {
    await gh.closeIssue(run.state.epic.number, `All ${all.length} issue(s) delivered: ${all.map((i) => `#${i.pr}`).join(', ')}.`).catch(() => {});
    run.state.phase = 'complete';
  }
  run.save();
  const { printRunDigest } = await import('./digest.mjs');
  printRunDigest(ctx);
}

export async function request(text) {
  const config = loadConfig();
  const health = await doctor(config, { quiet: true });
  if (!health.ok) {
    ui.banner('Cannot start', 'preflight failed — fix these first (bin/gibson doctor)');
    for (const c of health.checks.filter((x) => !x.ok)) ui.fail(`${c.name}: ${c.detail}`);
    return 1;
  }
  haltCheck(config);
  const run = Run.create(config, text);
  const ctx = context(run);
  ui.banner('The Gibson', `request → plan → issues → build → review → merge · run ${run.id}`);
  ui.info(`"${text}"`);
  return drive(ctx);
}

export async function drive(ctx) {
  const { run } = ctx;
  try {
    if (!run.state.approval) {
      const plan = await planStage(ctx);
      if (!plan) { ui.info('Cancelled. Nothing was created.'); return 0; }
      run.save();
    }
    if (!run.state.epic) await createEpic(ctx, run.state.plan);
    if (!run.state.issues.length) await decomposeStage(ctx, run.state.plan, run.state.epic);
    await deliverAll(ctx);
    await finish(ctx);
    return 0;
  } catch (error) {
    if (error instanceof Park) {
      if (!run.state.issues.some((i) => i.parkReason === error.message)) report(ctx, error);
      run.save();
      if (error.kind !== 'halt') await finish(ctx).catch(() => {});
      return error.kind === 'halt' ? 3 : 0;
    }
    throw error;
  }
}

export async function resume(id) {
  const config = loadConfig();
  const run = id ? Run.load(config, id) : Run.latest(config);
  if (!run) { ui.fail('No run to resume.'); return 1; }
  ui.banner('Resuming', `${run.id} — "${run.state.request}"`);
  for (const issue of run.state.issues) if (['blocked', 'waiting-on-dependency', 'halted'].includes(issue.status)) issue.status = issue.headSha ? 'in-review' : 'claimed';
  return drive(context(run));
}

/** Owner approves a parked Tier C PR: re-enter its lane at the merge gate. */
export async function approve(prNumber) {
  const config = loadConfig();
  const run = Run.all(config).reverse().find((r) => r.state.issues.some((i) => i.pr === prNumber));
  if (!run) { ui.fail(`No Gibson run owns PR #${prNumber}.`); return 1; }
  if (!ui.isInteractive()) { ui.fail('Owner approval must be given interactively in a terminal (silence never auto-approves).'); return 1; }
  const issue = run.state.issues.find((i) => i.pr === prNumber);
  if (issue.status === 'awaiting-owner') issue.status = 'ready-to-merge';
  await new GitHub(config.repo).editPr(prNumber, { removeLabels: ['gibson:awaiting-owner'] }).catch(() => {});
  return drive(context(run));
}
