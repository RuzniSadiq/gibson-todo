// Thin wrapper over the `gh` CLI. Every call names the repo explicitly so it
// never depends on (or mutates) the current directory's checkout.
import { must, run } from './exec.mjs';

export class GitHub {
  constructor(repo) {
    this.repo = repo;
  }

  async #gh(args, opts = {}) {
    return must('gh', [...args, '-R', this.repo], { timeoutSec: 120, ...opts });
  }

  async #api(path, args = []) {
    return JSON.parse(await must('gh', ['api', `repos/${this.repo}/${path}`, ...args], { timeoutSec: 120 }));
  }

  async createIssue({ title, body, labels = [] }) {
    const url = (await this.#gh(['issue', 'create', '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])], { input: body })).trim();
    return { number: Number(url.split('/').at(-1)), url };
  }

  async issue(number) {
    return JSON.parse(await this.#gh(['issue', 'view', String(number), '--json', 'number,title,body,state,labels,author,url']));
  }

  async editIssue(number, { addLabels = [], removeLabels = [], body } = {}) {
    const args = ['issue', 'edit', String(number)];
    for (const l of addLabels) args.push('--add-label', l);
    for (const l of removeLabels) args.push('--remove-label', l);
    if (body !== undefined) args.push('--body-file', '-');
    if (args.length > 3) await this.#gh(args, { input: body });
  }

  async commentIssue(number, body) {
    await this.#gh(['issue', 'comment', String(number), '--body-file', '-'], { input: body });
  }

  async closeIssue(number, comment) {
    await this.#gh(['issue', 'close', String(number), ...(comment ? ['--comment', comment] : [])]);
  }

  async createPr({ title, body, head, base, draft = true, labels = [] }) {
    const args = ['pr', 'create', '--title', title, '--body-file', '-', '--head', head, '--base', base];
    if (draft) args.push('--draft');
    for (const l of labels) args.push('--label', l);
    const url = (await this.#gh(args, { input: body })).trim();
    return { number: Number(url.split('/').at(-1)), url };
  }

  async pr(number) {
    return JSON.parse(await this.#gh(['pr', 'view', String(number), '--json',
      'number,title,body,state,isDraft,headRefName,headRefOid,baseRefName,labels,url,mergedAt,files,mergeStateStatus']));
  }

  async editPr(number, { title, body, addLabels = [], removeLabels = [] } = {}) {
    const args = ['pr', 'edit', String(number)];
    if (title) args.push('--title', title);
    if (body !== undefined) args.push('--body-file', '-');
    for (const l of addLabels) args.push('--add-label', l);
    for (const l of removeLabels) args.push('--remove-label', l);
    if (args.length > 3) await this.#gh(args, { input: body });
  }

  async markReady(number) {
    await this.#gh(['pr', 'ready', String(number)]);
  }

  async commentPr(number, body) {
    await this.#gh(['pr', 'comment', String(number), '--body-file', '-'], { input: body });
  }

  /** Squash-merge, pinned to the exact head we verified (--match-head-commit). */
  async squashMerge(number, { subject, body, headSha }) {
    await this.#gh(['pr', 'merge', String(number), '--squash', '--subject', subject, '--body', body, '--match-head-commit', headSha], { timeoutSec: 180 });
  }

  async openPrs() {
    return JSON.parse(await this.#gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,body,headRefName,labels,isDraft,url']));
  }

  async listIssues({ labels = [], state = 'open', limit = 50 } = {}) {
    return JSON.parse(await this.#gh(['issue', 'list', '--state', state, '--limit', String(limit), ...labels.flatMap((l) => ['--label', l]), '--json', 'number,title,labels,state,url,closedAt']));
  }

  async mergedPrs(limit = 10) {
    return JSON.parse(await this.#gh(['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,title,mergedAt,labels,url']));
  }

  /** Check runs + commit statuses on a SHA, normalized to {name, state}. */
  async checksForSha(sha) {
    const runs = await this.#api(`commits/${sha}/check-runs?per_page=100`);
    const statuses = await this.#api(`commits/${sha}/status`);
    const out = new Map();
    for (const r of runs.check_runs ?? []) {
      const state = r.status !== 'completed' ? 'pending'
        : ['success', 'skipped', 'neutral'].includes(r.conclusion) ? 'pass' : 'fail';
      out.set(r.name, { name: r.name, state, url: r.html_url });
    }
    for (const s of statuses.statuses ?? []) {
      if (out.has(s.context)) continue; // newest first
      out.set(s.context, { name: s.context, state: s.state === 'success' ? 'pass' : s.state === 'pending' ? 'pending' : 'fail', url: s.target_url, description: s.description });
    }
    return [...out.values()];
  }

  async failedRunLog(sha) {
    const runs = await this.#api(`actions/runs?head_sha=${sha}&per_page=20`);
    const failed = (runs.workflow_runs ?? []).find((r) => r.conclusion === 'failure');
    if (!failed) return '';
    const result = await run('gh', ['run', 'view', String(failed.id), '--log-failed', '-R', this.repo], { timeoutSec: 120 });
    return result.stdout.split('\n').slice(-120).join('\n');
  }


  async viewer() {
    return (await must('gh', ['api', 'user', '--jq', '.login'], { timeoutSec: 60 })).trim();
  }
}
