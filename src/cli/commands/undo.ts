import { formatTask, requireIds, type Command } from '../command.ts';

export const undoCommand: Command = {
  name: 'undo',
  aliases: ['reopen'],
  summary: 'Mark completed tasks as open again',
  usage: '<id...> [--json]',
  examples: ['todo undo 3'],
  async run({ service, out }, args) {
    const tasks = await service.reopen(requireIds(args, 'undo'));
    const today = service.today();
    out.result(tasks, (style) => tasks.map((t) => `${style.yellow('Reopened')}  ${formatTask(t, style, today)}`));
  },
};
