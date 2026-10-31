// End-to-end: one plain-English request driven through EVERY pipeline stage —
// plan → owner approval → decompose → claim → build → gate → security →
// review (with a rejected round) → ux-eval → CI → merge by tier (Tier C via
// owner approval) → deploy + smoke test → cleanup → retro.
// Real git (bare origin + worktrees), real gate and contract sensors, real
// evidence evaluation; fake GitHub bookkeeping, fake AI vendors, scripted owner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.GIBSON_QUIET = '1';
const { loadConfig } = await import('../gibson/lib/config.mjs');
const { Run } = await import('../gibson/lib/run-state.mjs');
const { drive } = await import('../gibson/pipeline.mjs');
const { FakeGitHub, fakeVendors } = await import('./fakes.mjs');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OWNER = 'fixture-owner';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/** A disposable copy of this repo with a bare "origin". The harness tests are excluded (no recursion). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gibson-e2e-'));
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(repo);
  for (const path of ['src', 'test', 'gibson', 'AGENTS.md', 'MEMORY.md', 'README.md', 'package.json', 'tsconfig.json']) {
    cpSync(join(ROOT, path), join(repo, path), { recursive: true });
  }
  mkdirSync(join(repo, 'scripts'));
  cpSync(join(ROOT, 'scripts/gibson'), join(repo, 'scripts/gibson'), { recursive: true });
  cpSync(join(ROOT, 'scripts/gate.mjs'), join(repo, 'scripts/gate.mjs'));
  mkdirSync(join(repo, '.agents'));
  writeFileSync(join(repo, '.agents/gate.json'), JSON.stringify({ generate: '', typecheck: '', lint: '', test: 'node --test "test/**/*.test.ts"', build: '' }));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n.gibson-baseline.json\n');
  const config = JSON.parse(readFileSync(join(repo, 'gibson/config.json'), 'utf8'));
  Object.assign(config, {
    repo: 'fixture/todo', stateDir: join(dir, 'state'), testGlobs: ['test/**/*.test.ts'],
    commands: { install: 'true', build: 'true', bin: 'src/cli/main.ts' },
    reviewEvidence: { reviewerLogins: [OWNER], ownerLogins: [OWNER] },
  });
  writeFileSync(join(repo, 'gibson/config.json'), JSON.stringify(config, null, 2));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'owner@example.com');
  git(repo, 'config', 'user.name', 'Fixture Owner');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-s', '-m', 'fixture: initial');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { dir, origin, repo };
}

