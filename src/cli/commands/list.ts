import { TodoError } from '../../domain/errors.ts';
import type { StatusFilter } from '../../application/task-service.ts';
import { formatTask, plural, type Command } from '../command.ts';

export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  summary: 'Show tasks (open ones by default)',
  usage: '[--all | --done] [--json]',
  options: {
    all: { type: 'boolean', short: 'a' },
    done: { type: 'boolean', short: 'd' },
  },
  examples: ['todo list', 'todo list --all', 'todo ls --done --json'],
  async run({ service, out }, { values }) {
    if (values['all'] && values['done']) {
      throw new TodoError('USAGE', 'Choose either --all or --done, not both.');
    }
    const status: StatusFilter = values['all'] ? 'all' : values['done'] ? 'done' : 'open';
    const tasks = await service.list({ status });
    out.result(tasks, (style) => {
      if (tasks.length === 0) {
        return status === 'open'
          ? ['Nothing to do. Add a task with: todo add "..."']
          : [`No ${status === 'done' ? 'completed ' : ''}tasks yet.`];
      }
      const done = tasks.filter((t) => t.done).length;
      const footer = style.dim(`${plural(tasks.length - done, 'open task')} · ${done} done`);
      return [...tasks.map((t) => formatTask(t, style)), '', footer];
    });
  },
};
