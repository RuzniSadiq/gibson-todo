// The owner's entire view (gibson-run "digest"): plain English, no diffs.
import { loadConfig } from './lib/config.mjs';
import { GitHub } from './lib/github.mjs';
import { Run } from './lib/run-state.mjs';
import * as ui from './lib/ui.mjs';

const STATUS = {
  done: ['✔', 'shipped'], merged: ['✔', 'merged'], 'awaiting-owner': ['⏸', 'waiting for YOU'],
  blocked: ['■', 'blocked'], halted: ['⛔', 'halted'], 'waiting-on-dependency': ['…', 'waiting on another issue'],
  'in-review': ['◐', 'in review'], 'ready-to-merge': ['◐', 'ready to merge'], claimed: ['◔', 'being built'], pending: ['○', 'queued'],
};

export function printRunDigest({ run }) {
  const { c } = ui;
  const plan = run.state.plan;
  ui.banner(`Digest · ${plan?.title ?? run.state.request}`, `run ${run.id}${run.state.epic ? ` · plan #${run.state.epic.number}` : ''}`);
  for (const i of run.state.issues) {
    const [icon, words] = STATUS[i.status] ?? ['?', i.status];
    const color = ['done', 'merged'].includes(i.status) ? c.green : i.status === 'awaiting-owner' ? c.yellow : ['blocked', 'halted'].includes(i.status) ? c.red : c.dim;
    console.log(`  ${color(icon)} ${c.bold(`#${i.number}`)} ${i.title} ${c.dim(`· Tier ${i.finalTier ?? i.tier} · ${words}${i.pr ? ` · PR #${i.pr}` : ''}`)}`);
    if (i.status === 'done') console.log(`      ${c.dim(`${i.reviewRounds} review round(s) · ${i.acs.length}/${i.acs.length} criteria proven · ${i.testCount} tests · release v${i.release?.version ?? '?'}`)}`);
    if (i.parkReason && !['done', 'merged'].includes(i.status)) console.log(`      ${c.dim(i.parkReason.split('\n')[0])}`);
  }
  const waiting = run.state.issues.filter((i) => i.status === 'awaiting-owner');
  if (waiting.length) {
    console.log(`\n  ${c.yellow(c.bold('Needs your decision'))}`);
    for (const i of waiting) console.log(`    bin/gibson approve ${i.pr}    ${c.dim(`# ${i.title}`)}`);
  }
  const shipped = run.state.issues.filter((i) => i.status === 'done');
  if (shipped.length && plan?.demoCommands?.length) {
    const config = loadConfig();
    console.log(`\n  ${c.bold('Try it')} ${c.dim(`(the release build is at ${config.releaseDir})`)}`);
    for (const cmd of plan.demoCommands) console.log(`    ${cmd}`);
  }
  console.log(`\n  ${c.dim(`Full audit trail: ${run.dir}/journal.md`)}\n`);
}

/** `bin/gibson status`: live view from GitHub + local runs. */
export async function status() {
  const config = loadConfig();
  const gh = new GitHub(config.repo);
  const { c } = ui;
  ui.banner('Gibson status', config.repo);
  const [prs, merged, epics] = await Promise.all([gh.openPrs(), gh.mergedPrs(8), gh.listIssues({ labels: ['gibson:plan'], state: 'all', limit: 10 })]);
  const has = (pr, l) => pr.labels.some((x) => x.name === l);
  const waiting = prs.filter((p) => has(p, 'gibson:awaiting-owner'));
  const blocked = prs.filter((p) => has(p, 'gibson:blocked'));
  const active = prs.filter((p) => !waiting.includes(p) && !blocked.includes(p));

  console.log(`\n  ${c.bold('Plans')}`);
  for (const e of epics) console.log(`    ${e.state === 'CLOSED' ? c.green('✔ delivered') : c.yellow('◐ in progress')}  #${e.number} ${e.title.replace(/^Plan: /, '')}`);
  if (!epics.length) console.log(`    ${c.dim('none yet — try: bin/gibson "Add a way to search my tasks"')}`);
  console.log(`\n  ${c.bold('Waiting for you')}`);
  for (const p of waiting) console.log(`    ${c.yellow('⏸')} PR #${p.number} ${p.title}  ${c.dim(`→ bin/gibson approve ${p.number}`)}`);
  if (!waiting.length) console.log(`    ${c.dim('nothing')}`);
  console.log(`\n  ${c.bold('In flight')}`);
  for (const p of active) console.log(`    ◐ PR #${p.number} ${p.title}${p.isDraft ? c.dim(' (claimed, building)') : ''}`);
  if (!active.length) console.log(`    ${c.dim('nothing')}`);
  if (blocked.length) {
    console.log(`\n  ${c.bold('Blocked')} ${c.dim('(the latest PR comment says why, verbatim)')}`);
    for (const p of blocked) console.log(`    ${c.red('■')} PR #${p.number} ${p.title}`);
  }
  console.log(`\n  ${c.bold('Recently shipped')}`);
  for (const p of merged) console.log(`    ${c.green('✔')} PR #${p.number} ${p.title} ${c.dim(`${(p.labels.find((l) => l.name.startsWith('tier:'))?.name ?? '')} · ${p.mergedAt.slice(0, 10)}`)}`);
  const latest = Run.latest(config);
  if (latest) console.log(`\n  ${c.dim(`Latest run: ${latest.id} — ${latest.dir}/journal.md`)}`);
  console.log('');
  return 0;
}
