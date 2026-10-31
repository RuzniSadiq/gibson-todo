import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Clock } from '../../src/application/ports.ts';
import { EXIT, run } from '../../src/cli/app.ts';
import { JsonFileRepository } from '../../src/infrastructure/storage/json-file-repository.ts';
import { captureIo, tempDir } from '../helpers.ts';

// Sunday 2026-11-01, noon, built from local fields: the local calendar date is
// 1 Nov regardless of the time zone the tests run in.
const SUNDAY_CLOCK: Clock = { now: () => new Date(2026, 10, 1, 12, 0, 0) };

describe('due dates via the CLI (real JSON store)', () => {
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
  const onDisk = async () => JSON.parse(await readFile(ctx.file, 'utf8'));

  it('[AC-6.1] add --due YYYY-MM-DD stores the date and list --json shows it', async () => {
    const added = await json('add', 'Pay invoice', '--due', '2026-11-14');
    assert.equal(added.title, 'Pay invoice');
    assert.equal(added.dueDate, '2026-11-14');
    const listed = await json('list');
    assert.equal(listed.find((t: { id: number }) => t.id === added.id).dueDate, '2026-11-14');
    assert.equal((await onDisk()).tasks[0].dueDate, '2026-11-14');
  });

  it('[AC-6.1] add without --due keeps dueDate null', async () => {
    assert.equal((await json('add', 'No rush')).dueDate, null);
  });

  it('[AC-6.2] add --due resolves today, tomorrow, friday, FRI and sunday on Sunday 2026-11-01', async () => {
    const cases: [string, string][] = [
      ['today', '2026-11-01'],
      ['tomorrow', '2026-11-02'],
      ['friday', '2026-11-06'],
      ['FRI', '2026-11-06'],
      ['sunday', '2026-11-01'],
    ];
    for (const [when, expected] of cases) {
      assert.equal((await json('add', `task ${when}`, '--due', when)).dueDate, expected, when);
    }
    assert.deepEqual((await json('list')).map((t: { dueDate: string }) => t.dueDate), cases.map(([, d]) => d));
  });

  it('[AC-6.3] due <id> <date> sets and due <id> --clear clears, persisted', async () => {
    const { id } = await json('add', 'Pay invoice');
    const set = await json('due', String(id), '2026-11-20');
    assert.equal(set.id, id);
    assert.equal(set.dueDate, '2026-11-20');
    assert.equal((await onDisk()).tasks[0].dueDate, '2026-11-20');
    assert.equal((await json('list'))[0].dueDate, '2026-11-20');

    const cleared = await json('due', String(id), '--clear');
    assert.equal(cleared.dueDate, null);
    assert.equal((await onDisk()).tasks[0].dueDate, null);
    assert.equal((await json('list'))[0].dueDate, null);
  });

  it('[AC-6.3] due accepts relative forms and #id, and prints a friendly text line', async () => {
    await json('add', 'Pay invoice');
    assert.equal((await json('due', '#1', 'fri')).dueDate, '2026-11-06');
    const text = await todo('due', '1', '2026-11-14');
    assert.equal(text.code, EXIT.ok);
    assert.match(text.out, /Due\s+#1 {2}\[ \] {2}Pay invoice {2}due Sat 14 Nov 2026/);
    assert.match((await todo('due', '1', '--clear')).out, /Cleared due date\s+#1/);
    assert.match((await todo('add', 'x', '--due', 'tomorrow')).out, /Added\s+#2 {2}\[ \] {2}x {2}due Mon 2 Nov 2026/);
  });

  it('[AC-6.4] invalid dates exit 1 with error + hint and leave the store unchanged', async () => {
    await json('add', 'Pay invoice', '--due', '2026-11-14');
    const before = await readFile(ctx.file, 'utf8');
    for (const argv of [['add', 'x', '--due', 'someday'], ['due', '1', '2026-13-01']]) {
      const r = await todo(...argv);
      assert.equal(r.code, EXIT.user, argv.join(' '));
      assert.match(r.err, /error:/);
      assert.match(r.err, /hint:.*YYYY-MM-DD.*today.*tomorrow.*weekday/);
      assert.equal(await readFile(ctx.file, 'utf8'), before, `${argv.join(' ')} must not touch the store`);
    }
    const asJson = await todo('due', '1', 'someday', '--json');
    assert.equal(asJson.code, EXIT.user);
    assert.equal(JSON.parse(asJson.err).error.code, 'VALIDATION');
    assert.match(JSON.parse(asJson.err).error.hint, /YYYY-MM-DD/);
  });

  it('[AC-6.4] due on an unknown task is NOT_FOUND (exit 1); malformed due calls exit 2', async () => {
    await json('add', 'Pay invoice');
    const before = await readFile(ctx.file, 'utf8');
    const missing = await todo('due', '999', 'friday', '--json');
    assert.equal(missing.code, EXIT.user);
    assert.equal(JSON.parse(missing.err).error.code, 'NOT_FOUND');

    for (const argv of [['due'], ['due', '1', 'friday', '--clear'], ['due', '1'], ['due', '--clear'], ['add', 'x', '--due']]) {
      const r = await todo(...argv);
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.match(r.err, /error:/);
    }
    assert.equal(await readFile(ctx.file, 'utf8'), before);
  });

  it('[AC-6.5] help due shows summary, usage and examples; help add mentions --due', async () => {
    const due = (await todo('help', 'due')).out;
    assert.match(due, /^todo due <id> \(<when> \| --clear\)/);
    assert.match(due, /Set or clear a task's due date/);
    assert.match(due, /Examples:\n\s+todo due 3 /);
    assert.match((await todo('due', '--help')).out, /Examples:/);
    const add = (await todo('help', 'add')).out;
    assert.match(add, /--due/);
    assert.match(add, /todo add .*--due friday/);
    assert.match((await todo('help')).out, /\n {2}due {2,}Set or clear a task's due date/);
  });
});

describe('due dates via the real binary', () => {
  let ctx: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
  const exec = promisify(execFile);
  const todo = async (...args: string[]) => {
    try {
      const { stdout } = await exec(process.execPath, [MAIN, ...args], {
        env: { ...process.env, TODO_FILE: ctx.file, NO_COLOR: '1', TZ: 'Europe/Lisbon' },
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it('[AC-6.1] add --due 2026-11-14 --json persists across invocations (real process)', async () => {
    const added = await todo('add', 'Pay invoice', '--due', '2026-11-14', '--json');
    assert.equal(added.code, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).dueDate, '2026-11-14');
    assert.equal(JSON.parse((await todo('list', '--json')).stdout)[0].dueDate, '2026-11-14');
  });

  it('[AC-6.3] due set / --clear persist across invocations (real process)', async () => {
    await todo('add', 'Pay invoice');
    assert.equal(JSON.parse((await todo('due', '1', '2026-11-20', '--json')).stdout).dueDate, '2026-11-20');
    assert.equal(JSON.parse((await todo('list', '--json')).stdout)[0].dueDate, '2026-11-20');
    assert.equal(JSON.parse((await todo('due', '1', '--clear', '--json')).stdout).dueDate, null);
    assert.equal(JSON.parse((await todo('list', '--json')).stdout)[0].dueDate, null);
  });

  it('[AC-6.4] invalid date and usage errors keep their exit codes (real process)', async () => {
    await todo('add', 'Pay invoice');
    const before = await readFile(ctx.file, 'utf8');
    const bad = await todo('add', 'x', '--due', 'someday');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /error:[\s\S]*hint:.*YYYY-MM-DD/);
    assert.equal((await todo('due', '1', '2026-13-01')).code, 1);
    assert.equal((await todo('due', '999', 'friday')).code, 1);
    assert.equal((await todo('due')).code, 2);
    assert.equal((await todo('due', '1', 'friday', '--clear')).code, 2);
    assert.equal(await readFile(ctx.file, 'utf8'), before);
  });
});
