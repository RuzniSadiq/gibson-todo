import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EMPTY_STATE, type Mutation, type TaskRepository, type TaskState } from '../../application/ports.ts';
import { TodoError } from '../../domain/errors.ts';
import { decodeStore, encodeStore } from './schema.ts';

export interface LockOptions {
  /** How long to wait for another writer before giving up. */
  readonly timeoutMs: number;
  readonly retryMs: number;
}

const DEFAULT_LOCK: LockOptions = { timeoutMs: 5_000, retryMs: 15 };
/**
 * Stores tasks in one JSON file.
 *
 * Durability: writes go to a temp file that is fsync'd and atomically renamed
 * over the target, so a crash leaves either the old or the new file — never a
 * torn one. Isolation: an exclusive lock file serializes read-modify-write
 * cycles across processes, so concurrent `todo add`s never lose updates.
 */
export class JsonFileRepository implements TaskRepository {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lock: LockOptions;

  constructor(path: string, lock: Partial<LockOptions> = {}) {
    this.#path = path;
    this.#lockPath = `${path}.lock`;
    this.#lock = { ...DEFAULT_LOCK, ...lock };
  }

  async read(): Promise<TaskState> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return EMPTY_STATE;
      throw storageError(`Could not read ${this.#path}.`, error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new TodoError('STORAGE', `Your task file is not valid JSON: ${this.#path}.`, {
        hint: 'The file has not been modified. Fix it by hand or move it aside to start fresh.',
        cause: error,
      });
    }
    return decodeStore(parsed);
  }

  async update<T>(mutate: (state: TaskState) => Mutation<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const release = await this.#acquireLock();
    try {
      const { state, result } = mutate(await this.read());
      await this.#writeAtomically(`${JSON.stringify(encodeStore(state), null, 2)}\n`);
      return result;
    } finally {
      await release();
    }
  }

  async #writeAtomically(contents: string): Promise<void> {
    const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await open(temp, 'w', 0o600);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#path);
    } catch (error) {
      await rm(temp, { force: true });
      throw storageError(`Could not save ${this.#path}.`, error);
    }
  }

  /**
   * Lock protocol — mutual exclusion is exactly the atomicity of link(2):
   *  - acquire: write "<pid> <token>" to a private staging file, then hard-link
   *    it to `<file>.lock`. link fails if the lock exists, so there is one
   *    holder at a time and a lock is never observable empty or half-written;
   *  - release: delete the lock only if it still carries our token;
   *  - a lock is NEVER broken automatically. Every path-based "steal a stale
   *    lock" scheme races against a paused process (Node has no flock), and a
   *    stale lock only exists if a todo process died mid-write. So the user
   *    gets a precise, safe instruction instead (safety over liveness).
   */
  async #acquireLock(): Promise<() => Promise<void>> {
    const token = `${process.pid} ${randomUUID()}`;
    const deadline = Date.now() + this.#lock.timeoutMs;
    for (;;) {
      if (await this.#tryLink(token)) return () => this.#release(token);
      if (Date.now() >= deadline) throw await this.#busyError();
      await sleep(this.#lock.retryMs);
    }
  }

  async #tryLink(token: string): Promise<boolean> {
    const staging = `${this.#lockPath}.${process.pid}.${randomUUID()}`;
    try {
      const handle = await open(staging, 'wx', 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      await link(staging, this.#lockPath);
      return true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw storageError('Could not lock the task file.', error);
    } finally {
      await rm(staging, { force: true });
    }
  }

  async #busyError(): Promise<TodoError> {
    const holder = await this.#readHolder();
    const message = 'Another todo command is still writing the task file.';
    if (holder && holder.pid > 0 && !processAlive(holder.pid)) {
      return new TodoError('STORAGE', `${message} Its lock belongs to process ${holder.pid}, which is no longer running.`, {
        hint: `A todo command crashed mid-write. Your tasks are intact (writes are atomic). Delete ${this.#lockPath} and retry.`,
      });
    }
    return new TodoError('STORAGE', message, {
      hint: `Try again in a moment. If no todo command is running, delete ${this.#lockPath}.`,
    });
  }

  async #readHolder(): Promise<{ pid: number; token: string } | null> {
    try {
      const token = await readFile(this.#lockPath, 'utf8');
      const pid = Number(token.split(' ')[0]);
      return { pid: Number.isInteger(pid) ? pid : -1, token };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw storageError('Could not inspect the task file lock.', error);
    }
  }

  async #release(token: string): Promise<void> {
    const holder = await this.#readHolder();
    if (holder?.token === token) await rm(this.#lockPath, { force: true });
  }
}

/** True when a process with this pid exists (EPERM = exists, owned by someone else). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function storageError(message: string, cause: unknown): TodoError {
  const detail = cause instanceof Error ? ` (${cause.message})` : '';
  return new TodoError('STORAGE', `${message}${detail}`, { cause });
}
