import { EMPTY_STATE, type Mutation, type TaskRepository, type TaskState } from '../../application/ports.ts';

/** In-process repository for tests and dry runs. Same contract as the file store. */
export class InMemoryRepository implements TaskRepository {
  #state: TaskState;

  constructor(initial: TaskState = EMPTY_STATE) {
    this.#state = initial;
  }

  async read(): Promise<TaskState> {
    return this.#state;
  }

  async update<T>(mutate: (state: TaskState) => Mutation<T>): Promise<T> {
    // A throwing mutation leaves state untouched, matching the file store.
    const { state, result } = mutate(this.#state);
    this.#state = state;
    return result;
  }
}
