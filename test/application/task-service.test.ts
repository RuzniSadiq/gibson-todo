import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskService } from '../../src/application/task-service.ts';
import { TodoError } from '../../src/domain/errors.ts';
import { InMemoryRepository } from '../../src/infrastructure/storage/memory-repository.ts';
import { fixedClock } from '../helpers.ts';

const service = () => new TaskService(new InMemoryRepository(), fixedClock());

describe('TaskService', () => {
  it('[AC-1.1] adds tasks with increasing ids and lists by status', async () => {
    const s = service();
    const a = await s.add('first');
    const b = await s.add('second');
    await s.complete([a.id]);
    assert.deepEqual([a.id, b.id], [1, 2]);
    assert.deepEqual((await s.list({ status: 'open' })).map((t) => t.id), [2]);
    assert.deepEqual((await s.list({ status: 'done' })).map((t) => t.id), [1]);
    assert.equal((await s.list({ status: 'all' })).length, 2);
  });

  it('[AC-23.1] list sorts high, normal, low and keeps task-number order within a level', async () => {
    const s = service();
    await s.add('one', undefined, 'low');
    await s.add('two');
    await s.add('three', undefined, 'high');
    await s.add('four');
    assert.deepEqual((await s.list({ status: 'open' })).map((t) => t.id), [3, 2, 4, 1]);
    assert.deepEqual((await s.list({ status: 'all' })).map((t) => t.id), [3, 2, 4, 1]);
  });

  it('[AC-23.2] the priority filter combines with every status filter', async () => {
    const s = service();
    await s.add('late high', '2026-10-01', 'high');
    await s.add('done high', undefined, 'high');
    await s.add('late normal', '2026-10-01');
    await s.add('done low', undefined, 'low');
    await s.complete([2, 4]);
    const ids = async (status: 'open' | 'done' | 'all' | 'overdue', priority: 'high' | 'normal' | 'low') =>
      (await s.list({ status, priority })).map((t) => t.id);
    assert.deepEqual(await ids('open', 'high'), [1]);
    assert.deepEqual(await ids('all', 'high'), [1, 2]);
    assert.deepEqual(await ids('done', 'low'), [4]);
    assert.deepEqual(await ids('overdue', 'high'), [1]);
    assert.deepEqual(await ids('overdue', 'low'), []);
  });

  it('[AC-1.1] never reuses an id after removal', async () => {
    const s = service();
    await s.add('a');
    const b = await s.add('b');
    await s.remove([b.id]);
    assert.equal((await s.add('c')).id, 3);
  });

  it('batch operations are all-or-nothing on unknown ids', async () => {
    const s = service();
    const a = await s.add('a');
    await assert.rejects(s.complete([a.id, 99]), (e) => e instanceof TodoError && e.code === 'NOT_FOUND');
    assert.equal((await s.list({ status: 'done' })).length, 0);
  });

  it('[AC-1.1] reopens, renames and clears completed tasks', async () => {
    const s = service();
    const a = await s.add('a');
    const b = await s.add('b');
    await s.complete([a.id, b.id]);
    await s.reopen([b.id]);
    assert.equal((await s.rename(b.id, 'renamed')).title, 'renamed');
    assert.equal(await s.clearCompleted(), 1);
    assert.deepEqual((await s.list({ status: 'all' })).map((t) => t.title), ['renamed']);
  });
});

describe('TaskService overdue', () => {
  it("[AC-7.4] list({ status: 'overdue' }) keeps open tasks due before the clock's local date, in order", async () => {
    let now = new Date(2026, 10, 1, 12);
    const s = new TaskService(new InMemoryRepository(), { now: () => now });
    await s.add('late', '2026-11-10');
    await s.add('today', '2026-11-16');
    await s.add('none');
    const done = await s.add('done late', '2026-11-02');
    await s.complete([done.id]);
    await s.add('later', '2026-12-01');
    await s.add('just late', '2026-11-15');
    now = new Date(2026, 10, 16, 0, 1);
    assert.equal(s.today(), '2026-11-16');
    assert.deepEqual((await s.list({ status: 'overdue' })).map((t) => t.title), ['late', 'just late']);
  });
});

describe('TaskService priority', () => {
  it('[AC-22.1] add takes an optional priority (default normal, case-insensitive)', async () => {
    const s = service();
    assert.equal((await s.add('a')).priority, 'normal');
    assert.equal((await s.add('b', undefined, 'HIGH')).priority, 'high');
    const both = await s.add('c', '2026-11-14', 'low');
    assert.equal(both.priority, 'low');
    assert.equal(both.dueDate, '2026-11-14');
  });

  it('[AC-22.2] add rejects a bad priority before writing anything', async () => {
    const s = service();
    for (const bad of ['hi', 'urgent', '1', '', 'high\n']) {
      await assert.rejects(s.add('x', undefined, bad), (e) => e instanceof TodoError && e.code === 'VALIDATION');
    }
    assert.equal((await s.list({ status: 'all' })).length, 0);
    assert.equal((await s.add('next')).id, 1);
  });

  it('[AC-22.3] setPriority changes only the priority; unknown id or bad level writes nothing', async () => {
    const s = service();
    await s.add('a');
    const b = await s.add('b', '2026-11-14');
    await s.complete([b.id]);
    const [before] = await s.list({ status: 'done' });
    const updated = await s.setPriority(b.id, 'low');
    assert.deepEqual(updated, { ...before, priority: 'low' });
    await assert.rejects(s.setPriority(99, 'high'), (e) => e instanceof TodoError && e.code === 'NOT_FOUND');
    await assert.rejects(s.setPriority(b.id, 'urgent'), (e) => e instanceof TodoError && e.code === 'VALIDATION');
    assert.deepEqual((await s.list({ status: 'all' })).map((t) => t.priority), ['normal', 'low']);
  });
});
