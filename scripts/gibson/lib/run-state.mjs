// Run state lives OUTSIDE the canonical checkout (Law 3), under stateDir.
// Handoffs are files and GitHub objects, never chat memory.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const slugify = (text, max = 40) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'request';

export class Run {
  constructor(dir, state) {
    this.dir = dir;
    this.state = state;
  }

  static create(config, request) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const id = `${stamp}-${slugify(request, 30)}`;
    const dir = join(config.runsDir, id);
    mkdirSync(dir, { recursive: true });
    const run = new Run(dir, { id, request, createdAt: new Date().toISOString(), phase: 'plan', issues: [], events: [] });
    run.save();
    run.journal('RUN', `Request received: "${request}"`);
    return run;
  }

  static load(config, id) {
    const dir = join(config.runsDir, id);
    return new Run(dir, JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')));
  }

  static latest(config) {
    if (!existsSync(config.runsDir)) return null;
    const ids = readdirSync(config.runsDir).filter((d) => existsSync(join(config.runsDir, d, 'state.json'))).sort();
    return ids.length ? Run.load(config, ids.at(-1)) : null;
  }

  static all(config) {
    if (!existsSync(config.runsDir)) return [];
    return readdirSync(config.runsDir).sort().flatMap((id) => {
      try { return [Run.load(config, id)]; } catch { return []; }
    });
  }

  get id() { return this.state.id; }

  save() {
    writeFileSync(join(this.dir, 'state.json'), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  /** Append-only journal, the run's audit trail. */
  journal(stage, message) {
    const at = new Date().toISOString();
    this.state.events.push({ at, stage, message });
    appendFileSync(join(this.dir, 'journal.md'), `- \`${at}\` **${stage}** — ${message}\n`);
    this.save();
  }

  artifact(name, contents) {
    const path = join(this.dir, name);
    writeFileSync(path, contents);
    return path;
  }

  issue(number) {
    return this.state.issues.find((i) => i.number === number);
  }
}
