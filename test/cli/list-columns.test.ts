import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { EXIT, run } from '../../src/cli/app.ts';
import { renderTaskRows } from '../../src/cli/columns.ts';
import { createStyle } from '../../src/cli/output.ts';
import type { Task } from '../../src/domain/task.ts';
import { JsonFileRepository } from '../../src/infrastructure/storage/json-file-repository.ts';
import { captureIo, fixedClock, tempDir } from '../helpers.ts';

// Sunday 2026-11-01, noon in London (the local "today" is 2026-11-01).
const NOW = '2026-11-01T12:00:00.000Z';
const ESC = '\u001b[';

describe('todo list renders aligned columns, title last (#28)', () => {
  let previousTz: string | undefined;
  before(() => {
    previousTz = process.env['TZ'];
    process.env['TZ'] = 'Europe/London';
  });
  after(() => {
    if (previousTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previousTz;
  });

  let ctx: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  const todo = async (...argv: string[]) => {
    const io = captureIo({ NO_COLOR: '1' });
    const code = await run(argv, io, { repository: new JsonFileRepository(ctx.file), clock: fixedClock(NOW) });
    return { code, out: io.out(), err: io.err() };
  };
  const ok = async (...argv: string[]) => {
    const r = await todo(...argv);
    assert.equal(r.code, EXIT.ok, `${argv.join(' ')} failed: ${r.err}`);
    return r.out;
  };
  const taskRows = (out: string) => out.split('\n').filter((l) => /^ *#\d+ /.test(l));
  const titles = async (...argv: string[]) =>
    new Map((JSON.parse(await ok('list', ...argv, '--json')) as Task[]).map((t) => [t.id, t.title]));
  const rowId = (row: string) => Number(/#(\d+) /.exec(row)?.[1]);

  /** Every priority, every due state, done and open, titles of different lengths. */
  const seedMixed = async () => {
    await ok('add', 'Pay invoice', '-p', 'high', '--due', '2026-11-14'); //            #1 upcoming
    await ok('add', 'Call'); //                                                         #2 normal, no due
    await ok('add', 'Renew passport', '-p', 'low', '--due', '2027-01-14'); //          #3 another year
    await ok('add', 'Water plants', '-p', 'high', '--due', 'today'); //                #4 today
    await ok('add', 'Fix the leaking kitchen tap', '--due', '2026-10-30'); //          #5 overdue
    await ok('add', 'Sort photos', '-p', 'low', '--due', '2026-10-29'); //             #6 done, past date
    await ok('add', 'x'); //                                                            #7 done, no due
    await ok('done', '6', '7');
  };

  it('[AC-28.1] list --all aligns priority, due and title columns, and each row ends with its exact title', async () => {
    await seedMixed();
    const out = await ok('list', '--all');
    assert.ok(!out.includes(ESC), 'NO_COLOR output must have no escape codes');
    assert.equal(
      out,
      [
        '  #1  [ ]  high  due Sat 14 Nov       Pay invoice',
        '  #4  [ ]  high  due today            Water plants',
        '  #2  [ ]                             Call',
        '  #5  [ ]        overdue 2d           Fix the leaking kitchen tap',
        '  #7  [x]                             x',
        '  #3  [ ]  low   due Thu 14 Jan 2027  Renew passport',
        '  #6  [x]  low   due Thu 29 Oct       Sort photos',
        '',
        '5 open tasks · 2 done',
        '',
      ].join('\n'),
    );

    // The same property stated generally: shared column starts, exact title after the last gap.
    const byId = await titles('--all');
    const rows = taskRows(out);
    assert.equal(rows.length, 7);
    const titleStarts = new Set(rows.map((row) => row.length - (byId.get(rowId(row)) ?? '').length));
    assert.equal(titleStarts.size, 1, 'every title starts at the same position');
    const titleStart = [...titleStarts][0] ?? 0;
    for (const row of rows) {
      assert.equal(row.slice(titleStart), byId.get(rowId(row)), row);
      assert.equal(row.slice(titleStart - 2, titleStart), '  ', `a two-space gap precedes the title: ${row}`);
      // Priority column starts at 11, due column at 17 (after `high` + gap) on every row.
      assert.match(row.slice(11, 17), /^(high|low | {4}) {2}$/, row);
      assert.match(row.slice(17, titleStart), /^(due |overdue | {4})/, row);
    }
  });

  it('[AC-28.1] colour codes are applied after padding, so columns still line up on a terminal', async () => {
    await seedMixed();
    const io = { ...captureIo({ NO_COLOR: '' }), isTTY: true };
    assert.equal(await run(['list', '--all'], io, { repository: new JsonFileRepository(ctx.file), clock: fixedClock(NOW) }), EXIT.ok);
    const coloured = io.out();
    assert.ok(coloured.includes(`${ESC}33mhigh${ESC}39m  `), 'yellow high, padding outside the colour');
    assert.ok(coloured.includes(`${ESC}31moverdue 2d${ESC}39m           `), 'red overdue, padding outside the colour');
    // Stripping the escape codes yields exactly the NO_COLOR layout.
    const stripped = coloured.replaceAll(new RegExp(`${ESC.replace('[', '\\[')}\\d+m`, 'g'), '');
    assert.equal(stripped, await ok('list', '--all'));
  });

  it('[AC-28.2] a normal task shows a blank padded priority cell and no row has trailing whitespace', async () => {
    await seedMixed();
    for (const argv of [['list'], ['list', '--all'], ['list', '--done'], ['list', '--overdue']]) {
      const out = await ok(...argv);
      for (const line of out.split('\n')) assert.doesNotMatch(line, /\s$/, `trailing whitespace in ${argv.join(' ')}: ${JSON.stringify(line)}`);
    }
    const out = await ok('list');
    const call = taskRows(out).find((r) => r.endsWith('Call')) ?? '';
    const pay = taskRows(out).find((r) => r.endsWith('Pay invoice')) ?? '';
    assert.equal(call, `  #2  [ ]  ${' '.repeat(4)}  ${' '.repeat(19)}  Call`);
    assert.equal(call.indexOf('Call'), pay.indexOf('Pay invoice'));
    const fix = taskRows(out).find((r) => r.endsWith('Fix the leaking kitchen tap')) ?? '';
    assert.equal(fix.indexOf('overdue'), pay.indexOf('due Sat'), 'due values line up under each other');
  });

  it('[AC-28.3] columns without values are left out; plain normal tasks print exactly as before', async () => {
    await ok('add', 'Pay invoice');
    await ok('add', 'Call');
    assert.equal(await ok('list'), '  #1  [ ]  Pay invoice\n  #2  [ ]  Call\n\n2 open tasks · 0 done\n');

    await ok('priority', '2', 'high');
    assert.equal(await ok('list'), '  #2  [ ]  high  Call\n  #1  [ ]        Pay invoice\n\n2 open tasks · 0 done\n');

    await ok('priority', '2', 'normal');
    await ok('due', '1', '2026-11-14');
    assert.equal(await ok('list'), '  #1  [ ]  due Sat 14 Nov  Pay invoice\n  #2  [ ]                  Call\n\n2 open tasks · 0 done\n');
  });

  it('[AC-28.3] the id column widens for large ids and stays right-aligned', () => {
    const base = { done: false, createdAt: NOW, completedAt: null, dueDate: null, priority: 'normal' } as const;
    const tasks: Task[] = [
      { ...base, id: 7, title: 'small' },
      { ...base, id: 12345, title: 'large' },
    ];
    assert.deepEqual(renderTaskRows(tasks, createStyle(false), '2026-11-01'), ['    #7  [ ]  small', '#12345  [ ]  large']);
    assert.deepEqual(renderTaskRows([], createStyle(false), '2026-11-01'), []);
  });

  it('[AC-28.4] --priority high and --overdue use the column layout with unchanged footers', async () => {
    await seedMixed();
    assert.equal(
      await ok('list', '--priority', 'high'),
      '  #1  [ ]  high  due Sat 14 Nov  Pay invoice\n  #4  [ ]  high  due today       Water plants\n\n2 open tasks · 0 done\n',
    );
    assert.equal(await ok('list', '--overdue'), '  #5  [ ]  overdue 2d  Fix the leaking kitchen tap\n\n1 overdue task\n');
    assert.equal(
      await ok('list', '-p', 'low', '--all'),
      '  #3  [ ]  low  due Thu 14 Jan 2027  Renew passport\n  #6  [x]  low  due Thu 29 Oct       Sort photos\n\n1 open task · 1 done\n',
    );
  });

  it('[AC-28.4] every empty-list message is unchanged, including priority-filtered ones', async () => {
    assert.equal(await ok('list'), 'Nothing to do. Add a task with: todo add "..."\n');
    assert.equal(await ok('list', '--all'), 'No tasks yet.\n');
    assert.equal(await ok('list', '--done'), 'No completed tasks yet.\n');
    assert.equal(await ok('list', '--overdue'), 'Nothing overdue.\n');
    await ok('add', 'Call');
    assert.equal(await ok('list', '-p', 'high'), 'No high-priority tasks.\n');
    assert.equal(await ok('list', '-p', 'low', '--all'), 'No low-priority tasks.\n');
    assert.equal(await ok('list', '-p', 'normal', '--done'), 'No completed normal-priority tasks.\n');
    assert.equal(await ok('list', '-p', 'high', '--overdue'), 'No overdue high-priority tasks.\n');
  });

  it('[AC-28.5] list --json is byte-identical to the pre-change output for every filter', async () => {
    await seedMixed();
    // Golden output captured from the pre-#28 build for this store and clock.
    const task = (id: number, title: string, done: boolean, dueDate: string | null, priority: string) =>
      `  {\n    "id": ${id},\n    "title": "${title}",\n    "done": ${done},\n    "createdAt": "${NOW}",\n` +
      `    "completedAt": ${done ? `"${NOW}"` : 'null'},\n    "dueDate": ${dueDate === null ? 'null' : `"${dueDate}"`},\n` +
      `    "priority": "${priority}"\n  }`;
    const doc = (...items: string[]) => (items.length === 0 ? '[]\n' : `[\n${items.join(',\n')}\n]\n`);
    const t1 = task(1, 'Pay invoice', false, '2026-11-14', 'high');
    const t2 = task(2, 'Call', false, null, 'normal');
    const t3 = task(3, 'Renew passport', false, '2027-01-14', 'low');
    const t4 = task(4, 'Water plants', false, '2026-11-01', 'high');
    const t5 = task(5, 'Fix the leaking kitchen tap', false, '2026-10-30', 'normal');
    const t6 = task(6, 'Sort photos', true, '2026-10-29', 'low');
    const t7 = task(7, 'x', true, null, 'normal');

    assert.equal(await ok('list', '--json'), doc(t1, t4, t2, t5, t3));
    assert.equal(await ok('list', '--all', '--json'), doc(t1, t4, t2, t5, t7, t3, t6));
    assert.equal(await ok('list', '--done', '--json'), doc(t7, t6));
    assert.equal(await ok('list', '--overdue', '--json'), doc(t5));
    assert.equal(await ok('list', '--priority', 'high', '--json'), doc(t1, t4));
    assert.equal(await ok('list', '-p', 'low', '--all', '--json'), doc(t3, t6));
    assert.equal(await ok('list', '-p', 'high', '--overdue', '--json'), doc());
  });

  it('[AC-28.5] an invalid --priority and combined status flags fail exactly as before', async () => {
    await ok('add', 'Call');
    const bad = await todo('list', '--priority', 'urgent');
    assert.equal(bad.code, EXIT.user, 'an invalid priority value is a validation error (exit 1), unchanged');
    assert.equal(bad.out, '');
    assert.match(bad.err, /^error: "urgent" .*\nhint: .*high.*normal.*low/);
    const badJson = await todo('list', '-p', 'urgent', '--json');
    assert.equal(badJson.code, EXIT.user);
    assert.equal(JSON.parse(badJson.err).error.code, 'VALIDATION');

    for (const argv of [['list', '--all', '--done'], ['list', '--overdue', '--all'], ['list', '-o', '-d']]) {
      const r = await todo(...argv);
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.equal(r.out, '');
      assert.match(r.err, /^error: --\w+ and --\w+ can't be combined\.\nhint: Use only one of --all, --done or --overdue/);
    }
    const combinedJson = await todo('list', '--all', '--done', '--json');
    assert.equal(combinedJson.code, EXIT.usage);
    assert.equal(JSON.parse(combinedJson.err).error.code, 'USAGE');
  });
});
