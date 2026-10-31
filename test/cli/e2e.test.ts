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
    assert.equal(onDisk.schemaVersion, 2);
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

  it('[AC-1.4] exits with the storage status when the file is from the future', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(ctx.file, JSON.stringify({ schemaVersion: 999, nextId: 1, tasks: [] }));
    const result = await todo('list');
    assert.equal(result.code, 3);
    assert.match(result.stderr ?? '', /newer version/);
  });
});
