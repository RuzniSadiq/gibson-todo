import { formatTask, type Command } from '../command.ts';

export const addCommand: Command = {
  name: 'add',
  summary: 'Add a task',
  usage: '<title...> [--json]',
  examples: ['todo add "Book flights to Lisbon"', 'todo add Call the bank'],
  async run({ service, out }, { positionals }) {
    const task = await service.add(positionals.join(' '));
    out.result(task, (style) => [`${style.green('Added')} ${formatTask(task, style)}`]);
  },
};
