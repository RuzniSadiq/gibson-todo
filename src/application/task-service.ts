import { isOverdue, localCalendarDate, parseDueInput } from '../domain/due-date.ts';
import { TodoError } from '../domain/errors.ts';
import { DEFAULT_PRIORITY, parsePriority } from '../domain/priority.ts';
import {
  completeTask,
  createTask,
  renameTask,
  reopenTask,
  type Task,
  type TaskId,
} from '../domain/task.ts';
import type { Clock, Mutation, TaskRepository, TaskState } from './ports.ts';

export type StatusFilter = 'open' | 'done' | 'all' | 'overdue';

export interface ListQuery {
  readonly status: StatusFilter;
}

/** The use cases. The CLI talks to this; it never touches storage directly. */
export class TaskService {
  readonly #repo: TaskRepository;
  readonly #clock: Clock;

  constructor(repo: TaskRepository, clock: Clock) {
    this.#repo = repo;
    this.#clock = clock;
  }

  /**
   * `due` is user input as accepted by `parseDueInput` (YYYY-MM-DD, today,
   * tomorrow, a weekday), resolved against the clock's local calendar date.
   * `priority` is user input as accepted by `parsePriority`; omitted means 'normal'.
   */
  async add(title: string, due?: string, priority?: string): Promise<Task> {
    const now = this.#clock.now();
    // Resolved before the unit of work, so a bad date or level never reaches storage.
    const dueDate = due === undefined ? null : parseDueInput(due, localCalendarDate(now));
    const level = priority === undefined ? DEFAULT_PRIORITY : parsePriority(priority);
    return this.#repo.update((state) => {
      const task: Task = { ...createTask(state.nextId, title, now), dueDate, priority: level };
      return { state: { nextId: state.nextId + 1, tasks: [...state.tasks, task] }, result: task };
    });
  }

  /** Today's local calendar date (YYYY-MM-DD) according to the injected clock. */
  today(): string {
    return localCalendarDate(this.#clock.now());
  }

  /** `overdue`: open tasks due before the clock's local date. Order is kept. */
  async list(query: ListQuery): Promise<readonly Task[]> {
    const { tasks } = await this.#repo.read();
    switch (query.status) {
      case 'overdue': {
        const today = this.today();
        return tasks.filter((t) => isOverdue(t, today));
      }
      case 'open':
        return tasks.filter((t) => !t.done);
      case 'done':
        return tasks.filter((t) => t.done);
      case 'all':
        return tasks;
    }
  }

  async complete(ids: readonly TaskId[]): Promise<readonly Task[]> {
    const now = this.#clock.now();
    return this.#replaceEach(ids, (task) => completeTask(task, now));
  }

  async reopen(ids: readonly TaskId[]): Promise<readonly Task[]> {
    return this.#replaceEach(ids, reopenTask);
  }

  async rename(id: TaskId, title: string): Promise<Task> {
    const [task] = await this.#replaceEach([id], (t) => renameTask(t, title));
    // #replaceEach returns exactly one task per id or throws.
    return task as Task;
  }

  /** Sets (`due` as accepted by `parseDueInput`) or clears (`null`) a task's due date. */
  async setDue(id: TaskId, due: string | null): Promise<Task> {
    const dueDate = due === null ? null : parseDueInput(due, this.today());
    const [task] = await this.#replaceEach([id], (t) => ({ ...t, dueDate }));
    // #replaceEach returns exactly one task per id or throws.
    return task as Task;
  }

  /** Sets a task's priority (`level` as accepted by `parsePriority`); nothing else changes. */
  async setPriority(id: TaskId, level: string): Promise<Task> {
    // Parsed before the unit of work, so a bad level never reaches storage.
    const priority = parsePriority(level);
    const [task] = await this.#replaceEach([id], (t) => ({ ...t, priority }));
    // #replaceEach returns exactly one task per id or throws.
    return task as Task;
  }

  async remove(ids: readonly TaskId[]): Promise<readonly Task[]> {
    return this.#repo.update((state) => {
      const removed = ids.map((id) => findOrThrow(state, id));
      const doomed = new Set(ids);
      return {
        state: { ...state, tasks: state.tasks.filter((t) => !doomed.has(t.id)) },
        result: removed,
      };
    });
  }

  /** Removes every completed task; returns how many were removed. */
  async clearCompleted(): Promise<number> {
    return this.#repo.update((state) => {
      const kept = state.tasks.filter((t) => !t.done);
      return { state: { ...state, tasks: kept }, result: state.tasks.length - kept.length };
    });
  }

  /** All-or-nothing: an unknown id aborts the whole batch before anything is written. */
  #replaceEach(ids: readonly TaskId[], change: (task: Task) => Task): Promise<readonly Task[]> {
    return this.#repo.update((state): Mutation<readonly Task[]> => {
      const updated = new Map<TaskId, Task>();
      for (const id of ids) updated.set(id, change(findOrThrow(state, id)));
      return {
        state: { ...state, tasks: state.tasks.map((t) => updated.get(t.id) ?? t) },
        result: ids.map((id) => updated.get(id) as Task),
      };
    });
  }
}

function findOrThrow(state: TaskState, id: TaskId): Task {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) {
    throw new TodoError('NOT_FOUND', `There is no task #${id}.`, {
      hint: 'Run `todo list --all` to see task numbers.',
    });
  }
  return task;
}
