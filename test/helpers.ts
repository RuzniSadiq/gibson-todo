import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../src/application/ports.ts';
import type { Io } from '../src/cli/output.ts';

export interface CapturedIo extends Io {
  readonly out: () => string;
  readonly err: () => string;
}

export function captureIo(env: Record<string, string> = {}): CapturedIo {
  let out = '';
  let err = '';
  return {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    env: { NO_COLOR: '1', ...env },
    isTTY: false,
    out: () => out,
    err: () => err,
  };
}

export const fixedClock = (iso = '2026-10-31T09:00:00.000Z'): Clock => ({ now: () => new Date(iso) });

/** A fresh temp directory, removed by the returned cleanup. */
export async function tempDir(): Promise<{ dir: string; file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'gibson-todo-'));
  return { dir, file: join(dir, 'tasks.json'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
