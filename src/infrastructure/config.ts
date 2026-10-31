import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where the task file lives, in priority order:
 *   1. $TODO_FILE                       (explicit override; tests and scripts)
 *   2. $XDG_DATA_HOME/gibson-todo/tasks.json
 *   3. ~/.local/share/gibson-todo/tasks.json
 */
export function resolveDataFile(env: Env, home: string = homedir()): string {
  const explicit = env['TODO_FILE'];
  if (explicit) return resolve(explicit);
  const xdg = env['XDG_DATA_HOME'];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
  return join(base, 'gibson-todo', 'tasks.json');
}
