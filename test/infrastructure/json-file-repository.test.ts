import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
    assert.equal(saved.schemaVersion, 3);
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

  it('[AC-1.3] never breaks a crashed process\'s lock; tells the user exactly what to do', async () => {
    await writeFile(`${ctx.file}.lock`, `${DEAD_PID} crashed`);
    const repo = new JsonFileRepository(ctx.file, { timeoutMs: 40, retryMs: 5 });
    await assert.rejects(new TaskService(repo, fixedClock()).add('x'), (e: unknown) =>
      e instanceof TodoError && /no longer running/.test(e.message) && /Delete .*tasks\.json\.lock/.test(e.hint ?? ''));
    assert.equal(await readFile(`${ctx.file}.lock`, 'utf8'), `${DEAD_PID} crashed`, 'the lock is left for the human');
    await rm(`${ctx.file}.lock`);
    assert.equal((await new TaskService(new JsonFileRepository(ctx.file), fixedClock()).add('x')).id, 1);
    assert.deepEqual(await readdir(ctx.dir), ['tasks.json'], 'no lock or staging files left');
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

  const isStorage = (e: unknown) => e instanceof TodoError && e.code === 'STORAGE';
  const v2Task = { id: 1, title: 'a', done: false, createdAt: '2026-10-31T09:00:00.000Z', completedAt: null, dueDate: null };

  it('[AC-5.1] a v1 file on disk loads with dueDate null and is rewritten as the current version on the next write', async () => {
    const fixture = await readFile(new URL('../fixtures/store-v1.json', import.meta.url), 'utf8');
    await writeFile(ctx.file, fixture);
    const repo = new JsonFileRepository(ctx.file);
    const loaded = await repo.read();
    assert.ok(loaded.tasks.length > 0 && loaded.tasks.every((t) => t.dueDate === null));
    assert.equal(await readFile(ctx.file, 'utf8'), fixture, 'reading never rewrites the file');

    await new TaskService(repo, fixedClock()).add('new');
    const saved = JSON.parse(await readFile(ctx.file, 'utf8'));
    const original = JSON.parse(fixture);
    assert.equal(saved.schemaVersion, 3);
    assert.deepEqual(
      saved.tasks.slice(0, original.tasks.length),
      original.tasks.map((t: object) => ({ ...t, dueDate: null, priority: 'normal' })),
    );
  });

  it('[AC-21.2] `add` against a v2 file rewrites it as v3 with every earlier task unchanged apart from priority normal', async () => {
    const fixture = await readFile(new URL('../fixtures/store-v2.json', import.meta.url), 'utf8');
    await writeFile(ctx.file, fixture);
    const repo = new JsonFileRepository(ctx.file);
    const loaded = await repo.read();
    assert.ok(loaded.tasks.length > 1 && loaded.tasks.every((t) => t.priority === 'normal'));
    assert.equal(await readFile(ctx.file, 'utf8'), fixture, 'reading never rewrites the file');

    const added = await new TaskService(repo, fixedClock()).add('new');
    const saved = JSON.parse(await readFile(ctx.file, 'utf8'));
    const original = JSON.parse(fixture);
    assert.equal(original.schemaVersion, 2, 'the fixture really is a version-2 file');
    assert.equal(saved.schemaVersion, 3);
    assert.equal(saved.nextId, original.nextId + 1);
    assert.equal(added.id, original.nextId);
    assert.deepEqual(saved.tasks.slice(0, -1), original.tasks.map((t: object) => ({ ...t, priority: 'normal' })));
    assert.equal(saved.tasks.at(-1).priority, 'normal');
  });

  it('[AC-21.3] refuses a v3 file whose task priority is missing, unknown, mis-cased or a number and leaves its bytes unchanged', async () => {
    const v3Task = { ...v2Task, priority: 'normal' };
    const noPriority: Record<string, unknown> = { ...v3Task };
    delete noPriority['priority'];
    for (const task of [noPriority, { ...v3Task, priority: 'urgent' }, { ...v3Task, priority: 'High' }, { ...v3Task, priority: 1 }]) {
      const bytes = `${JSON.stringify({ schemaVersion: 3, nextId: 2, tasks: [task] }, null, 2)}\n`;
      await writeFile(ctx.file, bytes);
      const repo = new JsonFileRepository(ctx.file);
      const label = JSON.stringify(task);
      await assert.rejects(repo.read(), (e: unknown) => isStorage(e) && /priority/.test((e as Error).message), `read ${label}`);
      await assert.rejects(new TaskService(repo, fixedClock()).add('x'), isStorage, `write ${label}`);
      assert.equal(await readFile(ctx.file, 'utf8'), bytes);
      assert.deepEqual(await readdir(ctx.dir), ['tasks.json'], 'no lock or staging files left');
    }
  });

  it('[AC-5.3] refuses a v2 file with an invalid dueDate and leaves its bytes unchanged', async () => {
    for (const dueDate of ['2026-02-30', '14/11/2026', 42]) {
      const bytes = `${JSON.stringify({ schemaVersion: 2, nextId: 2, tasks: [{ ...v2Task, dueDate }] }, null, 2)}\n`;
      await writeFile(ctx.file, bytes);
      const repo = new JsonFileRepository(ctx.file);
      await assert.rejects(repo.read(), isStorage, `read, dueDate ${JSON.stringify(dueDate)}`);
      await assert.rejects(new TaskService(repo, fixedClock()).add('x'), isStorage, `write, dueDate ${JSON.stringify(dueDate)}`);
      assert.equal(await readFile(ctx.file, 'utf8'), bytes);
      assert.deepEqual(await readdir(ctx.dir), ['tasks.json'], 'no lock or staging files left');
    }
  });

  it('[AC-5.4] [AC-21.4] refuses a schemaVersion 4 file as written by a newer version and leaves its bytes unchanged', async () => {
    const bytes = `${JSON.stringify({ schemaVersion: 4, nextId: 2, tasks: [{ ...v2Task, priority: 'normal', future: true }] }, null, 2)}\n`;
    await writeFile(ctx.file, bytes);
    const repo = new JsonFileRepository(ctx.file);
    const newer = (e: unknown) => isStorage(e) && /written by a newer version/.test((e as Error).message);
    await assert.rejects(repo.read(), newer);
    await assert.rejects(new TaskService(repo, fixedClock()).add('x'), newer);
    assert.equal(await readFile(ctx.file, 'utf8'), bytes);
  });
});
