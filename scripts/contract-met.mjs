#!/usr/bin/env node
// Sensor: every acceptance criterion in the linked issue is covered by a
// passing test tagged [AC-<issue>.<n>]. Exit 0 met, 1 unmet, 2 usage.
//   node scripts/contract-met.mjs --issue 12          (reads the issue via gh)
//   node scripts/contract-met.mjs --pr-body-file f    (finds "Closes #N" first)
//   node scripts/contract-met.mjs --ids AC-3.1,AC-3.2
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './gibson/lib/config.mjs';
import { acIdsFromBody, evaluateContract, runTapTests } from './gibson/lib/contract.mjs';
import { must } from './gibson/lib/exec.mjs';

const { values } = parseArgs({ options: { issue: { type: 'string' }, 'pr-body-file': { type: 'string' }, ids: { type: 'string' }, cwd: { type: 'string' }, repo: { type: 'string' } }, strict: true });
const config = loadConfig();
const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? config.repo;

let issue = values.issue;
if (!issue && values['pr-body-file']) {
  const body = readFileSync(values['pr-body-file'], 'utf8');
  issue = /\b(?:Closes|Fixes|Resolves)\s+#(\d+)/i.exec(body)?.[1];
  if (!issue) {
    console.log('contract: PR does not close an issue (no "Closes #N") — nothing to verify.');
    process.exit(0);
  }
}
let ids = values.ids ? values.ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
if (issue) {
  const body = await must('gh', ['issue', 'view', issue, '-R', repo, '--json', 'body', '--jq', '.body']);
  ids = acIdsFromBody(body).filter((id) => id.startsWith(`AC-${issue}.`));
}
if (ids.length === 0) {
  console.error(`contract: no acceptance criteria found${issue ? ` in issue #${issue}` : ''} — Law 6: no criterion, no merge.`);
  process.exit(issue ? 1 : 2);
}
const tap = await runTapTests(values.cwd ?? process.cwd(), config.testGlobs);
const result = evaluateContract(ids, tap.tests);
for (const row of result.rows) {
  console.log(`${row.met ? 'MET  ' : 'UNMET'}  ${row.id}  ${row.tests.length ? row.tests.join(' | ') : '(no test tagged with this criterion)'}`);
}
console.log(`contract: ${result.met.length}/${ids.length} criteria met by passing tests.`);
process.exit(result.unmet.length ? 1 : 0);
