import type { ParseArgsOptionsConfig } from 'node:util';
import type { TaskService } from '../application/task-service.ts';
import { TodoError } from '../domain/errors.ts';
import type { Task, TaskId } from '../domain/task.ts';
import type { Output, Style } from './output.ts';

export interface CommandContext {
  readonly service: TaskService;
  readonly out: Output;
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
}

/** One file per command under ./commands; registered in ./registry.ts. */
export interface Command {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  /** Usage line(s) after the command name, e.g. `<id>... [--json]`. */
  readonly usage: string;
  readonly options?: ParseArgsOptionsConfig;
  readonly examples?: readonly string[];
  run(ctx: CommandContext, args: ParsedArgs): Promise<void>;
}

export function parseTaskId(raw: string): TaskId {
  const match = /^#?(\d{1,9})$/.exec(raw.trim());
  const id = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TodoError('USAGE', `"${raw}" is not a task number.`, { hint: 'Use the number shown by `todo list`, e.g. 3 or #3.' });
  }
  return id;
}

export function requireIds(args: ParsedArgs, command: string): TaskId[] {
  if (args.positionals.length === 0) {
    throw new TodoError('USAGE', `\`todo ${command}\` needs at least one task number.`, {
      hint: `Example: todo ${command} 3`,
    });
  }
  return [...new Set(args.positionals.map(parseTaskId))];
}

export function formatTask(task: Task, style: Style): string {
  const id = style.dim(`#${task.id}`.padStart(4));
  const box = task.done ? style.green('[x]') : '[ ]';
  const title = task.done ? style.dim(task.title) : task.title;
  return `${id}  ${box}  ${title}`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
