#!/usr/bin/env node
// Required check `gibson/review-evidence`. Runs from the DEFAULT branch in CI
// (pull_request_target / issue_comment), never from PR-head code, so a PR
// cannot rewrite the rule that judges it. Reads GitHub, sets a commit status.
//   node scripts/review-evidence.mjs --pr 12 [--set-status]
import { parseArgs } from 'node:util';
import { loadConfig } from './gibson/lib/config.mjs';
import { evaluateEvidence } from './gibson/lib/evidence.mjs';
import { must } from './gibson/lib/exec.mjs';

const { values } = parseArgs({ options: { pr: { type: 'string' }, 'set-status': { type: 'boolean' }, repo: { type: 'string' } }, strict: true });
if (!values.pr) { console.error('usage: review-evidence.mjs --pr <number> [--set-status]'); process.exit(2); }
const config = loadConfig(process.cwd());
const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? config.repo;
const api = async (path, extra = []) => JSON.parse(await must('gh', ['api', ...extra, `repos/${repo}/${path}`], { timeoutSec: 120 }));

const pr = await api(`pulls/${values.pr}`);
const files = (await api(`pulls/${values.pr}/files?per_page=100`, ['--paginate', '--slurp'])).flat().map((f) => f.filename);
const comments = (await api(`issues/${values.pr}/comments?per_page=100`, ['--paginate', '--slurp'])).flat()
  .map((c) => ({ body: c.body ?? '', author: c.user?.login ?? '', authorAssociation: c.author_association, createdAt: c.created_at }));

const verdict = evaluateEvidence({
  headSha: pr.head.sha, labels: pr.labels.map((l) => l.name), body: pr.body ?? '', files, comments,
}, config);
console.log(`review-evidence: ${verdict.state.toUpperCase()} — ${verdict.description}`);

if (values['set-status']) {
  await must('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${pr.head.sha}`,
    '-f', `state=${verdict.state}`, '-f', 'context=gibson/review-evidence',
    '-f', `description=${verdict.description.slice(0, 140)}`,
    '-f', `target_url=${pr.html_url}`]);
}
process.exit(verdict.state === 'success' ? 0 : 1);
