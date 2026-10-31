// Test doubles for the pipeline's side-effecting ports. Git is REAL (a bare
// repo stands in for origin); GitHub's issue/PR/check bookkeeping and the AI
// vendors are faked so the whole state machine runs offline and deterministically.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateEvidence } from '../gibson/lib/evidence.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

export class FakeGitHub {
  constructor({ origin, config, owner }) {
    this.origin = origin;
    this.config = config;
    this.owner = owner;
    this.items = new Map();
    this.n = 0;
    this.tick = 0;
  }

  #at() {
    this.tick += 1;
    return new Date(Date.UTC(2026, 10, 1) + this.tick * 1000).toISOString();
  }
  #labels(item) { return item.labels.map((name) => ({ name })); }
  #applyLabels(item, add = [], remove = []) {
    item.labels = [...new Set([...item.labels.filter((l) => !remove.includes(l)), ...add])];
  }

  async createIssue({ title, body, labels = [] }) {
    const number = ++this.n;
    this.items.set(number, { kind: 'issue', number, title, body, labels: [...labels], state: 'OPEN', comments: [] });
    return { number, url: `https://github.test/issues/${number}` };
  }
  async issue(number) {
    const i = this.items.get(number);
    return { ...i, labels: this.#labels(i), author: { login: this.owner } };
  }
  async editIssue(number, { addLabels, removeLabels, body } = {}) {
    const i = this.items.get(number);
    this.#applyLabels(i, addLabels, removeLabels);
    if (body !== undefined) i.body = body;
  }
  async commentIssue(number, body) { this.items.get(number).comments.push({ body }); }
  async closeIssue(number) { this.items.get(number).state = 'CLOSED'; }

  async createPr({ title, body, head, base, draft = true, labels = [] }) {
    const number = ++this.n;
    this.items.set(number, { kind: 'pr', number, title, body, head, base, draft, labels: [...labels], state: 'OPEN', comments: [] });
    return { number, url: `https://github.test/pull/${number}` };
  }
  #headSha(pr) { return git(this.origin, 'rev-parse', `refs/heads/${pr.head}`); }
  #files(pr) { return git(this.origin, 'diff', '--name-only', `${pr.base}...${pr.head}`).split('\n').filter(Boolean); }
  async pr(number) {
    const p = this.items.get(number);
    return { ...p, isDraft: p.draft, headRefName: p.head, headRefOid: this.#headSha(p), baseRefName: p.base, labels: this.#labels(p), files: this.#files(p).map((path) => ({ path })) };
  }
  async editPr(number, { title, body, addLabels, removeLabels } = {}) {
    const p = this.items.get(number);
    if (title) p.title = title;
    if (body !== undefined) p.body = body;
    this.#applyLabels(p, addLabels, removeLabels);
  }
  async markReady(number) { this.items.get(number).draft = false; }
  async commentPr(number, body) {
    this.items.get(number).comments.push({ body, author: this.owner, authorAssociation: 'OWNER', createdAt: this.#at() });
  }
  async prComments(number) { return this.items.get(number).comments; }
  async openPrs() {
    return [...this.items.values()].filter((i) => i.kind === 'pr' && i.state === 'OPEN')
      .map((p) => ({ number: p.number, title: p.title, body: p.body, headRefName: p.head, labels: this.#labels(p), isDraft: p.draft }));
  }

  /** Every required check passes, except review evidence, which is computed for real. */
  async checksForSha(sha) {
    const pr = [...this.items.values()].find((i) => i.kind === 'pr' && i.state === 'OPEN' && this.#headSha(i) === sha);
    const evidence = pr
      ? evaluateEvidence({ headSha: sha, labels: pr.labels, body: pr.body, files: this.#files(pr), comments: pr.comments }, this.config)
      : { state: 'failure', description: 'no PR' };
    return this.config.requiredChecks.map((name) => (name === 'gibson/review-evidence'
      ? { name, state: evidence.state === 'success' ? 'pass' : 'fail', description: evidence.description }
      : { name, state: 'pass' }));
  }
  async failedRunLog() { return ''; }

  async squashMerge(number, { subject, body, headSha }) {
    const p = this.items.get(number);
    if (this.#headSha(p) !== headSha) throw new Error('head moved (--match-head-commit)');
    const work = mkdtempSync(join(tmpdir(), 'fake-merge-'));
    try {
      git(work, 'clone', '-q', this.origin, '.');
      git(work, 'config', 'user.email', 'merge@example.com');
      git(work, 'config', 'user.name', 'merge');
      git(work, 'checkout', '-q', p.base);
      git(work, 'merge', '--squash', '-q', `origin/${p.head}`);
      git(work, 'commit', '-q', '-m', `${subject}\n\n${body}`);
      git(work, 'push', '-q', 'origin', p.base);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    p.state = 'MERGED';
    for (const m of body.matchAll(/Closes #(\d+)/g)) this.items.get(Number(m[1])).state = 'CLOSED';
  }
  async enableAutoMerge(number) {
    const p = this.items.get(number);
    await this.squashMerge(number, { subject: p.title, body: '', headSha: this.#headSha(p) });
  }
  async openInBrowser() {}
  async viewer() { return this.owner; }
}

/** Scripted vendors. Records every dispatch for assertions. */
export function fakeVendors({ rejectFirstReviewOf }) {
  const calls = [];
  const reviewed = new Map();
  const reply = (job, text) => ({ ok: true, text, vendor: job.vendor, model: 'fake-model', sessionId: `s-${calls.length}`, durationMs: 1, transcript: '' });
  const dispatch = async (job) => {
    calls.push({ role: job.role, vendor: job.vendor, access: job.access });
    if (job.role === 'planner') {
      return reply(job, '```json\n' + JSON.stringify({
        title: 'Feature docs and schema note', operatorSummary: 'You get a documented feature and a schema note.', problem: 'p', users: 'u',
        scope: ['docs', 'schema note'], nonScope: ['anything else'], architecture: 'a', risks: [{ risk: 'r', likelihood: 'low', mitigation: 'm' }],
        tier: 'C', tierReason: 'touches the schema', deliverables: [{ id: 'D1', name: 'docs', acceptanceCriteria: ['documented'] }],
        openQuestions: [], demoCommands: ['todo help'],
      }) + '\n```');
    }
    if (job.role === 'decomposer') {
      return reply(job, '```json\n' + JSON.stringify({ issues: [
        { key: 'I1', title: 'Document the feature', summary: 'docs', context: 'c', tier: 'A', tierReason: 'docs only', affectedArea: ['docs/**'], dependsOn: [], acceptanceCriteria: ['a doc exists', 'it is linked'], outOfScope: [] },
        { key: 'I2', title: 'Annotate the schema', summary: 'schema note', context: 'c', tier: 'C', tierReason: 'schema', affectedArea: ['src/infrastructure/storage/schema.ts'], dependsOn: ['I1'], acceptanceCriteria: ['schema annotated'], outOfScope: [] },
      ] }) + '\n```');
    }
    if (job.role === 'builder') {
      const { writeFileSync, appendFileSync, mkdirSync } = await import('node:fs');
      const number = Number(/## Issue #(\d+)/.exec(job.prompt)[1]);
      const ids = /Criteria: (AC-[\d.]+(?:, AC-[\d.]+)*)\./.exec(job.prompt)[1].split(", ");
      mkdirSync(join(job.cwd, 'test'), { recursive: true });
      writeFileSync(join(job.cwd, `test/fixture-${number}.test.ts`),
        `import { it } from 'node:test';\n${ids.map((id) => `it('[${id}] verified', () => {});`).join('\n')}\n`);
      if (/storage\/schema\.ts/.test(job.prompt.split('## Hard rules')[0])) {
        appendFileSync(join(job.cwd, 'src/infrastructure/storage/schema.ts'), '\n// Annotated by the fixture builder.\n');
      } else {
        mkdirSync(join(job.cwd, 'docs'), { recursive: true });
        appendFileSync(join(job.cwd, `docs/feature-${number}.md`), `revision ${calls.length}\n`);
      }
      return reply(job, 'done\n```json\n{"summary":"fixture change","criteria":[],"notes":""}\n```');
    }
    if (job.role === 'reviewer') {
      const pr = Number(/PR\s+#(\d+)/.exec(job.prompt)[1]);
      const n = (reviewed.get(pr) ?? 0) + 1;
      reviewed.set(pr, n);
      const reject = pr === rejectFirstReviewOf() && n === 1;
      return reply(job, `### Lenses\n| Lens | Result |\n|---|---|\n| Correctness | ${reject ? 'finding' : 'clear'} |\n\n### Findings\n${reject ? '- `docs/x.md:1` — kind: blocker; class: test-gap; trigger: x ⇒ y' : 'None.'}\n\nVERDICT: ${reject ? 'REQUEST_CHANGES' : 'APPROVE'}`);
    }
    if (job.role === 'ux-evaluator') return reply(job, '```json\n{"score":5,"pass":true,"exercised":["todo help → ok"],"findings":[]}\n```');
    throw new Error(`unexpected role ${job.role}`);
  };
  return { dispatch, calls };
}
