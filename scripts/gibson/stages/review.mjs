// REVIEW + UX-EVAL. Never graded by the builder (Law 5). The reviewer runs in a
// read-only sandbox, bound to the exact head SHA; its verdict is posted as
// review evidence that CI (scripts/review-evidence.mjs) re-checks.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { render } from '../lib/agents.mjs';
import { REVIEW_MARKER } from '../lib/evidence.mjs';
import { run as exec } from '../lib/exec.mjs';
import { diff as gitDiff } from '../lib/git.mjs';
import { extractJson, finalVerdict } from '../lib/jsonx.mjs';
import * as ui from '../lib/ui.mjs';
import { Park } from './errors.mjs';

const MAX_DIFF = 120_000;
const FAN_OUT = [
  { name: 'correctness + performance', focus: 'FAN-OUT pass: concentrate on the Correctness and Performance lenses (still list the other four as "deferred to sibling pass").' },
  { name: 'security + consent/PII + money', focus: 'FAN-OUT pass: concentrate on the Security, Consent/PII and Money lenses (still list the other three as "deferred to sibling pass").' },
  { name: 'maintainability + contract', focus: 'FAN-OUT pass: concentrate on Maintainability and on whether every acceptance criterion is genuinely tested (list the others as "deferred to sibling pass").' },
];

const seconds = (ms) => `${Math.round(ms / 1000)}s`;
// Strip anything in reviewer prose that could impersonate evidence fields.
const sanitize = (text) => String(text)
  .replace(/<!--\s*gibson:[\w-]+\s*-->/g, '')
  .split('\n').filter((l) => !/^\s*(Reviewed-SHA|Reviewer-Vendor|Review-Mode|Builder-Vendor|Owner-Approval):/.test(l))
  .join('\n').replace(/\n?\s*\**VERDICT:\s*(APPROVE|REQUEST_CHANGES)\**\s*$/, '').trim();

