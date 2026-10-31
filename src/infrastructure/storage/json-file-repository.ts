import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
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
/** Breaking a lock takes microseconds; a breaker file older than this was abandoned by a crash. */
const BREAKER_ABANDONED_MS = 5_000;

interface LockHolder {
  readonly pid: number;
  readonly token: string;
}

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
  readonly #breakerPath: string;
  readonly #lock: LockOptions;

  constructor(path: string, lock: Partial<LockOptions> = {}) {
    this.#path = path;
    this.#lockPath = `${path}.lock`;
    this.#breakerPath = `${path}.lock.break`;
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
   * Lock protocol (safety over liveness — a live lock is never deleted):
   *  - acquire: write "<pid> <token>" to a private temp file, then hard-link it
   *    to `<file>.lock`. link(2) is atomic and fails if the lock exists, so a
   *    lock is never observable empty or half-written;
   *  - break: only when the holder process no longer exists, only by the one
   *    process holding `<file>.lock.break`, and only after re-reading that the
   *    token it judged dead is still the one on disk. A live holder is never
   *    evicted, however slow (if a dead holder's PID is reused, the user gets a
   *    clear error and a hint instead of a lost update);
   *  - release: delete the lock only if it still carries our token.
   */
  async #acquireLock(): Promise<() => Promise<void>> {
    const token = `${process.pid} ${randomUUID()}`;
    const deadline = Date.now() + this.#lock.timeoutMs;
    for (;;) {
      if (await this.#tryLink(token)) return () => this.#release(token);
      if (await this.#breakIfStale()) continue;
      if (Date.now() >= deadline) {
        throw new TodoError('STORAGE', 'Another todo command is still writing the task file.', {
          hint: `Try again. If it persists and no todo command is running, delete ${this.#lockPath}.`,
        });
      }
      await sleep(this.#lock.retryMs);
    }
  }

  async #tryLink(token: string): Promise<boolean> {
    const staging = `${this.#lockPath}.${process.pid}.${randomUUID()}`;
    await this.#tryCreate(staging, token);
    try {
      await link(staging, this.#lockPath);
      return true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw storageError('Could not lock the task file.', error);
    } finally {
      await rm(staging, { force: true });
    }
  }

  async #tryCreate(path: string, contents: string): Promise<boolean> {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw storageError('Could not lock the task file.', error);
    }
  }

  /** Returns true when the caller should retry acquiring immediately. */
  async #breakIfStale(): Promise<boolean> {
    if (!(await this.#tryCreate(this.#breakerPath, String(process.pid)))) {
      await this.#clearAbandonedBreaker();
      return false;
    }
    try {
      const holder = await this.#readHolder();
      if (!holder) return true; // released meanwhile
      if (holder.pid <= 0 || processAlive(holder.pid)) return false; // unreadable or alive: never break
      const again = await this.#readHolder();
      if (again?.token !== holder.token) return true; // changed hands: never delete a lock we did not judge
      await rm(this.#lockPath, { force: true });
      return true;
    } finally {
      await rm(this.#breakerPath, { force: true });
    }
  }

  async #clearAbandonedBreaker(): Promise<void> {
    try {
      const info = await stat(this.#breakerPath);
      if (Date.now() - info.mtimeMs > BREAKER_ABANDONED_MS) await rm(this.#breakerPath, { force: true });
    } catch {
      // gone already
    }
  }

  async #readHolder(): Promise<LockHolder | null> {
    try {
      const text = await readFile(this.#lockPath, 'utf8');
      const pid = Number(text.split(' ')[0]);
      return { pid: Number.isInteger(pid) ? pid : -1, token: text };
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
  if (pid <= 0) return false;
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
