import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TodoError } from '../../src/domain/errors.ts';
import { completeTask, createTask, isCalendarDate, normalizeTitle, renameTask, reopenTask, TITLE_MAX_LENGTH } from '../../src/domain/task.ts';

const now = new Date('2026-10-31T09:00:00.000Z');
const later = new Date('2026-10-31T10:00:00.000Z');

describe('task domain', () => {
  it('[AC-1.1] normalizes whitespace in titles', () => {
    assert.equal(normalizeTitle('  Book   flights \n to Lisbon '), 'Book flights to Lisbon');
  });

  it('rejects empty, oversized and control-character titles', () => {
    assert.throws(() => normalizeTitle('   '), (e) => e instanceof TodoError && e.code === 'VALIDATION');
    assert.throws(() => normalizeTitle('x'.repeat(TITLE_MAX_LENGTH + 1)), /limited to/);
    assert.equal(normalizeTitle('é'.repeat(TITLE_MAX_LENGTH)).length, TITLE_MAX_LENGTH);
    assert.throws(() => normalizeTitle('bad\u0007bell'), /control characters/);
  });

  it('completing is idempotent and keeps the first completion time', () => {
    const task = completeTask(createTask(1, 'a', now), now);
    assert.equal(completeTask(task, later).completedAt, now.toISOString());
  });

  it('reopening clears completion; renaming validates', () => {
    const reopened = reopenTask(completeTask(createTask(1, 'a', now), now));
    assert.deepEqual([reopened.done, reopened.completedAt], [false, null]);
    assert.equal(renameTask(reopened, ' b ').title, 'b');
    assert.throws(() => renameTask(reopened, ''), TodoError);
  });

  it('new tasks have no due date; edits keep it', () => {
    const task = createTask(1, 'a', now);
    assert.equal(task.dueDate, null);
    const dated = { ...task, dueDate: '2026-11-14' };
    assert.equal(completeTask(dated, now).dueDate, '2026-11-14');
    assert.equal(reopenTask(completeTask(dated, now)).dueDate, '2026-11-14');
    assert.equal(renameTask(dated, 'b').dueDate, '2026-11-14');
  });

  it('isCalendarDate accepts only real YYYY-MM-DD dates', () => {
    for (const ok of ['2026-11-14', '2024-02-29', '2000-02-29', '0000-02-29', '2026-12-31', '2026-01-01', '9999-12-31']) {
      assert.equal(isCalendarDate(ok), true, ok);
    }
    for (const bad of [
      '2026-02-30', '2026-02-29', '1900-02-29', '0100-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00',
      '14/11/2026', '2026-1-14', '2026-11-14T00:00:00Z', ' 2026-11-14', '2026-11-14\n', '+02026-11-14', '',
      '2026-11-14\r', '2026-11-14\r\n', '2026-11-14 ', '2026-11-14 ', '\n2026-11-14', '2026-11-1\n',
      '２０２６-11-14', '2026-11-14 ',
      42, null, undefined, new Date('2026-11-14'),
    ]) {
      assert.equal(isCalendarDate(bad), false, String(bad));
    }
  });
});
