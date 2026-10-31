// DECOMPOSE: approved plan → dependency-ordered issues with sprint contracts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch, render } from '../lib/agents.mjs';
import { scopesOverlap } from '../lib/glob.mjs';
import { extractJson } from '../lib/jsonx.mjs';
import { scanInjectionInText } from '../lib/security.mjs';
import * as ui from '../lib/ui.mjs';
import { Park } from './errors.mjs';

const SCHEMA_GLOBS = ['src/infrastructure/storage/schema.ts', 'src/infrastructure/storage/migrations.ts'];

/** Kahn's algorithm; returns keys in dependency order or null on a cycle. */
export function topoOrder(issues) {
  const pending = new Map(issues.map((i) => [i.key, new Set(i.dependsOn ?? [])]));
  const order = [];
  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => [...deps].every((d) => order.includes(d))).map(([k]) => k);
    if (!ready.length) return null;
    for (const k of ready.sort()) { order.push(k); pending.delete(k); }
  }
  return order;
}

const dependsTransitively = (byKey, a, b, seen = new Set()) => {
  for (const d of byKey.get(a)?.dependsOn ?? []) {
    if (d === b) return true;
    if (!seen.has(d)) { seen.add(d); if (dependsTransitively(byKey, d, b, seen)) return true; }
  }
  return false;
};

/** decompose-lint: the harness rejects a backlog it cannot build safely. */
export function lintIssues(issues, { maxIssues }) {
  const problems = [];
  if (!Array.isArray(issues) || issues.length === 0) return ['no issues'];
  if (issues.length > maxIssues) problems.push(`${issues.length} issues exceeds the limit of ${maxIssues}`);
  const keys = new Set();
  for (const i of issues) {
    const where = `issue ${i.key ?? '?'}`;
    if (!i.key || keys.has(i.key)) problems.push(`${where}: missing or duplicate key`);
    keys.add(i.key);
    if (!i.title) problems.push(`${where}: no title`);
    if (!['A', 'B', 'C'].includes(i.tier)) problems.push(`${where}: tier must be A, B or C`);
    if (!Array.isArray(i.acceptanceCriteria) || i.acceptanceCriteria.length === 0) problems.push(`${where}: no acceptance criteria (Law 6)`);
    if (!Array.isArray(i.affectedArea) || i.affectedArea.length === 0) problems.push(`${where}: no affected area (claims need a scope)`);
    const touchesSchema = (i.affectedArea ?? []).some((g) => SCHEMA_GLOBS.some((s) => scopesOverlap(g, s)));
    if (touchesSchema && i.tier !== 'C') problems.push(`${where}: touches the storage schema, so it must be tier C`);
  }
  for (const i of issues) for (const d of i.dependsOn ?? []) if (!keys.has(d)) problems.push(`issue ${i.key}: depends on unknown ${d}`);
  if (!problems.length && !topoOrder(issues)) problems.push('dependency cycle');
  const byKey = new Map(issues.map((i) => [i.key, i]));
  for (const a of issues) for (const b of issues) {
    if (a.key >= b.key || dependsTransitively(byKey, a.key, b.key) || dependsTransitively(byKey, b.key, a.key)) continue;
    const clash = (a.affectedArea ?? []).find((ga) => (b.affectedArea ?? []).some((gb) => scopesOverlap(ga, gb)));
    if (clash) problems.push(`issues ${a.key} and ${b.key} overlap on ${clash} but neither depends on the other (claims would collide)`);
  }
  return problems;
}

export function issueBody({ issue, number, epic, plan, depNumbers }) {
  const acs = issue.acceptanceCriteria.map((text, i) => ({ id: `AC-${number}.${i + 1}`, text }));
  const body = [
    `> Part of #${epic.number} — ${plan.title}`, '',
    `**What you'll get:** ${issue.summary ?? issue.title}`, '',
    '## Context', '', issue.context ?? '', '',
    '## Sprint contract', '',
    ...acs.map((a) => `- [ ] ${a.id} — ${a.text}`), '',
    `_Sensor: each criterion is met only by a passing test whose name contains its id, e.g. \`[${acs[0].id}]\` (\`scripts/contract-met.mjs\`)._`, '',
    '## Affected area', '', ...issue.affectedArea.map((g) => `- \`${g}\``), '',
    '## Dependencies', '', depNumbers.length ? depNumbers.map((n) => `- #${n}`).join('\n') : '- none', '',
    '## Out of scope', '', ...(issue.outOfScope?.length ? issue.outOfScope.map((o) => `- ${o}`) : ['- (none listed)']), '',
    '## Tier', '', `${issue.tier} — ${issue.tierReason ?? ''}`,
  ].join('\n');
  return { body, acs };
}

