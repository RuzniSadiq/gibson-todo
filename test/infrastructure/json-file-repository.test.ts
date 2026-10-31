import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TaskService } from '../../src/application/task-service.ts';
import { TodoError } from '../../src/domain/errors.ts';
import { JsonFileRepository } from '../../src/infrastructure/storage/json-file-repository.ts';
import { fixedClock, tempDir } from '../helpers.ts';

// Far above any real pid on macOS/Linux, so it never names a live process.
const DEAD_PID = 2_147_483_000;

describe('JsonFileRepository', () => {
  let ctx: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (ctx = await tempDir()));
  afterEach(() => ctx.cleanup());

  it('[AC-1.1] treats a missing file as an empty list and creates it on first write', async () => {
    const file = join(ctx.dir, 'nested', 'tasks.json');
    const service = new TaskService(new JsonFileRepository(file), fixedClock());
    assert.equal((await service.list({ status: 'all' })).length, 0);
    await service.add('first');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it('[AC-1.3] serializes concurrent writers without losing or duplicating tasks', async () => {
    const writers = Array.from({ length: 25 }, (_, i) =>
      new TaskService(new JsonFileRepository(ctx.file), fixedClock()).add(`task ${i}`),
    );
    const created = await Promise.all(writers);
    const ids = created.map((t) => t.id).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i + 1));
    const all = await new JsonFileRepository(ctx.file).read();
    assert.equal(all.tasks.length, 25);
    assert.deepEqual(await readdir(ctx.dir), ['tasks.json'], 'no temp or lock files left behind');
  });

  it('[AC-1.3] leaves the file untouched when a mutation fails', async () => {
    const service = new TaskService(new JsonFileRepository(ctx.file), fixedClock());
    await service.add('keep me');
    const before = await readFile(ctx.file, 'utf8');
    await assert.rejects(service.complete([42]), TodoError);
    assert.equal(await readFile(ctx.file, 'utf8'), before);
  });

  it('[AC-1.2] refuses corrupt JSON without overwriting it', async () => {
    await writeFile(ctx.file, '{ not json');
    const service = new TaskService(new JsonFileRepository(ctx.file), fixedClock());
    await assert.rejects(service.add('x'), (e) => e instanceof TodoError && e.code === 'STORAGE');
    assert.equal(await readFile(ctx.file, 'utf8'), '{ not json');
  });

  it('[AC-1.3] times out instead of hanging while a live process holds the lock', async () => {
    await writeFile(`${ctx.file}.lock`, `${process.pid} live-holder`);
    const repo = new JsonFileRepository(ctx.file, { timeoutMs: 60, retryMs: 5 });
    await assert.rejects(new TaskService(repo, fixedClock()).add('x'), /still writing/);
    assert.equal(await readFile(`${ctx.file}.lock`, 'utf8'), `${process.pid} live-holder`, 'a live lock is never deleted');
  });

  it('[AC-1.3] never breaks a live lock, however old', async () => {
    await writeFile(`${ctx.file}.lock`, `${process.pid} slow-holder`);
    const old = new Date(Date.now() - 24 * 3_600_000);
    await utimes(`${ctx.file}.lock`, old, old);
    const repo = new JsonFileRepository(ctx.file, { timeoutMs: 60, retryMs: 5 });
    await assert.rejects(new TaskService(repo, fixedClock()).add('x'), /still writing/);
    assert.equal(await readFile(`${ctx.file}.lock`, 'utf8'), `${process.pid} slow-holder`);
  });

  it('[AC-1.3] never breaks an empty or unreadable lock (a holder may be mid-write)', async () => {
    for (const contents of ['', 'garbage', ' ']) {
      await writeFile(`${ctx.file}.lock`, contents);
      const repo = new JsonFileRepository(ctx.file, { timeoutMs: 40, retryMs: 5 });
      await assert.rejects(new TaskService(repo, fixedClock()).add('x'), /still writing/);
      assert.equal(await readFile(`${ctx.file}.lock`, 'utf8'), contents);
    }
  });

  it('[AC-1.3] recovers from a lock left by a crashed process', async () => {
    await writeFile(`${ctx.file}.lock`, `${DEAD_PID} crashed`);
    const repo = new JsonFileRepository(ctx.file, { timeoutMs: 500 });
    assert.equal((await new TaskService(repo, fixedClock()).add('x')).id, 1);
    assert.deepEqual(await readdir(ctx.dir), ['tasks.json'], 'no lock, breaker or staging files left');
  });

  it('[AC-1.3] breaks a dead holder\'s lock exactly once under contention', async () => {
    await writeFile(`${ctx.file}.lock`, `${DEAD_PID} crashed`);
    const writers = Array.from({ length: 25 }, (_, i) => new TaskService(new JsonFileRepository(ctx.file), fixedClock()).add(`t${i}`));
    const ids = (await Promise.all(writers)).map((t) => t.id).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i + 1), 'no lost or duplicated update');
    assert.equal((await new JsonFileRepository(ctx.file).read()).tasks.length, 25);
    assert.deepEqual(await readdir(ctx.dir), ['tasks.json']);
  });

  it('[AC-1.3] release only removes a lock that is still ours', async () => {
    const repo = new JsonFileRepository(ctx.file);
    await repo.update((state) => {
      // Simulate another process having taken over the lock while we held it.
      writeFileSync(`${ctx.file}.lock`, `${process.pid} someone-else`);
      return { state, result: null };
    });
    assert.equal(await readFile(`${ctx.file}.lock`, 'utf8'), `${process.pid} someone-else`);
  });
});
