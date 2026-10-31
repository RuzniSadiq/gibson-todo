import { formatTask, requireIds, type Command } from '../command.ts';

export const doneCommand: Command = {
  name: 'done',
  aliases: ['check'],
  summary: 'Mark tasks as done',
  usage: '<id...> [--json]',
  examples: ['todo done 3', 'todo done 3 4 7'],
  async run({ service, out }, args) {
    const tasks = await service.complete(requireIds(args, 'done'));
    const today = service.today();
    out.result(tasks, (style) => tasks.map((t) => `${style.green('Done')}  ${formatTask(t, style, today)}`));
  },
};
