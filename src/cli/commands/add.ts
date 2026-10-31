import { formatTask, type Command } from '../command.ts';

export const addCommand: Command = {
  name: 'add',
  summary: 'Add a task',
  usage: '<title...> [--due <when>] [--priority <level>] [--json]',
  options: { due: { type: 'string' }, priority: { type: 'string', short: 'p' } },
  examples: [
    'todo add "Book flights to Lisbon"',
    'todo add Call the bank',
    'todo add "Pay invoice" --due friday     # --due: YYYY-MM-DD, today, tomorrow, a weekday',
    'todo add "Pay invoice" --priority high  # --priority/-p: high, normal, low',
  ],
  async run({ service, out }, { positionals, values }) {
    const due = values['due'];
    const priority = values['priority'];
    const task = await service.add(
      positionals.join(' '),
      typeof due === 'string' ? due : undefined,
      typeof priority === 'string' ? priority : undefined,
    );
    const today = service.today();
    out.result(task, (style) => [`${style.green('Added')} ${formatTask(task, style, today)}`]);
  },
};
