import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TodoError } from '../../src/domain/errors.ts';
import { completeTask, createTask, normalizeTitle, renameTask, reopenTask, TITLE_MAX_LENGTH } from '../../src/domain/task.ts';

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
});
