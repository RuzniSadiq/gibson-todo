import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Clock } from '../../src/application/ports.ts';
import { EXIT, run } from '../../src/cli/app.ts';
import type { Io } from '../../src/cli/output.ts';
import { JsonFileRepository } from '../../src/infrastructure/storage/json-file-repository.ts';
import { captureIo, tempDir } from '../helpers.ts';

// Node re-reads process.env.TZ on assignment, so each describe pins the zone it needs.
const ESC = '\u001b[';

function pinTz(zone: string): void {
  let previous: string | undefined;
  before(() => {
    previous = process.env['TZ'];
    process.env['TZ'] = zone;
  });
  after(() => {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  });
}

/** A real JSON store plus a clock the test can move. */
function harness() {
  let ctx: Awaited<ReturnType<typeof tempDir>>;
  let instant = new Date();
  const clock: Clock = { now: () => instant };
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  const at = (iso: string) => {
    instant = new Date(iso);
  };
  const todo = async (argv: string[], io: Io & { out(): string; err(): string } = captureIo()) => {
    const code = await run(argv, io, { repository: new JsonFileRepository(ctx.file), clock });
    return { code, out: io.out(), err: io.err() };
  };
  const ok = async (...argv: string[]) => {
    const r = await todo(argv);
    assert.equal(r.code, EXIT.ok, `${argv.join(' ')} failed: ${r.err}`);
    return r.out;
  };
  return { at, todo, ok };
}

/** The text line for task #id in `out`. */
const lineFor = (out: string, id: number): string => {
  const line = out.split('\n').find((l) => new RegExp(`#${id}\\b`).test(l));
  assert.ok(line, `no line for #${id} in:\n${out}`);
  return line;
};

