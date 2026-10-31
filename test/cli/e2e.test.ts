import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { tempDir } from '../helpers.ts';

const exec = promisify(execFile);
const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

describe('todo binary (real process)', () => {
  let ctx: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  const todo = async (...args: string[]) => {
    try {
      const { stdout } = await exec(process.execPath, [MAIN, ...args], { env: { ...process.env, TODO_FILE: ctx.file, NO_COLOR: '1' } });
      return { code: 0, stdout };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it('[AC-1.1] persists tasks across invocations via TODO_FILE', async () => {
    await todo('add', 'Persist', 'me');
    const listed = await todo('list', '--json');
    assert.equal(JSON.parse(listed.stdout)[0].title, 'Persist me');
  });

  it('[AC-1.1] runs add → list → done → undo → edit → rm → clear against the JSON store (real process)', async () => {
    const json = async (...args: string[]) => {
      const r = await todo(...args, '--json');
      assert.equal(r.code, 0, `${args.join(' ')} failed: ${r.stderr}`);
      return JSON.parse(r.stdout);
    };
    assert.equal((await json('add', 'Buy milk')).id, 1);
    assert.equal((await json('add', 'Ship release')).id, 2);
    assert.equal((await json('add', 'Water plants')).id, 3);
    assert.equal((await json('done', '1', '2'))[1].done, true);
    assert.deepEqual((await json('list')).map((t: { id: number }) => t.id), [3]);
    assert.equal((await json('undo', '2'))[0].done, false);
    assert.equal((await json('edit', '2', 'Ship', 'v2')).title, 'Ship v2');
    assert.equal((await json('rm', '3'))[0].id, 3);
    assert.deepEqual(await json('clear'), { removed: 1 });
    const remaining = await json('list', '--all');
    assert.deepEqual(remaining.map((t: { id: number; title: string; done: boolean }) => [t.id, t.title, t.done]), [[2, 'Ship v2', false]]);
    const onDisk = JSON.parse(await readFile(ctx.file, 'utf8'));
    assert.equal(onDisk.schemaVersion, 3);
    assert.equal(onDisk.nextId, 4, 'ids are never reused');
  });

  it('[AC-1.2] a write attempt never modifies a file from a newer version (real process)', async () => {
    const { writeFile } = await import('node:fs/promises');
    const future = `${JSON.stringify({ schemaVersion: 999, nextId: 7, tasks: [], futureField: { keep: true } })}\n`;
    await writeFile(ctx.file, future);
    for (const args of [['add', 'x'], ['done', '1'], ['clear'], ['rm', '1']]) {
      const result = await todo(...args);
      assert.equal(result.code, 3, `${args[0]} must fail with the storage status`);
      assert.equal(await readFile(ctx.file, 'utf8'), future, `${args[0]} must leave the file byte-for-byte unchanged`);
    }
  });

  it('[AC-1.3] separate concurrent `todo add` processes never lose or duplicate a task', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => todo('add', `parallel ${i}`, '--json')));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const ids = results.map((r) => JSON.parse(r.stdout).id).sort((a: number, b: number) => a - b);
    assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => i + 1));
    const listed = JSON.parse((await todo('list', '--json')).stdout);
    assert.equal(listed.length, 12);
  });

  it('[AC-1.3] a writer killed at any moment leaves the old or the new file, never a torn one', async () => {
    await todo('add', 'seed');
    for (let round = 0; round < 15; round += 1) {
      const before = JSON.parse(await readFile(ctx.file, 'utf8')).tasks.length;
      const child = spawn(process.execPath, [MAIN, 'add', `round ${round}`], { env: { ...process.env, TODO_FILE: ctx.file }, stdio: 'ignore' });
      const closed = new Promise((r) => child.once('close', r)); // listen before killing: it may already be done
      await new Promise((r) => setTimeout(r, 20 + ((round * 37) % 90)));
      child.kill('SIGKILL');
      await closed;
      const doc = JSON.parse(await readFile(ctx.file, 'utf8')); // must always parse completely
      assert.ok([before, before + 1].includes(doc.tasks.length), `round ${round}: ${doc.tasks.length} tasks after ${before}`);
      await rm(`${ctx.file}.lock`, { force: true }); // what the user is told to do after a crash
    }
    const listed = await todo('list', '--all', '--json');
    assert.equal(listed.code, 0, 'the store is still fully usable');
  });

  it('[AC-5.1] a checked-in v1 store loads through the CLI with dueDate null and is rewritten as the current version on the next write (real process)', async () => {
    const { copyFile } = await import('node:fs/promises');
    const fixture = fileURLToPath(new URL('../fixtures/store-v1.json', import.meta.url));
    await copyFile(fixture, ctx.file);
    const v1 = JSON.parse(await readFile(fixture, 'utf8'));

    const listed = await todo('list', '--all', '--json');
    assert.equal(listed.code, 0, listed.stderr);
    const tasks = JSON.parse(listed.stdout) as Record<string, unknown>[];
    assert.deepEqual(tasks.map((t) => t['id']), [1, 2, 4]);
    for (const t of tasks) assert.equal(t['dueDate'], null);
    assert.equal(await readFile(ctx.file, 'utf8'), await readFile(fixture, 'utf8'), 'a read never rewrites the file');

    const added = await todo('add', 'y', '--json');
    assert.equal(added.code, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).id, 5, 'nextId from the v1 file is honoured');

    const onDisk = JSON.parse(await readFile(ctx.file, 'utf8'));
    assert.equal(onDisk.schemaVersion, 3);
    assert.equal(onDisk.nextId, 6);
    for (const [i, old] of v1.tasks.entries()) {
      assert.deepEqual(onDisk.tasks[i], { ...old, dueDate: null, priority: 'normal' }, `task ${old.id} keeps every v1 field unchanged`);
    }
    assert.equal(onDisk.tasks[3].title, 'y');
    assert.equal(onDisk.tasks[3].dueDate, null);
  });

  for (const bad of ['"2026-02-30"', '"14/11/2026"', '42']) {
    it(`[AC-5.3] a v2 file with dueDate ${bad} is refused with the storage status and left unchanged (real process)`, async () => {
      const { writeFile } = await import('node:fs/promises');
      const content = `{"schemaVersion":2,"nextId":2,"tasks":[{"id":1,"title":"a","done":false,"createdAt":"2026-10-30T09:00:00.000Z","completedAt":null,"dueDate":${bad}}]}\n`;
      await writeFile(ctx.file, content);
      for (const args of [['list'], ['add', 'x']]) {
        const result = await todo(...args);
        assert.equal(result.code, 3, `${args.join(' ')} must exit with the storage status`);
        assert.match(result.stderr ?? '', /dueDate/, 'the error names the bad field');
        assert.match(result.stderr ?? '', /hint/i, 'the error carries a hint');
        assert.equal(await readFile(ctx.file, 'utf8'), content, `${args.join(' ')} must leave the file byte-for-byte unchanged`);
      }
    });
  }

  it('[AC-5.4] [AC-21.4] a schemaVersion 4 file is refused as written by a newer version and left unchanged (real process)', async () => {
    const { copyFile, writeFile } = await import('node:fs/promises');
    const inline = `${JSON.stringify({ schemaVersion: 4, nextId: 1, tasks: [] })}\n`;
    const fixture = await readFile(new URL('../fixtures/ux/store-v4.json', import.meta.url), 'utf8');
    for (const content of [inline, fixture]) {
      if (content === fixture) await copyFile(new URL('../fixtures/ux/store-v4.json', import.meta.url), ctx.file);
      else await writeFile(ctx.file, content);
      for (const args of [['list'], ['add', 'x'], ['done', '1']]) {
        const result = await todo(...args);
        assert.equal(result.code, 3, `${args.join(' ')} must exit with the storage status`);
        assert.match(result.stderr ?? '', /written by a newer version/);
        assert.match(result.stderr ?? '', /^hint:/m);
        assert.equal(await readFile(ctx.file, 'utf8'), content, `${args.join(' ')} must leave the file byte-for-byte unchanged`);
      }
    }
  });

  const copyV2Fixture = async () => {
    const { copyFile } = await import('node:fs/promises');
    const fixture = fileURLToPath(new URL('../fixtures/store-v2.json', import.meta.url));
    await copyFile(fixture, ctx.file);
    return JSON.parse(await readFile(fixture, 'utf8')) as { schemaVersion: number; nextId: number; tasks: Record<string, unknown>[] };
  };

  it('[AC-21.2] `todo add` against a v2 store rewrites it as v3 with every earlier task unchanged apart from priority normal (real process)', async () => {
    const v2 = await copyV2Fixture();
    assert.equal(v2.schemaVersion, 2);
    const added = await todo('add', 'Call mum', '--json');
    assert.equal(added.code, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).id, v2.nextId, 'nextId from the v2 file is honoured');
    assert.equal(JSON.parse(added.stdout).priority, 'normal');

    const onDisk = JSON.parse(await readFile(ctx.file, 'utf8'));
    assert.equal(onDisk.schemaVersion, 3);
    assert.equal(onDisk.nextId, v2.nextId + 1);
    assert.equal(onDisk.tasks.length, v2.tasks.length + 1);
    for (const [i, old] of v2.tasks.entries()) {
      assert.deepEqual(onDisk.tasks[i], { ...old, priority: 'normal' }, `task ${String(old['id'])} keeps every v2 field unchanged`);
    }
    assert.equal(onDisk.tasks.at(-1).title, 'Call mum');
    assert.equal(onDisk.tasks.at(-1).priority, 'normal');
  });

  it('[AC-21.2] the release smoke sequence (add → list --json → done → help) succeeds against a store that starts as v2 (real process)', async () => {
    const v2 = await copyV2Fixture();
    const add = await todo('add', 'Smoke test');
    assert.equal(add.code, 0, add.stderr);
    const list = await todo('list', '--json');
    assert.equal(list.code, 0, list.stderr);
    const listed = JSON.parse(list.stdout) as { id: number; title: string; priority: string }[];
    const smoke = listed.find((t) => t.title === 'Smoke test');
    assert.ok(smoke, 'the new task is listed');
    assert.ok(listed.every((t) => t.priority === 'normal'));
    const done = await todo('done', String(smoke.id));
    assert.equal(done.code, 0, done.stderr);
    const help = await todo('help');
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /todo/);
    const onDisk = JSON.parse(await readFile(ctx.file, 'utf8'));
    assert.equal(onDisk.schemaVersion, 3);
    assert.equal(onDisk.tasks.length, v2.tasks.length + 1);
  });

  for (const [label, priorityJson] of [['missing', null], ['"urgent"', '"urgent"'], ['"High"', '"High"'], ['the number 1', '1']] as const) {
    it(`[AC-21.3] a v3 file whose task priority is ${label} is refused as damaged with exit 3, error and hint, bytes unchanged (real process)`, async () => {
      const { writeFile } = await import('node:fs/promises');
      const priority = priorityJson === null ? '' : `,"priority":${priorityJson}`;
      const content = `{"schemaVersion":3,"nextId":2,"tasks":[{"id":1,"title":"a","done":false,"createdAt":"2026-10-30T09:00:00.000Z","completedAt":null,"dueDate":null${priority}}]}\n`;
      await writeFile(ctx.file, content);
      for (const args of [['list'], ['add', 'x'], ['done', '1']]) {
        const result = await todo(...args);
        assert.equal(result.code, 3, `${args.join(' ')} must exit with the storage status`);
        assert.match(result.stderr ?? '', /^error: .*damaged.*priority/m, 'an error line naming the bad field');
        assert.match(result.stderr ?? '', /^hint: /m, 'a hint line');
        assert.equal(await readFile(ctx.file, 'utf8'), content, `${args.join(' ')} must leave the file byte-for-byte unchanged`);
      }
    });
  }

  it('[AC-1.4] exits with the storage status when the file is from the future', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(ctx.file, JSON.stringify({ schemaVersion: 999, nextId: 1, tasks: [] }));
    const result = await todo('list');
    assert.equal(result.code, 3);
    assert.match(result.stderr ?? '', /newer version/);
  });
});