async function reviewPass(ctx, issue, { template, mode, focus = '', extra = {} }) {
  const { config, run } = ctx;
  const role = config.routing.reviewer;
  let diff = await gitDiff(issue.worktree, `origin/${config.defaultBranch}`);
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (diff truncated at ${MAX_DIFF} bytes; read the files directly)`;
  const issueBody = (await ctx.gh.issue(issue.number)).body;
  const prompt = render(template, {
    builderVendor: config.routing.builder.vendor, prNumber: issue.pr, headSha: issue.headSha, mode, focus,
    issueNumber: issue.number, issueTitle: issue.title, tier: issue.finalTier, issueBody,
    sensors: issue.sensorReport ?? '(none)', baseRef: `origin/${config.defaultBranch}`, diff, priorFindings: '', ...extra,
  });
  const res = await ctx.dispatch({ role: 'reviewer', ...role, access: 'read', prompt, cwd: issue.worktree, timeoutSec: config.timeoutsSec.review, runDir: run.dir });
  return { ...res, verdict: res.ok ? finalVerdict(res.text) : null };
}

/** One review round at the current head. Returns {verdict, findingsText}. */
export async function reviewRound(ctx, issue) {
  const { config, run, gh } = ctx;
  const round = issue.reviewRounds + 1;
  const tierC = issue.finalTier === 'C';
  const mode = tierC ? 'FAN-OUT' : 'SOLO';
  const reviewer = config.routing.reviewer;
  ui.stage('REVIEW', `Round ${round} · ${mode} · ${reviewer.vendor} reviews #${issue.pr} at exact head ${issue.headSha.slice(0, 7)} (read-only)`);

  const reviewerTpl = readFileSync(join(config.root, 'gibson/roles/reviewer.md'), 'utf8');
  let passes;
  const stop = ui.spinner(tierC ? `${reviewer.vendor} ×3 lens groups in parallel` : `${reviewer.vendor} checking all six lenses + the contract`);
  try {
    if (tierC) {
      passes = await Promise.all(FAN_OUT.map(async (f) => ({ name: f.name, ...(await reviewPass(ctx, issue, { template: reviewerTpl, mode, focus: f.focus })) })));
    } else {
      passes = [{ name: 'all six lenses + contract', ...(await reviewPass(ctx, issue, { template: reviewerTpl, mode, focus: 'SOLO: one pass, all six lenses.' })) }];
    }
  } finally { stop(); }

  if (tierC) {
    const adversarialTpl = readFileSync(join(config.root, 'gibson/roles/adversarial.md'), 'utf8');
    const prior = passes.map((p) => `### ${p.name} → ${p.verdict ?? 'NO VERDICT'}\n${sanitize(p.text).slice(0, 6000)}`).join('\n\n');
    const stop2 = ui.spinner(`${reviewer.vendor} adversarial refutation pass (trying to break it)`);
    try {
      passes.push({ name: 'adversarial refutation', ...(await reviewPass(ctx, issue, { template: adversarialTpl, mode, extra: { priorFindings: prior } })) });
    } finally { stop2(); }
  }

  // Fail closed: a broken reviewer blocks the merge. One retry, then park.
  const broken = passes.filter((p) => !p.verdict);
  if (broken.length) {
    run.journal('REVIEW', `Reviewer returned no verdict (${broken.map((b) => b.error ?? 'missing VERDICT line').join('; ')})`);
    if (!issue.reviewerRetried) {
      issue.reviewerRetried = true;
      ui.warn('Reviewer gave no verdict — fail closed; retrying once.');
      return reviewRound(ctx, issue);
    }
    throw new Park('blocked', `reviewer unavailable or produced no VERDICT twice (${broken[0].error ?? 'no verdict line'}) — merge blocked (fail closed)`);
  }

  const verdict = passes.every((p) => p.verdict === 'APPROVE') ? 'APPROVE' : 'REQUEST_CHANGES';
  issue.reviewRounds = round;
  const model = [...new Set(passes.map((p) => p.model).filter(Boolean))].join('+') || 'unknown';
  const comment = [
    REVIEW_MARKER,
    `## ${verdict === 'APPROVE' ? '✅' : '❌'} Gibson review · round ${round} · Tier ${issue.finalTier} · ${mode}`,
    '',
    `Reviewed-SHA: ${issue.headSha}`,
    `Reviewer-Vendor: ${reviewer.vendor}`,
    `Reviewer-Model: ${model}`,
    `Builder-Vendor: ${config.routing.builder.vendor}`,
    `Review-Mode: ${mode}`,
    `Reviewer-Sessions: ${passes.map((p) => p.sessionId ?? 'n/a').join(',')}`,
    `Transcript-SHA256: ${createHash('sha256').update(passes.map((p) => p.text).join('\n---\n')).digest('hex')}`,
    '',
    `**Independence: E3** — cross-vendor (${reviewer.vendor} reviewing ${config.routing.builder.vendor}'s work), read-only sandbox, bound to exact head \`${issue.headSha.slice(0, 7)}\`. Transcripts kept locally under Gibson run \`${run.id}\`.`,
    '',
    '| Pass | Verdict | Time |', '|---|---|---|',
    ...passes.map((p) => `| ${p.name} | ${p.verdict === 'APPROVE' ? '✅ APPROVE' : '❌ REQUEST_CHANGES'} | ${seconds(p.durationMs)} |`),
    '',
    ...passes.flatMap((p) => [`<details${verdict !== 'APPROVE' && p.verdict !== 'APPROVE' ? ' open' : ''}><summary><b>${p.name}</b> — ${p.verdict}</summary>`, '', sanitize(p.text), '', '</details>', '']),
    `VERDICT: ${verdict}`,
  ].join('\n');
  await gh.commentPr(issue.pr, comment);

  const findingsText = passes.filter((p) => p.verdict !== 'APPROVE').map((p) => `### ${p.name}\n${sanitize(p.text)}`).join('\n\n');
  if (verdict === 'APPROVE') ui.ok(`${reviewer.vendor} APPROVED round ${round} (${passes.map((p) => seconds(p.durationMs)).join(' / ')})`);
  else {
    ui.warn(`${reviewer.vendor} REQUESTED CHANGES in round ${round} — findings go back to the builder`);
    issue.findings.push({ round, text: findingsText.slice(0, 4000) });
  }
  run.journal('REVIEW', `Round ${round} ${mode} by ${reviewer.vendor} at ${issue.headSha.slice(0, 7)}: ${verdict}`);
  run.save();
  return { verdict, findingsText };
}

