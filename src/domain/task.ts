import { TodoError } from './errors.ts';

export type TaskId = number;

/** A task is an immutable value; every change produces a new Task. */
export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly done: boolean;
  /** ISO-8601 instant the task was created. */
  readonly createdAt: string;
  /** ISO-8601 instant the task was completed, or null while open. */
  readonly completedAt: string | null;
}

export const TITLE_MAX_LENGTH = 200;

// C0/C1 control characters would corrupt terminal rendering.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Trims and collapses whitespace, then enforces the title invariants. */
export function normalizeTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length === 0) {
    throw new TodoError('VALIDATION', 'A task needs a title.', {
      hint: 'Example: todo add "Book flights"',
    });
  }
  if (CONTROL_CHARS.test(title)) {
    throw new TodoError('VALIDATION', 'Task titles cannot contain control characters.');
  }
  if ([...title].length > TITLE_MAX_LENGTH) {
    throw new TodoError(
      'VALIDATION',
      `Task titles are limited to ${TITLE_MAX_LENGTH} characters.`,
    );
  }
  return title;
}

export function createTask(id: TaskId, rawTitle: string, now: Date): Task {
  return {
    id,
    title: normalizeTitle(rawTitle),
    done: false,
    createdAt: now.toISOString(),
    completedAt: null,
  };
}

/** Idempotent: completing a completed task keeps its original completion time. */
export function completeTask(task: Task, now: Date): Task {
  return task.done ? task : { ...task, done: true, completedAt: now.toISOString() };
}

export function reopenTask(task: Task): Task {
  return task.done ? { ...task, done: false, completedAt: null } : task;
}

export function renameTask(task: Task, rawTitle: string): Task {
  return { ...task, title: normalizeTitle(rawTitle) };
}
