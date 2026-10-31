#!/usr/bin/env node
// Security layer 1 (hard-fail): no credentials in added lines.
//   node scripts/secrets-scan.mjs --base origin/main [--cwd dir]
import { parseArgs } from 'node:util';
import { must } from './gibson/lib/exec.mjs';
import { scanSecrets } from './gibson/lib/security.mjs';

const { values } = parseArgs({ options: { base: { type: 'string' }, cwd: { type: 'string' } }, strict: true });
if (!values.base) { console.error('usage: secrets-scan.mjs --base <ref>'); process.exit(2); }
const diff = await must('git', ['diff', '--unified=0', `${values.base}...HEAD`], { cwd: values.cwd });
const hits = scanSecrets(diff);
for (const h of hits) console.log(`secrets: ${h.file}:${h.line} — looks like a ${h.kind}`);
console.log(hits.length ? `secrets: FAIL (${hits.length} finding(s)). Rotating a leaked secret is a human gate (G4).` : 'secrets: clean');
process.exit(hits.length ? 1 : 0);
