import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
    assert.equal(onDisk.schemaVersion, 1);
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

  it('[AC-1.4] exits with the storage status when the file is from the future', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(ctx.file, JSON.stringify({ schemaVersion: 999, nextId: 1, tasks: [] }));
    const result = await todo('list');
    assert.equal(result.code, 3);
    assert.match(result.stderr ?? '', /newer version/);
  });
});