describe('pipeline end-to-end', { timeout: 240_000 }, () => {
  let fx;
  let run;
  let gh;
  let vendors;
  const answers = [];
  before(async () => {
    fx = fixture();
    const config = loadConfig(fx.repo);
    gh = new FakeGitHub({ origin: fx.origin, config, owner: OWNER });
    run = Run.create(config, 'Document the feature and annotate the storage schema');
    vendors = fakeVendors({ rejectFirstReviewOf: () => run.state.issues[0]?.pr });
    answers.push('a', 'y'); // approve the plan; approve the Tier C merge
    const prompt = async () => answers.shift() ?? 'n';
    const code = await drive({ config, run, gh, dispatch: vendors.dispatch, prompt, interactive: true });
    assert.equal(code, 0);
  });
  after(() => { if (!process.env.GIBSON_KEEP_FIXTURE) rmSync(fx.dir, { recursive: true, force: true }); });

  const journal = () => readFileSync(join(run.dir, 'journal.md'), 'utf8');

  it('[AC-1.8] passes the request through every stage, in order', () => {
    const stages = ['PLAN', 'DECOMPOSE', 'CLAIM', 'BUILD', 'GATE', 'SECURITY', 'REVIEW', 'UX-EVAL', 'MERGE', 'DEPLOY', 'RETRO'];
    const text = journal();
    const positions = stages.map((s) => text.indexOf(`**${s}**`));
    for (const [i, s] of stages.entries()) assert.ok(positions[i] >= 0, `journal has no ${s} entry`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'first appearance of each stage is in pipeline order');
    assert.match(text, /Owner APPROVED the plan/);
  });

  it('[AC-1.8] files an epic and dependency-ordered issues with sprint contracts', () => {
    const [i1, i2] = run.state.issues;
    assert.ok(run.state.epic.number);
    assert.deepEqual(i2.dependsOn, [i1.number]);
    assert.match(gh.items.get(i1.number).body, /AC-\d+\.1 — a doc exists/);
    assert.equal(gh.items.get(run.state.epic.number).state, 'CLOSED', 'epic closes when every issue ships');
  });

  it('[AC-1.8] sends review findings back to the builder and re-reviews the new head', () => {
    const [i1] = run.state.issues;
    assert.equal(i1.reviewRounds, 2);
    const reviews = gh.items.get(i1.pr).comments.filter((c) => c.body.includes('gibson:review'));
    assert.match(reviews[0].body, /VERDICT: REQUEST_CHANGES$/);
    assert.match(reviews[1].body, /VERDICT: APPROVE$/);
    const sha = (c) => /Reviewed-SHA: (\w+)/.exec(c.body)[1];
    assert.notEqual(sha(reviews[0]), sha(reviews[1]), 'round 2 reviews the new head, not a stale one');
  });

  it('[AC-1.8] keeps hats separate: builder edits, reviewer is another vendor and read-only', () => {
    const byRole = (r) => vendors.calls.filter((c) => c.role === r);
    assert.ok(byRole('builder').every((c) => c.vendor === 'claude' && c.access === 'edit'));
    assert.ok(byRole('reviewer').every((c) => c.vendor === 'codex' && c.access === 'read'));
    assert.ok(byRole('ux-evaluator').every((c) => c.access === 'probe'));
  });

  it('[AC-1.8] merges Tier A on evidence alone, Tier C only after FAN-OUT review and owner approval', () => {
    const [i1, i2] = run.state.issues;
    assert.deepEqual([i1.finalTier, i2.finalTier], ['A', 'C']);
    assert.ok(!gh.items.get(i1.pr).comments.some((c) => c.body.includes('gibson:owner-approval')));
    const c = gh.items.get(i2.pr).comments;
    assert.ok(c.some((x) => x.body.includes('Review-Mode: FAN-OUT')), 'Tier C got a FAN-OUT review');
    assert.ok(c.some((x) => x.body.includes(`Owner-Approval: ${i2.headSha}`)), 'owner approved the exact head');
    assert.equal(vendors.calls.filter((x) => x.role === 'reviewer').length, 2 + 4, 'A: 2 SOLO rounds; C: 3 lens groups + adversarial');
    const log = git(fx.origin, 'log', '--format=%s', 'main');
    assert.match(log, new RegExp(`feat\\(#${i1.number}\\)`));
    assert.match(log, new RegExp(`feat\\(#${i2.number}\\)`));
    for (const i of [i1, i2]) {
      const body = git(fx.origin, 'log', '--format=%B', '--grep', `^feat(#${i.number})`, 'main');
      assert.match(body, /Signed-off-by:/, `DCO survives the squash of #${i.number}`);
      assert.match(body, new RegExp(`Closes #${i.number}`));
    }
  });

  it('[AC-1.8] deploys, smoke-tests and cleans up after itself (Law 10)', () => {
    for (const i of run.state.issues) {
      assert.equal(i.status, 'done');
      assert.ok(i.release?.version, 'release built and smoke-tested');
      assert.equal(existsSync(i.worktree), false, 'worktree removed');
      assert.equal(gh.items.get(i.number).state, 'CLOSED');
      assert.ok(!gh.items.get(i.number).labels.includes('agent-claimed'), 'claim released');
      assert.equal(git(fx.origin, 'branch', '--list', i.branch), '', 'branch deleted');
    }
  });

  it('[AC-1.8] retro records the lesson the gate missed in MEMORY.md (memory-only PR)', () => {
    const memory = git(fx.origin, 'show', 'main:MEMORY.md');
    assert.match(memory, /review-caught-/);
    const memoryPr = [...gh.items.values()].find((x) => x.kind === 'pr' && x.labels.includes('memory-only'));
    assert.equal(memoryPr.state, 'MERGED');
  });
});
