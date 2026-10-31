import { formatDueDate } from '../../domain/due-date.ts';
import { formatTask, type Command } from '../command.ts';

export const addCommand: Command = {
  name: 'add',
  summary: 'Add a task',
  usage: '<title...> [--due <when>] [--json]',
  options: { due: { type: 'string' } },
  examples: [
    'todo add "Book flights to Lisbon"',
    'todo add Call the bank',
    'todo add "Pay invoice" --due friday     # --due: YYYY-MM-DD, today, tomorrow, a weekday',
  ],
  async run({ service, out }, { positionals, values }) {
    const due = values['due'];
    const task = await service.add(positionals.join(' '), typeof due === 'string' ? due : undefined);
    out.result(task, (style) => {
      const line = `${style.green('Added')} ${formatTask(task, style)}`;
      return [task.dueDate === null ? line : `${line}  ${style.dim(`due ${formatDueDate(task.dueDate)}`)}`];
    });
  },
};