describe('due labels in the list (TZ=Europe/London)', () => {
  pinTz('Europe/London');
  const { at, todo, ok } = harness();

  it('[AC-7.1] upcoming dates show `due Sat 14 Nov`, other years add the year', async () => {
    at('2026-11-01T12:00:00Z');
    await ok('add', 'Pay invoice', '--due', '2026-11-14');
    await ok('add', 'Renew passport', '--due', '2027-01-14');
    const out = await ok('list');
    assert.match(lineFor(out, 1), /^ {2}#1 {2}\[ \] {2}Pay invoice {2}due Sat 14 Nov$/);
    assert.match(lineFor(out, 2), /^ {2}#2 {2}\[ \] {2}Renew passport {2}due Thu 14 Jan 2027$/);
  });

  it('[AC-7.1] with the clock at 2026-11-16, a task due 14 Nov is `overdue 2d` and one due 16 Nov is `due today`', async () => {
    at('2026-11-01T12:00:00Z');
    await ok('add', 'Pay invoice', '--due', '2026-11-14');
    await ok('add', 'Call the bank', '--due', '2026-11-16');
    at('2026-11-16T12:00:00Z');
    const out = await ok('list');
    assert.match(lineFor(out, 1), /Pay invoice {2}overdue 2d$/);
    assert.match(lineFor(out, 2), /Call the bank {2}due today$/);
  });

  it('[AC-7.2] a completed task with a past due date is never overdue; no due date means no label', async () => {
    at('2026-11-01T12:00:00Z');
    await ok('add', 'Pay invoice', '--due', '2026-11-14');
    await ok('add', 'No rush');
    at('2026-11-16T12:00:00Z');
    const done = await ok('done', '1');
    assert.doesNotMatch(done, /overdue/);
    const out = await ok('list', '--all');
    assert.doesNotMatch(out, /overdue/);
    assert.match(lineFor(out, 1), /\[x\] {2}Pay invoice {2}due Sat 14 Nov$/);
    assert.match(lineFor(out, 2), /\[ \] {2}No rush$/);
  });

  it('[AC-7.2] colour off (non-TTY, or NO_COLOR on a TTY) prints no escape codes; colour on wraps overdue in red', async () => {
    at('2026-11-01T12:00:00Z');
    await ok('add', 'Pay invoice', '--due', '2026-11-14');
    await ok('add', 'Call the bank', '--due', '2026-11-20');
    at('2026-11-16T12:00:00Z');

    const pipe = await todo(['list'], { ...captureIo({ NO_COLOR: '' }), isTTY: false });
    assert.equal(pipe.code, EXIT.ok);
    assert.ok(!pipe.out.includes(ESC), 'non-TTY output must have no escape codes');
    assert.match(pipe.out, /overdue 2d/);

    const noColor = await todo(['list'], { ...captureIo({ NO_COLOR: '1' }), isTTY: true });
    assert.ok(!noColor.out.includes(ESC), 'NO_COLOR output must have no escape codes');
    assert.match(noColor.out, /overdue 2d/);

    const tty = await todo(['list'], { ...captureIo({ NO_COLOR: '' }), isTTY: true });
    assert.ok(tty.out.includes(`${ESC}31moverdue 2d${ESC}39m`), `expected red overdue label in ${JSON.stringify(tty.out)}`);
    assert.ok(!lineFor(tty.out, 2).includes(`${ESC}31m`), 'only overdue labels are red');
  });
});

describe('overdue counts follow the local calendar (TZ=Pacific/Auckland)', () => {
  pinTz('Pacific/Auckland');
  const { at, ok } = harness();

  it('[AC-7.3] instants just before and after local midnight give local-date overdue counts, not UTC', async () => {
    at('2026-11-10T00:00:00Z');
    await ok('add', 'Pay invoice', '--due', '2026-11-14');

    // NZDT is UTC+13: local midnight starting 16 Nov is 2026-11-15T11:00Z. Both instants are 15 Nov in UTC.
    at('2026-11-15T10:59:00Z'); // 23:59 on Sun 15 Nov in Auckland
    assert.match(await ok('list'), /Pay invoice {2}overdue 1d$/m);
    at('2026-11-15T11:01:00Z'); // 00:01 on Mon 16 Nov in Auckland
    assert.match(await ok('list'), /Pay invoice {2}overdue 2d$/m);

    // And the same edge for `due today` → overdue: midnight starting 15 Nov is 2026-11-14T11:00Z.
    at('2026-11-14T10:59:00Z');
    assert.match(await ok('list'), /Pay invoice {2}due today$/m);
    at('2026-11-14T11:01:00Z');
    assert.match(await ok('list'), /Pay invoice {2}overdue 1d$/m);
    assert.equal((JSON.parse(await ok('list', '--overdue', '--json')) as unknown[]).length, 1);
  });
});

describe('todo list --overdue (TZ=Europe/London)', () => {
  pinTz('Europe/London');
  const { at, todo, ok } = harness();

  const seed = async () => {
    at('2026-11-01T12:00:00Z');
    await ok('add', 'Overdue A', '--due', '2026-11-10'); // #1 overdue
    await ok('add', 'Due today', '--due', '2026-11-16'); // #2
    await ok('add', 'No date'); //                          #3
    await ok('add', 'Done late', '--due', '2026-11-02'); // #4 completed
    await ok('add', 'Upcoming', '--due', '2026-11-30'); //  #5
    await ok('add', 'Overdue B', '--due', '2026-11-15'); // #6 overdue
    await ok('done', '4');
    at('2026-11-16T12:00:00Z');
  };

  it('[AC-7.4] --overdue and -o list only open tasks due before today, in list order', async () => {
    await seed();
    for (const flag of ['--overdue', '-o']) {
      const out = await ok('list', flag);
      const ids = [...out.matchAll(/#(\d+) /g)].map((m) => Number(m[1]));
      assert.deepEqual(ids, [1, 6], flag);
      assert.match(lineFor(out, 1), /Overdue A {2}overdue 6d$/);
      assert.match(lineFor(out, 6), /Overdue B {2}overdue 1d$/);
    }
    const ls = await ok('ls', '-o');
    assert.deepEqual([...ls.matchAll(/#(\d+) /g)].map((m) => Number(m[1])), [1, 6]);
  });

  it('[AC-7.4] --overdue --json prints exactly the overdue tasks, each with dueDate', async () => {
    await seed();
    const tasks = JSON.parse(await ok('list', '--overdue', '--json')) as { id: number; dueDate: string; done: boolean }[];
    assert.ok(Array.isArray(tasks));
    assert.deepEqual(
      tasks.map((t) => [t.id, t.dueDate, t.done]),
      [
        [1, '2026-11-10', false],
        [6, '2026-11-15', false],
      ],
    );
  });

  it('[AC-7.4] with nothing overdue it exits 0 and prints `Nothing overdue.`', async () => {
    at('2026-11-01T12:00:00Z');
    await ok('add', 'Due today', '--due', '2026-11-01');
    await ok('add', 'No date');
    const r = await todo(['list', '--overdue']);
    assert.equal(r.code, EXIT.ok);
    assert.equal(r.out, 'Nothing overdue.\n');
    assert.deepEqual(JSON.parse(await ok('list', '-o', '--json')), []);
  });

  it('[AC-7.5] --overdue with --all or --done is a usage error (exit 2) with error: and hint:', async () => {
    await seed();
    for (const argv of [
      ['list', '--overdue', '--all'],
      ['list', '--overdue', '--done'],
      ['list', '-o', '-a'],
      ['list', '-o', '-d'],
    ]) {
      const r = await todo(argv);
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.equal(r.out, '');
      assert.match(r.err, /^error: .*--overdue.*\nhint: /, argv.join(' '));
    }
    const asJson = await todo(['list', '--overdue', '--all', '--json']);
    assert.equal(asJson.code, EXIT.usage);
    assert.equal(JSON.parse(asJson.err).error.code, 'USAGE');
  });

  it('[AC-7.5] `todo help list` documents --overdue with an example', async () => {
    const help = await ok('help', 'list');
    assert.match(help, /^todo list .*--overdue/);
    assert.match(help, /Examples:[\s\S]*\n\s+todo list --overdue/);
    assert.match(await ok('list', '--help'), /--overdue/);
  });
});
