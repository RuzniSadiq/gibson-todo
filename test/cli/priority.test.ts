import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Clock } from '../../src/application/ports.ts';
import { EXIT, run } from '../../src/cli/app.ts';
import { JsonFileRepository } from '../../src/infrastructure/storage/json-file-repository.ts';
import { captureIo, tempDir } from '../helpers.ts';

// Sunday 2026-11-01, noon local time.
const SUNDAY_CLOCK: Clock = { now: () => new Date(2026, 10, 1, 12, 0, 0) };

interface JsonTask {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
  dueDate: string | null;
  priority: string;
}

const BAD_LEVELS = ['hi', 'urgent', '1', '', 'high\n'];

describe('priorities via the CLI (real JSON store)', () => {
  let ctx: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  const todo = async (...argv: string[]) => {
    const io = captureIo();
    const code = await run(argv, io, { repository: new JsonFileRepository(ctx.file), clock: SUNDAY_CLOCK });
    return { code, out: io.out(), err: io.err() };
  };
  const json = async (...argv: string[]) => {
    const r = await todo(...argv, '--json');
    assert.equal(r.code, EXIT.ok, `${argv.join(' ')} failed: ${r.err}`);
    return JSON.parse(r.out);
  };
  const onDisk = async (): Promise<{ tasks: JsonTask[] }> => JSON.parse(await readFile(ctx.file, 'utf8'));
  const exists = async () =>
    access(ctx.file).then(
      () => true,
      () => false,
    );

  it('[AC-22.1] add --priority high / -p low set the level; no flag means normal; persisted', async () => {
    assert.equal((await json('add', 'Pay invoice', '--priority', 'high')).priority, 'high');
    assert.equal((await json('add', 'Water plants', '-p', 'low')).priority, 'low');
    assert.equal((await json('add', 'No rush')).priority, 'normal');
    assert.deepEqual((await onDisk()).tasks.map((t) => t.priority), ['high', 'low', 'normal']);
    // Since #23, list sorts by priority (high, normal, low); the stored order above is unchanged.
    const listed: JsonTask[] = await json('list');
    assert.deepEqual(listed.map((t) => [t.id, t.priority]), [[1, 'high'], [3, 'normal'], [2, 'low']]);
  });

  it('[AC-22.1] --priority works with --due, and --priority HIGH stores high', async () => {
    const both = await json('add', 'Pay invoice', '--priority', 'high', '--due', 'tomorrow');
    assert.equal(both.priority, 'high');
    assert.equal(both.dueDate, '2026-11-02');
    const shouting = await json('add', 'Shout', '--priority', 'HIGH');
    assert.equal(shouting.priority, 'high');
    assert.equal((await onDisk()).tasks[1]?.priority, 'high');
    assert.equal((await json('add', 'Equals form', '--priority=low')).priority, 'low');
    const text = await todo('add', 'Text mode', '-p', 'high');
    assert.equal(text.code, EXIT.ok);
    assert.match(text.out, /Added\s+#4 {2}\[ \] {2}Text mode\n$/);
  });

  it('[AC-22.2] add with a bad level exits 1, names the value, hints the levels, creates nothing', async () => {
    // Empty store: the file must not even be created.
    for (const bad of BAD_LEVELS) {
      const r = await todo('add', 'X', '--priority', bad);
      assert.equal(r.code, EXIT.user, JSON.stringify(bad));
      assert.match(r.err, /error:/);
      assert.ok(r.err.includes(JSON.stringify(bad)), `error should name ${JSON.stringify(bad)}: ${r.err}`);
      assert.match(r.err, /hint:.*high.*normal.*low/);
    }
    assert.equal(await exists(), false);

    // Existing store: bytes unchanged.
    await json('add', 'Keep me');
    const before = await readFile(ctx.file, 'utf8');
    for (const bad of BAD_LEVELS) {
      const r = await todo('add', 'X', '--priority', bad, '--json');
      assert.equal(r.code, EXIT.user, JSON.stringify(bad));
      const { error } = JSON.parse(r.err);
      assert.equal(error.code, 'VALIDATION');
      assert.ok(error.message.includes(JSON.stringify(bad)));
      assert.match(error.hint, /high.*normal.*low/);
      assert.equal(await readFile(ctx.file, 'utf8'), before, `${JSON.stringify(bad)} must not touch the store`);
    }
    assert.equal((await json('list', '--all')).length, 1);
  });

  it('[AC-22.3] priority 3 low changes only the priority and keeps list position', async () => {
    await json('add', 'One');
    await json('add', 'Two');
    await json('add', 'Three', '--due', '2026-11-14', '-p', 'high');
    await json('add', 'Four');
    await json('done', '3');
    const before = (await onDisk()).tasks;

    const updated = await json('priority', '3', 'low');
    assert.equal(updated.id, 3);
    assert.equal(updated.priority, 'low');

    const after = (await onDisk()).tasks;
    assert.deepEqual(after.map((t) => t.id), [1, 2, 3, 4]);
    assert.deepEqual(after[2], { ...before[2], priority: 'low' });
    assert.deepEqual(updated, after[2]);
    assert.deepEqual([after[0], after[1], after[3]], [before[0], before[1], before[3]]);
    assert.equal(after[2]?.done, true);
    assert.equal(after[2]?.dueDate, '2026-11-14');
    assert.notEqual(after[2]?.completedAt, null);

    const text = await todo('priority', '#3', 'Normal');
    assert.equal(text.code, EXIT.ok);
    assert.match(text.out, /Priority normal\s+#3/);
    assert.equal((await onDisk()).tasks[2]?.priority, 'normal');
  });

  it('[AC-22.3] priority on an unknown id exits 1 with a list --all hint; bad level exits 1; store unchanged', async () => {
    await json('add', 'Pay invoice');
    const before = await readFile(ctx.file, 'utf8');

    const missing = await todo('priority', '99', 'high');
    assert.equal(missing.code, EXIT.user);
    assert.match(missing.err, /error:.*#99/);
    assert.match(missing.err, /hint:.*todo list --all/);
    const missingJson = await todo('priority', '99', 'high', '--json');
    assert.equal(JSON.parse(missingJson.err).error.code, 'NOT_FOUND');

    for (const bad of BAD_LEVELS) {
      const r = await todo('priority', '1', bad, '--json');
      assert.equal(r.code, EXIT.user, JSON.stringify(bad));
      assert.equal(JSON.parse(r.err).error.code, 'VALIDATION');
      assert.match(JSON.parse(r.err).error.hint, /high.*normal.*low/);
    }
    assert.equal(await readFile(ctx.file, 'utf8'), before);
  });

  it('[AC-22.4] priority without an id or a level exits 2 with a usage hint', async () => {
    await json('add', 'Pay invoice');
    const before = await readFile(ctx.file, 'utf8');
    for (const argv of [['priority'], ['priority', '3'], ['priority', '1'], ['add', 'x', '--priority']]) {
      const r = await todo(...argv);
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.match(r.err, /error:/);
      assert.match(r.err, /hint:/);
    }
    const asJson = await todo('priority', '3', '--json');
    assert.equal(asJson.code, EXIT.usage);
    assert.equal(JSON.parse(asJson.err).error.code, 'USAGE');
    assert.match(JSON.parse(asJson.err).error.hint, /todo priority 3 high/);
    assert.equal(await readFile(ctx.file, 'utf8'), before);
  });

  it('[AC-22.4] help priority shows summary, usage and examples; help add mentions --priority', async () => {
    const help = (await todo('help', 'priority')).out;
    assert.match(help, /^todo priority <id> <level>/);
    assert.match(help, /Set a task's priority/);
    assert.match(help, /Examples:\n\s+todo priority 3 /);
    assert.match((await todo('priority', '--help')).out, /Examples:/);
    const add = (await todo('help', 'add')).out;
    assert.match(add, /--priority/);
    assert.match(add, /todo add .*--priority high/);
    assert.match((await todo('help')).out, /\n {2}priority {2,}Set a task's priority/);
  });

  it('[AC-22.5] done, undo and edit keep a high priority', async () => {
    await json('add', 'Pay invoice', '--priority', 'high');
    await json('done', '1');
    assert.equal((await onDisk()).tasks[0]?.done, true);
    assert.equal((await onDisk()).tasks[0]?.priority, 'high');
    await json('undo', '1');
    assert.equal((await onDisk()).tasks[0]?.priority, 'high');
    await json('edit', '1', 'Pay the invoice');
    const [task] = (await onDisk()).tasks;
    assert.equal(task?.title, 'Pay the invoice');
    assert.equal(task?.priority, 'high');
    assert.equal((await json('list'))[0].priority, 'high');
  });
});

describe('priorities via the real binary', () => {
  let ctx: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
  const exec = promisify(execFile);
  const todo = async (...args: string[]) => {
    try {
      const { stdout } = await exec(process.execPath, [MAIN, ...args], {
        env: { ...process.env, TODO_FILE: ctx.file, NO_COLOR: '1' },
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it('[AC-22.1] add --priority high --json persists across invocations (real process)', async () => {
    const added = await todo('add', 'Pay invoice', '--priority', 'high', '--json');
    assert.equal(added.code, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).priority, 'high');
    assert.equal(JSON.parse((await todo('list', '--json')).stdout)[0].priority, 'high');
  });

  it('[AC-22.3] [AC-22.4] priority set and error exit codes (real process)', async () => {
    await todo('add', 'Pay invoice');
    assert.equal(JSON.parse((await todo('priority', '1', 'low', '--json')).stdout).priority, 'low');
    const before = await readFile(ctx.file, 'utf8');
    assert.equal((await todo('priority', '99', 'high')).code, 1);
    assert.equal((await todo('priority', '1', 'urgent')).code, 1);
    assert.equal((await todo('add', 'x', '--priority', 'hi')).code, 1);
    assert.equal((await todo('priority')).code, 2);
    assert.equal((await todo('priority', '1')).code, 2);
    assert.equal(await readFile(ctx.file, 'utf8'), before);
  });
});
