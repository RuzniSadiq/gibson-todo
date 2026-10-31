import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DUE_INPUT_HINT,
  dueRelation,
  formatDueDate,
  formatDueDateFrom,
  isOverdue,
  localCalendarDate,
  parseDueInput,
} from '../../src/domain/due-date.ts';
import { TodoError } from '../../src/domain/errors.ts';

const SUNDAY = '2026-11-01';

const isValidation = (e: unknown) => e instanceof TodoError && e.code === 'VALIDATION' && e.hint === DUE_INPUT_HINT;

describe('parseDueInput', () => {
  it('[AC-6.2] resolves today, tomorrow and weekdays against the given Sunday 2026-11-01', () => {
    assert.equal(parseDueInput('today', SUNDAY), '2026-11-01');
    assert.equal(parseDueInput('tomorrow', SUNDAY), '2026-11-02');
    assert.equal(parseDueInput('friday', SUNDAY), '2026-11-06');
    assert.equal(parseDueInput('FRI', SUNDAY), '2026-11-06');
    assert.equal(parseDueInput('sunday', SUNDAY), '2026-11-01', 'same weekday means today');
  });

  it('[AC-6.2] accepts every full and 3-letter weekday name in any letter case', () => {
    const expected = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    names.forEach((name, i) => {
      assert.equal(parseDueInput(name, SUNDAY), expected[i], name);
      assert.equal(parseDueInput(name.toUpperCase(), SUNDAY), expected[i], name.toUpperCase());
      assert.equal(parseDueInput(name.slice(0, 3), SUNDAY), expected[i], name.slice(0, 3));
      assert.equal(parseDueInput(`${name[0]?.toUpperCase()}${name.slice(1, 3)}`, SUNDAY), expected[i]);
    });
    assert.equal(parseDueInput('Today', SUNDAY), SUNDAY);
    assert.equal(parseDueInput('TOMORROW', SUNDAY), '2026-11-02');
  });

  it('[AC-6.2] crosses month, year and leap-day boundaries', () => {
    assert.equal(parseDueInput('tomorrow', '2026-11-30'), '2026-12-01');
    assert.equal(parseDueInput('tomorrow', '2026-12-31'), '2027-01-01');
    assert.equal(parseDueInput('tomorrow', '2028-02-28'), '2028-02-29');
    assert.equal(parseDueInput('mon', '2026-12-29'), '2027-01-04'); // Tue → next Mon
  });

  it('[AC-6.1] passes an exact YYYY-MM-DD date through unchanged', () => {
    assert.equal(parseDueInput('2026-11-14', SUNDAY), '2026-11-14');
    assert.equal(parseDueInput(' 2026-11-14 ', SUNDAY), '2026-11-14');
    assert.equal(parseDueInput('2020-01-01', SUNDAY), '2020-01-01', 'past dates are allowed');
  });

  it('[AC-6.4] rejects anything else as VALIDATION with a hint listing the accepted forms', () => {
    for (const bad of ['someday', '2026-13-01', '2026-02-30', '14 Nov', 'next week', 'fr', 'fridays', '', '2026-11-14\n2', '2026-1-1']) {
      assert.throws(() => parseDueInput(bad, SUNDAY), isValidation, JSON.stringify(bad));
    }
    for (const form of ['YYYY-MM-DD', 'today', 'tomorrow', 'weekday']) assert.match(DUE_INPUT_HINT, new RegExp(form));
  });

  it('refuses a malformed "today" (programming error, not user input)', () => {
    assert.throws(() => parseDueInput('today', '2026-11-1'), TypeError);
  });
});

describe('localCalendarDate / formatDueDate', () => {
  it('[AC-6.2] uses the local calendar date of the instant, not UTC', () => {
    // Built from local fields, so this is 00:30 / 23:30 on 1 Nov in whatever TZ the test runs in.
    assert.equal(localCalendarDate(new Date(2026, 10, 1, 0, 30)), '2026-11-01');
    assert.equal(localCalendarDate(new Date(2026, 10, 1, 23, 30)), '2026-11-01');
  });

  it('formats a due date for text output', () => {
    assert.equal(formatDueDate('2026-11-14'), 'Sat 14 Nov 2026');
    assert.equal(formatDueDate('2026-11-06'), 'Fri 6 Nov 2026');
  });
});

describe('dueRelation / formatDueDateFrom / isOverdue', () => {
  it('[AC-7.1] relates a due date to a local calendar day in whole days', () => {
    assert.deepEqual(dueRelation('2026-11-14', '2026-11-16'), { kind: 'overdue', days: 2 });
    assert.deepEqual(dueRelation('2026-11-16', '2026-11-16'), { kind: 'today' });
    assert.deepEqual(dueRelation('2026-11-14', '2026-11-01'), { kind: 'upcoming', days: 13 });
    // Across month, year and DST boundaries (pure UTC arithmetic).
    assert.deepEqual(dueRelation('2026-10-24', '2026-11-02'), { kind: 'overdue', days: 9 });
    assert.deepEqual(dueRelation('2026-12-31', '2027-01-01'), { kind: 'overdue', days: 1 });
    assert.deepEqual(dueRelation('2028-02-28', '2028-03-01'), { kind: 'overdue', days: 2 });
  });

  it('[AC-7.1] shows the year only when it differs from today', () => {
    assert.equal(formatDueDateFrom('2026-11-14', '2026-11-01'), 'Sat 14 Nov');
    assert.equal(formatDueDateFrom('2027-01-14', '2026-11-01'), 'Thu 14 Jan 2027');
    assert.equal(formatDueDateFrom('2025-12-31', '2026-11-01'), 'Wed 31 Dec 2025');
  });

  it('[AC-7.2] completed tasks and tasks without a due date are never overdue', () => {
    assert.equal(isOverdue({ done: false, dueDate: '2026-11-14' }, '2026-11-16'), true);
    assert.equal(isOverdue({ done: true, dueDate: '2026-11-14' }, '2026-11-16'), false);
    assert.equal(isOverdue({ done: false, dueDate: null }, '2026-11-16'), false);
    assert.equal(isOverdue({ done: false, dueDate: '2026-11-16' }, '2026-11-16'), false);
  });

  it('rejects malformed dates', () => {
    assert.throws(() => dueRelation('2026-11-14\n', '2026-11-16'), TypeError);
    assert.throws(() => formatDueDateFrom('2026-11-14', '16/11/2026'), TypeError);
  });
});
