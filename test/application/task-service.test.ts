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
