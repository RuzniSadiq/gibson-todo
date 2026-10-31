import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TodoError } from '../../src/domain/errors.ts';
import { isPriority, parsePriority, PRIORITIES, priorityRank, type Priority } from '../../src/domain/priority.ts';
import { createTask } from '../../src/domain/task.ts';

const now = new Date('2026-10-31T09:00:00.000Z');

describe('priority domain', () => {
  it('[AC-21.5] parsePriority accepts high, HIGH, High, normal, low (trimmed) and returns the lower-case level', () => {
    const accepted: [string, Priority][] = [
      ['high', 'high'],
      ['HIGH', 'high'],
      ['High', 'high'],
      ['normal', 'normal'],
      ['NORMAL', 'normal'],
      ['low', 'low'],
      ['Low', 'low'],
      ['  low ', 'low'],
    ];
    for (const [input, expected] of accepted) assert.equal(parsePriority(input), expected, JSON.stringify(input));
  });

  it('[AC-21.5] parsePriority rejects hi, urgent, 1, empty and high\\n with a VALIDATION error naming the value and hinting the levels', () => {
    for (const input of ['hi', 'urgent', '1', '', 'high\n', '\nhigh', 'high\r', 'hi gh', 'highh', 'h', 'high\t', 'high ', '   ', 'normal low', 'méd']) {
      assert.throws(
        () => parsePriority(input),
        (e: unknown) => {
          assert.ok(e instanceof TodoError, `${JSON.stringify(input)} throws a TodoError`);
          assert.equal(e.code, 'VALIDATION');
          assert.ok(e.message.includes(JSON.stringify(input)), `message names ${JSON.stringify(input)}: ${e.message}`);
          for (const level of ['high', 'normal', 'low']) assert.match(e.hint ?? '', new RegExp(`\\b${level}\\b`));
          return true;
        },
      );
    }
  });

  it('[AC-21.5] isPriority is strict: exact lower-case levels only', () => {
    for (const level of ['high', 'normal', 'low']) assert.equal(isPriority(level), true);
    for (const bad of ['High', 'HIGH', ' high', 'high ', 'high\n', 'urgent', '', 1, 0, null, undefined, ['high'], {}]) {
      assert.equal(isPriority(bad), false, JSON.stringify(bad));
    }
  });

  it('[AC-21.5] createTask defaults priority to normal', () => {
    assert.equal(createTask(1, 'a', now).priority, 'normal');
  });

  it('[AC-21.5] the rank orders high < normal < low', () => {
    assert.ok(priorityRank('high') < priorityRank('normal'));
    assert.ok(priorityRank('normal') < priorityRank('low'));
    const shuffled: Priority[] = ['low', 'high', 'normal', 'low', 'high'];
    assert.deepEqual([...shuffled].sort((a, b) => priorityRank(a) - priorityRank(b)), ['high', 'high', 'normal', 'low', 'low']);
    assert.deepEqual(PRIORITIES, ['high', 'normal', 'low']);
  });
});