export async function decomposeStage(ctx, plan, epic) {
  const { config, run, gh } = ctx;
  ui.stage('DECOMPOSE', 'Cutting the plan into issues with testable sprint contracts…');
  const template = readFileSync(join(config.snapshotDir, 'gibson/roles/decomposer.md'), 'utf8');
  const role = config.routing.decomposer;
  let issues = null;
  let note = '';
  for (let attempt = 0; attempt < 2 && !issues; attempt += 1) {
    const prompt = render(template, { plan: JSON.stringify(plan, null, 2), maxIssues: config.limits.maxIssuesPerRequest }) + note;
    const stop = ui.spinner(`${role.vendor} (${role.model || 'default'}) is decomposing`);
    const res = await dispatch({ role: 'decomposer', ...role, access: 'read', prompt, cwd: config.snapshotDir, timeoutSec: config.timeoutsSec.decompose, runDir: run.dir });
    stop();
    if (!res.ok) throw new Park('blocked', `decomposer failed: ${res.error}`);
    const candidate = extractJson(res.text)?.issues;
    const problems = lintIssues(candidate, { maxIssues: config.limits.maxIssuesPerRequest });
    if (problems.length) {
      run.journal('DECOMPOSE', `decompose-lint rejected attempt ${attempt + 1}: ${problems.join('; ')}`);
      ui.warn(`decompose-lint: ${problems.join('; ')}`);
      note = `\n\n## Your previous attempt was rejected by decompose-lint\n${problems.map((p) => `- ${p}`).join('\n')}\nFix these and return the full JSON again.`;
    } else issues = candidate;
  }
  if (!issues) throw new Park('blocked', 'decomposer could not produce a lint-clean backlog in two attempts');
  const injection = scanInjectionInText(JSON.stringify(issues), 'decomposer');
  if (injection.length) throw new Park('halt', `prompt-injection markers in decomposer output (${injection.map((i) => i.kind).join(', ')})`, 'G16');

  const byKey = new Map();
  for (const key of topoOrder(issues)) {
    const issue = issues.find((i) => i.key === key);
    const depNumbers = (issue.dependsOn ?? []).map((d) => byKey.get(d).number);
    const { tier } = issue;
    const created = await gh.createIssue({ title: issue.title, body: `> Part of #${epic.number}. Sprint contract being written…`, labels: [`tier:${tier}`] });
    const { body, acs } = issueBody({ issue, number: created.number, epic, plan, depNumbers });
    await gh.editIssue(created.number, { body });
    const record = {
      key, number: created.number, url: created.url, title: issue.title, summary: issue.summary ?? issue.title,
      tier, affectedArea: issue.affectedArea, dependsOn: depNumbers, acs, status: 'pending',
      reviewRounds: 0, uxRounds: 0, ciFixes: 0, notes: [], findings: [],
    };
    byKey.set(key, record);
    run.state.issues.push(record);
    run.journal('DECOMPOSE', `Filed #${created.number} "${issue.title}" — Tier ${tier}, ${acs.length} criteria${depNumbers.length ? `, after #${depNumbers.join(', #')}` : ''}`);
  }
  run.save();

  const lines = run.state.issues.map((i) => `- [ ] #${i.number} ${i.title} (Tier ${i.tier})`).join('\n');
  const epicIssue = await gh.issue(epic.number);
  await gh.editIssue(epic.number, { body: epicIssue.body.replace('_Filled in by the decomposer._', lines) });

  console.log('');
  for (const i of run.state.issues) {
    const tierColor = i.tier === 'C' ? ui.c.red : i.tier === 'B' ? ui.c.yellow : ui.c.green;
    console.log(`    ${tierColor(`Tier ${i.tier}`)}  ${ui.c.bold(`#${i.number}`)} ${i.title}`);
    console.log(`            ${ui.c.dim(i.summary)}`);
  }
  console.log('');
  return run.state.issues;
}
