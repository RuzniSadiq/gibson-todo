import type { ParseArgsOptionsConfig } from 'node:util';
import type { TaskService } from '../application/task-service.ts';
import { dueRelation, formatDueDateFrom } from '../domain/due-date.ts';
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

export interface FormatOptions {
  /** Show a `high` / `low` label (normal never gets one). Off by default. */
  readonly priority?: boolean;
}

/**
 * One task per line: `  #3  [ ]  Title  high  due Sat 14 Nov`. `today` is the
 * local calendar date (YYYY-MM-DD) from the injected clock, used for the due label.
 */
export function formatTask(task: Task, style: Style, today: string, options: FormatOptions = {}): string {
  const id = style.dim(`#${task.id}`.padStart(4));
  const box = task.done ? style.green('[x]') : '[ ]';
  const title = task.done ? style.dim(task.title) : task.title;
  const labels = [options.priority === true ? priorityLabel(task, style) : '', dueLabel(task, style, today)];
  return [`${id}  ${box}  ${title}`, ...labels.filter((l) => l !== '')].join('  ');
}

/** A yellow `high` or a dim `low`; empty for normal, so everyday lists stay quiet. */
export function priorityLabel(task: Task, style: Style): string {
  switch (task.priority) {
    case 'high':
      return style.yellow('high');
    case 'low':
      return style.dim('low');
    case 'normal':
      return '';
  }
}

/** `due Sat 14 Nov`, `due today` or a red `overdue 2d`; empty without a due date. */
export function dueLabel(task: Task, style: Style, today: string): string {
  if (task.dueDate === null) return '';
  // A completed task is never overdue or "due today": it just shows its date.
  if (!task.done) {
    const relation = dueRelation(task.dueDate, today);
    if (relation.kind === 'overdue') return style.red(`overdue ${relation.days}d`);
    if (relation.kind === 'today') return style.dim('due today');
  }
  return style.dim(`due ${formatDueDateFrom(task.dueDate, today)}`);
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
