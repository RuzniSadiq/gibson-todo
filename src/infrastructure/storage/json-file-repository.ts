import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EMPTY_STATE, type Mutation, type TaskRepository, type TaskState } from '../../application/ports.ts';
import { TodoError } from '../../domain/errors.ts';
import { decodeStore, encodeStore } from './schema.ts';

export interface LockOptions {
  /** How long to wait for another writer before giving up. */
  readonly timeoutMs: number;
  /** A lock older than this is treated as abandoned by a crashed process. */
  readonly staleMs: number;
  readonly retryMs: number;
}

const DEFAULT_LOCK: LockOptions = { timeoutMs: 5_000, staleMs: 30_000, retryMs: 15 };

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

  async #acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.#lock.timeoutMs;
    for (;;) {
      try {
        const handle = await open(this.#lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(String(process.pid));
        } finally {
          await handle.close();
        }
        return () => rm(this.#lockPath, { force: true });
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw storageError('Could not lock the task file.', error);
      }
      if (await this.#lockIsStale()) {
        await rm(this.#lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new TodoError('STORAGE', 'Another todo command is still writing the task file.', {
          hint: `Try again. If it persists, delete ${this.#lockPath}.`,
        });
      }
      await sleep(this.#lock.retryMs);
    }
  }

  async #lockIsStale(): Promise<boolean> {
    try {
      const info = await stat(this.#lockPath);
      return Date.now() - info.mtimeMs > this.#lock.staleMs;
    } catch {
      return false; // vanished between attempts: simply retry
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function storageError(message: string, cause: unknown): TodoError {
  const detail = cause instanceof Error ? ` (${cause.message})` : '';
  return new TodoError('STORAGE', `${message}${detail}`, { cause });
}
