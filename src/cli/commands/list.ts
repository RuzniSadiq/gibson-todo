import { TodoError } from '../../domain/errors.ts';
import { parsePriority, type Priority } from '../../domain/priority.ts';
import type { StatusFilter } from '../../application/task-service.ts';
import { formatTask, plural, type Command, type ParsedArgs } from '../command.ts';

export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  summary: 'Show tasks (open ones by default), high priority first, then normal, then low',
  usage: '[--all | --done | --overdue] [--priority <level>] [--json]',
  options: {
    all: { type: 'boolean', short: 'a' },
    done: { type: 'boolean', short: 'd' },
    overdue: { type: 'boolean', short: 'o' },
    priority: { type: 'string', short: 'p' },
  },
  examples: [
    'todo list',
    'todo list --all',
    'todo list --overdue     # --overdue/-o: open tasks due before today',
    'todo list --priority high     # --priority/-p: only high, normal or low tasks',
    'todo ls -p low --all',
    'todo ls --done --json',
  ],
  async run({ service, out }, args) {
    const status = statusFrom(args);
    const priority = priorityFrom(args);
    const tasks = await service.list(priority === undefined ? { status } : { status, priority });
    const today = service.today();
    out.result(tasks, (style) => {
      if (tasks.length === 0) return [priority === undefined ? emptyMessage(status) : emptyPriorityMessage(status, priority)];
      const lines = tasks.map((t) => formatTask(t, style, today, { priority: true }));
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

function priorityFrom({ values }: ParsedArgs): Priority | undefined {
  const raw = values['priority'];
  return typeof raw === 'string' ? parsePriority(raw) : undefined;
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

function emptyPriorityMessage(status: StatusFilter, priority: Priority): string {
  switch (status) {
    case 'open':
    case 'all':
      return `No ${priority}-priority tasks.`;
    case 'overdue':
      return `No overdue ${priority}-priority tasks.`;
    case 'done':
      return `No completed ${priority}-priority tasks.`;
  }
}