/**
 * Copy the worktree's test/fixtures/**\/*.json into <sandbox>/fixtures so the
 * probe-only evaluator can point TODO_FILE at old-version or corrupt stores
 * without needing write access. Returns the seeded relative paths.
 */
export function seedFixtures(worktree, sandbox) {
  const src = join(worktree, 'test', 'fixtures');
  if (!existsSync(src)) return [];
  const dest = join(sandbox, 'fixtures');
  cpSync(src, dest, { recursive: true, filter: (f) => !f.includes('/.') });
  return readdirSync(dest, { recursive: true }).map(String)
    .filter((f) => f.endsWith('.json')).map((f) => relative(dest, join(dest, f))).sort();
}

/** UX-EVAL: a separate identity drives the LIVE built CLI, never the diff. */
export async function uxEval(ctx, issue) {
  const { config, run, gh } = ctx;
  const role = config.routing.uxEvaluator;
  ui.stage('UX-EVAL', `${role.vendor} (${role.model}) drives the built CLI at ${issue.headSha.slice(0, 7)} like a user would`);
  const build = await exec('bash', ['-c', config.commands.build], { cwd: issue.worktree, timeoutSec: 300 });
  if (build.code !== 0) throw new Park('blocked', `build of the head for UX evaluation failed:\n${build.stderr.slice(-1500)}`);
  const sandbox = mkdtempSync(join(tmpdir(), 'gibson-ux-'));
  try {
    const template = readFileSync(join(config.root, 'gibson/roles/ux-evaluator.md'), 'utf8');
    const fixtures = seedFixtures(issue.worktree, sandbox);
    const prompt = render(template, {
      prNumber: issue.pr, headSha: issue.headSha, todoFile: join(sandbox, 'tasks.json'),
      fixturesDir: join(sandbox, 'fixtures'),
      fixtureList: fixtures.length ? fixtures.map((f) => `- ${f}`).join('\n') : '- (none)',
      issueNumber: issue.number, issueTitle: issue.title, issueBody: (await gh.issue(issue.number)).body,
    });
    const stop = ui.spinner('evaluating the live CLI');
    const res = await ctx.dispatch({ role: 'ux-evaluator', ...role, access: 'probe', prompt, cwd: issue.worktree, timeoutSec: config.timeoutsSec.uxEval, runDir: run.dir, env: { TODO_FILE: join(sandbox, 'tasks.json') } });
    stop();
    const grade = res.ok ? extractJson(res.text) : null;
    if (!grade || typeof grade.pass !== 'boolean') {
      throw new Park('blocked', `ux-evaluator produced no gradeable result (${res.error ?? 'no JSON'}) — fail closed`);
    }
    await gh.commentPr(issue.pr, [
      '<!-- gibson:ux-eval -->',
      `## ${grade.pass ? '✅' : '❌'} UX evaluation · ${grade.score}/5 · live build at \`${issue.headSha.slice(0, 7)}\``,
      '', `Evaluator: ${role.vendor} (${res.model || role.model}) — separate identity from builder and reviewer; graded the running CLI, not the diff.`,
      '', '**Exercised**', ...(grade.exercised ?? []).map((e) => `- \`${e}\``),
      '', '**Findings**', ...((grade.findings ?? []).length ? grade.findings.map((f) => `- ${f}`) : ['- None.']),
    ].join('\n'));
    run.journal('UX-EVAL', `${grade.pass ? 'PASS' : 'FAIL'} ${grade.score}/5 at ${issue.headSha.slice(0, 7)}`);
    (grade.pass ? ui.ok : ui.warn)(`UX score ${grade.score}/5${grade.pass ? '' : ` — ${(grade.findings ?? []).length} finding(s) go back to the builder`}`);
    return grade;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
