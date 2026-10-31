import { TodoError } from '../../domain/errors.ts';
import { formatTask, parseTaskId, type Command } from '../command.ts';

export const editCommand: Command = {
  name: 'edit',
  aliases: ['rename'],
  summary: "Change a task's title",
  usage: '<id> <new title...> [--json]',
  examples: ['todo edit 3 "Book flights to Porto"'],
  async run({ service, out }, { positionals }) {
    const [rawId, ...words] = positionals;
    if (rawId === undefined || words.length === 0) {
      throw new TodoError('USAGE', '`todo edit` needs a task number and a new title.', {
        hint: 'Example: todo edit 3 "New title"',
      });
    }
    const task = await service.rename(parseTaskId(rawId), words.join(' '));
    out.result(task, (style) => [`${style.green('Updated')} ${formatTask(task, style)}`]);
  },
};
