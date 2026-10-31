import type { Task } from '../domain/task.ts';

/** The whole persisted state. Small by design: a personal task list. */
export interface TaskState {
  readonly nextId: number;
  readonly tasks: readonly Task[];
}

export interface Mutation<T> {
  readonly state: TaskState;
  readonly result: T;
}

/**
 * Persistence port. `update` is a unit of work: the implementation must make
 * read → mutate → write atomic with respect to other writers.
 */
export interface TaskRepository {
  read(): Promise<TaskState>;
  update<T>(mutate: (state: TaskState) => Mutation<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const EMPTY_STATE: TaskState = Object.freeze({ nextId: 1, tasks: Object.freeze([]) });
