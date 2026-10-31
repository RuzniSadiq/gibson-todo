import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from '../gibson/lib/agents.mjs';
import { seedFixtures } from '../gibson/stages/review.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'gibson-uxfx-'));

test('[AC-10.1] seeds test/fixtures/**/*.json into <sandbox>/fixtures; none ⇒ []', () => {
  const wt = tmp(), sb = tmp();
  mkdirSync(join(wt, 'test/fixtures/bad'), { recursive: true });
  writeFileSync(join(wt, 'test/fixtures/store-v1.json'), '{"schemaVersion":1}');
  writeFileSync(join(wt, 'test/fixtures/bad/v3.json'), '{"schemaVersion":3}');
  writeFileSync(join(wt, 'test/fixtures/notes.txt'), 'x');
  assert.deepEqual(seedFixtures(wt, sb), ['bad/v3.json', 'store-v1.json']);
  assert.equal(readFileSync(join(sb, 'fixtures/bad/v3.json'), 'utf8'), '{"schemaVersion":3}');
  assert.deepEqual(seedFixtures(tmp(), tmp()), []);
});

test('[AC-10.2] ux-evaluator prompt names the fixtures dir and seeded files', () => {
  const tpl = readFileSync(new URL('../../gibson/roles/ux-evaluator.md', import.meta.url), 'utf8');
  const out = render(tpl, { fixturesDir: '/sb/fixtures', fixtureList: '- store-v1.json', todoFile: '/sb/tasks.json', prNumber: 1, headSha: 'abc', issueNumber: 1, issueTitle: 't', issueBody: 'b' });
  assert.match(out, /TODO_FILE=\/sb\/fixtures\/<name>\.json node dist\/cli\/main\.js/);
  assert.match(out, /- store-v1\.json/);
});
