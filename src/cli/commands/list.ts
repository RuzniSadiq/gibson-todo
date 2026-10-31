import { TodoError } from '../../domain/errors.ts';
import type { StatusFilter } from '../../application/task-service.ts';
import { formatTask, plural, type Command, type ParsedArgs } from '../command.ts';

export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  summary: 'Show tasks (open ones by default)',
  usage: '[--all | --done | --overdue] [--json]',
  options: {
    all: { type: 'boolean', short: 'a' },
    done: { type: 'boolean', short: 'd' },
    overdue: { type: 'boolean', short: 'o' },
  },
  examples: [
    'todo list',
    'todo list --all',
    'todo list --overdue     # --overdue/-o: open tasks due before today',
    'todo ls --done --json',
  ],
  async run({ service, out }, args) {
    const status = statusFrom(args);
    const tasks = await service.list({ status });
    const today = service.today();
    out.result(tasks, (style) => {
      if (tasks.length === 0) return [emptyMessage(status)];
      const lines = tasks.map((t) => formatTask(t, style, today));
      if (status === 'overdue') return [...lines, '', style.dim(`${plural(tasks.length, 'overdue task')}`)];
      const done = tasks.filter((t) => t.done).length;
      return [...lines, '', style.dim(`${plural(tasks.length - done, 'open task')} · ${done} done`)];
    });
  },
};

function statusFrom({ values }: ParsedArgs): StatusFilter {
  const chosen = (['all', 'done', 'overdue'] as const).filter((flag) => values[flag] === true);
  if (chosen.length > 1) {
    throw new TodoError('USAGE', `${chosen.map((f) => `--${f}`).join(' and ')} can't be combined.`, {
      hint: 'Use only one of --all, --done or --overdue, e.g. todo list --overdue',
    });
  }
  return chosen[0] ?? 'open';
}

function emptyMessage(status: StatusFilter): string {
  switch (status) {
    case 'open':
      return 'Nothing to do. Add a task with: todo add "..."';
    case 'overdue':
      return 'Nothing overdue.';
    case 'done':
      return 'No completed tasks yet.';
    case 'all':
      return 'No tasks yet.';
  }
}
