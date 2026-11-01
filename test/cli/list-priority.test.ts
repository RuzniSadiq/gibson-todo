import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Clock } from '../../src/application/ports.ts';
import { EXIT, run } from '../../src/cli/app.ts';
import type { Io } from '../../src/cli/output.ts';
import { JsonFileRepository } from '../../src/infrastructure/storage/json-file-repository.ts';
import { captureIo, tempDir } from '../helpers.ts';

// Sunday 2026-11-01, noon local time.
const SUNDAY_CLOCK: Clock = { now: () => new Date(2026, 10, 1, 12, 0, 0) };
const ESC = '\u001b[';

interface JsonTask {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
  dueDate: string | null;
  priority: string;
}

describe('list ordering, --priority filter and labels (real JSON store)', () => {
  let ctx: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  const todo = async (argv: string[], io: Io & { out(): string; err(): string } = captureIo()) => {
    const code = await run(argv, io, { repository: new JsonFileRepository(ctx.file), clock: SUNDAY_CLOCK });
    return { code, out: io.out(), err: io.err() };
  };
  const json = async (...argv: string[]) => {
    const r = await todo([...argv, '--json']);
    assert.equal(r.code, EXIT.ok, `${argv.join(' ')} failed: ${r.err}`);
    return JSON.parse(r.out);
  };
  const ids = async (...argv: string[]) => ((await json('list', ...argv)) as JsonTask[]).map((t) => t.id);
  const lineFor = (out: string, id: number) => out.split('\n').find((l) => l.includes(`#${id} `)) ?? '';

  /** low #1, normal #2, high #3, normal #4 */
  const seedMixed = async () => {
    await json('add', 'Water plants', '-p', 'low');
    await json('add', 'Reply to Sam');
    await json('add', 'Pay invoice', '--priority', 'high');
    await json('add', 'Book dentist');
  };

  it('[AC-23.1] list --json orders high, normal, low and keeps task-number order within a level', async () => {
    await seedMixed();
    assert.deepEqual(await ids(), [3, 2, 4, 1]);
    assert.deepEqual(await ids('--all'), [3, 2, 4, 1]);
    const text = await todo(['list']);
    assert.equal(text.code, EXIT.ok);
    const order = text.out.split('\n').filter((l) => /#\d+ /.test(l)).map((l) => Number(/#(\d+) /.exec(l)?.[1]));
    assert.deepEqual(order, [3, 2, 4, 1]);
  });

  it('[AC-23.1] with every task at normal, list --json keeps ascending task-number order', async () => {
    for (const title of ['a', 'b', 'c', 'd', 'e']) await json('add', title);
    await json('done', '2');
    assert.deepEqual(await ids(), [1, 3, 4, 5]);
    assert.deepEqual(await ids('--all'), [1, 2, 3, 4, 5]);
  });

  it('[AC-23.2] --priority high and -p high show only open high-priority tasks', async () => {
    await seedMixed();
    await json('add', 'Renew passport', '-p', 'high');
    await json('done', '5');
    assert.deepEqual(await ids('--priority', 'high'), [3]);
    assert.deepEqual(await ids('-p', 'high'), [3]);
    assert.deepEqual(await ids('--priority=HIGH'), [3]);
    assert.deepEqual(await ids('-p', 'normal'), [2, 4]);
  });

  it('[AC-23.2] --priority low --all includes completed low tasks; --done narrows to completed', async () => {
    await seedMixed();
    await json('add', 'Sort photos', '-p', 'low');
    await json('done', '1');
    assert.deepEqual(await ids('--priority', 'low'), [5]);
    assert.deepEqual(await ids('--priority', 'low', '--all'), [1, 5]);
    assert.deepEqual(await ids('-p', 'low', '--done'), [1]);
  });

  it('[AC-23.2] --priority high --overdue shows only overdue high-priority tasks', async () => {
    await json('add', 'Late high', '-p', 'high', '--due', '2026-10-30');
    await json('add', 'Late normal', '--due', '2026-10-30');
    await json('add', 'Future high', '-p', 'high', '--due', '2026-11-14');
    await json('add', 'Late high done', '-p', 'high', '--due', '2026-10-29');
    await json('done', '4');
    await json('add', 'Undated high', '-p', 'high');
    assert.deepEqual(await ids('--priority', 'high', '--overdue'), [1]);
    assert.deepEqual(await ids('--overdue'), [1, 2]);
    const text = await todo(['list', '-p', 'high', '-o']);
    assert.equal(text.code, EXIT.ok);
    assert.match(text.out, /#1 .*Late high/);
    assert.match(text.out, /1 overdue task\n$/);
  });

  it('[AC-23.3] --priority urgent exits 1 with a hint listing high, normal, low', async () => {
    await json('add', 'Pay invoice');
    for (const bad of ['urgent', '', 'hi', 'high\n']) {
      const text = await todo(['list', '--priority', bad]);
      assert.equal(text.code, EXIT.user, JSON.stringify(bad));
      assert.match(text.err, /error:/);
      assert.match(text.err, /hint:.*high.*normal.*low/);
      assert.equal(text.out, '');
    }
    const asJson = await todo(['list', '-p', 'urgent', '--json']);
    assert.equal(asJson.code, EXIT.user);
    const { error } = JSON.parse(asJson.err);
    assert.equal(error.code, 'VALIDATION');
    assert.match(error.message, /"urgent"/);
    assert.match(error.hint, /high.*normal.*low/);
  });

  it('[AC-23.3] a valid filter matching nothing prints one line naming the level and exits 0; --json prints []', async () => {
    await json('add', 'Reply to Sam');
    const text = await todo(['list', '--priority', 'high']);
    assert.equal(text.code, EXIT.ok);
    assert.equal(text.out, 'No high-priority tasks.\n');
    assert.equal(text.err, '');
    assert.equal((await todo(['list', '-p', 'low', '--all'])).out, 'No low-priority tasks.\n');
    assert.equal((await todo(['list', '-p', 'high', '--overdue'])).out, 'No overdue high-priority tasks.\n');
    assert.equal((await todo(['list', '-p', 'normal', '--done'])).out, 'No completed normal-priority tasks.\n');
    const asJson = await todo(['list', '--priority', 'high', '--json']);
    assert.equal(asJson.code, EXIT.ok);
    assert.deepEqual(JSON.parse(asJson.out), []);
  });

  it('[AC-23.4] high and low lines carry a label, normal lines carry none', async () => {
    await seedMixed();
    await json('due', '3', '2026-11-14');
    const { code, out } = await todo(['list']);
    assert.equal(code, EXIT.ok);
    // Columns (#28): priority then due, both padded, title last.
    assert.match(lineFor(out, 3), /\] {2}high {2}due Sat 14 Nov {2}Pay invoice$/);
    assert.match(lineFor(out, 1), /\] {2}low {19}Water plants$/);
    for (const id of [2, 4]) {
      const line = lineFor(out, id);
      assert.ok(line !== '' && !/\b(high|normal|low)\b/.test(line), `normal line should have no label: ${line}`);
    }
  });

  it('[AC-23.4] no ANSI codes with NO_COLOR or a non-terminal stdout; colour only on a terminal', async () => {
    await seedMixed();
    const pipe = await todo(['list'], { ...captureIo({ NO_COLOR: '' }), isTTY: false });
    assert.ok(!pipe.out.includes(ESC), 'non-TTY output must have no escape codes');
    assert.match(lineFor(pipe.out, 3), /high/);
    const noColor = await todo(['list'], { ...captureIo({ NO_COLOR: '1' }), isTTY: true });
    assert.ok(!noColor.out.includes(ESC), 'NO_COLOR output must have no escape codes');
    assert.match(lineFor(noColor.out, 1), /low/);
    const tty = await todo(['list'], { ...captureIo({ NO_COLOR: '' }), isTTY: true });
    assert.ok(tty.out.includes(`${ESC}33mhigh${ESC}39m`), `expected a coloured high label in ${JSON.stringify(tty.out)}`);
  });

  it('[AC-23.5] every list --json task has priority plus all earlier fields under the same names', async () => {
    await seedMixed();
    await json('due', '2', '2026-11-14');
    await json('done', '4');
    const listed: JsonTask[] = await json('list', '--all');
    assert.equal(listed.length, 4);
    for (const task of listed) {
      assert.deepEqual(Object.keys(task).sort(), ['completedAt', 'createdAt', 'done', 'dueDate', 'id', 'priority', 'title']);
    }
    const byId = new Map(listed.map((t) => [t.id, t]));
    assert.equal(byId.get(3)?.priority, 'high');
    assert.equal(byId.get(2)?.dueDate, '2026-11-14');
    assert.equal(byId.get(4)?.done, true);
    assert.equal(typeof byId.get(4)?.completedAt, 'string');
    assert.equal(byId.get(1)?.completedAt, null);
  });

  it('[AC-23.5] todo help list documents --priority with an example and the ordering', async () => {
    const { code, out } = await todo(['help', 'list']);
    assert.equal(code, EXIT.ok);
    assert.match(out, /--priority <level>/);
    assert.match(out, /todo list --priority high/);
    assert.match(out, /-p/);
    assert.match(out, /high priority first, then normal, then low/);
  });
});
