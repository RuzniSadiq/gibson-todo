import { formatTask, requireIds, type Command } from '../command.ts';

export const removeCommand: Command = {
  name: 'rm',
  aliases: ['remove', 'delete'],
  summary: 'Delete tasks permanently',
  usage: '<id...> [--json]',
  examples: ['todo rm 3'],
  async run({ service, out }, args) {
    const tasks = await service.remove(requireIds(args, 'rm'));
    const today = service.today();
    out.result(tasks, (style) => tasks.map((t) => `${style.red('Removed')} ${formatTask(t, style, today)}`));
  },
};
