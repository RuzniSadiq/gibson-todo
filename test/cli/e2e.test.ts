import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

  it('[AC-1.4] exits with the storage status when the file is from the future', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(ctx.file, JSON.stringify({ schemaVersion: 999, nextId: 1, tasks: [] }));
    const result = await todo('list');
    assert.equal(result.code, 3);
    assert.match(result.stderr ?? '', /newer version/);
  });
});
