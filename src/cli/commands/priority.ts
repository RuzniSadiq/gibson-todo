import { TodoError } from '../../domain/errors.ts';
import { formatTask, parseTaskId, type Command } from '../command.ts';

export const priorityCommand: Command = {
  name: 'priority',
  summary: "Set a task's priority",
  usage: '<id> <level> [--json]',
  examples: [
    'todo priority 3 high',
    'todo priority 3 low     # <level>: high, normal, low',
  ],
  async run({ service, out }, { positionals }) {
    const [rawId, ...words] = positionals;
    if (rawId === undefined) {
      throw new TodoError('USAGE', '`todo priority` needs a task number and a level.', {
        hint: 'Example: todo priority 3 high',
      });
    }
    if (words.length === 0) {
      throw new TodoError('USAGE', '`todo priority` needs a level: high, normal or low.', {
        hint: 'Example: todo priority 3 high',
      });
    }
    // Several words are joined so the error names exactly what was typed.
    const task = await service.setPriority(parseTaskId(rawId), words.join(' '));
    const today = service.today();
    out.result(task, (style) => [`${style.green(`Priority ${task.priority}`)} ${formatTask(task, style, today)}`]);
  },
};
