import { TodoError } from '../../domain/errors.ts';
import { formatTask, parseTaskId, type Command } from '../command.ts';

export const dueCommand: Command = {
  name: 'due',
  summary: "Set or clear a task's due date",
  usage: '<id> (<when> | --clear) [--json]',
  options: { clear: { type: 'boolean' } },
  examples: [
    'todo due 3 2026-11-14',
    'todo due 3 friday       # <when>: YYYY-MM-DD, today, tomorrow, a weekday',
    'todo due 3 --clear',
  ],
  async run({ service, out }, { positionals, values }) {
    const [rawId, ...words] = positionals;
    const clear = values['clear'] === true;
    if (rawId === undefined) {
      throw new TodoError('USAGE', '`todo due` needs a task number.', { hint: 'Example: todo due 3 friday' });
    }
    if (clear && words.length > 0) {
      throw new TodoError('USAGE', 'Give either a due date or --clear, not both.', {
        hint: 'Example: todo due 3 friday, or todo due 3 --clear',
      });
    }
    if (!clear && words.length === 0) {
      throw new TodoError('USAGE', '`todo due` needs a date, or --clear to remove it.', {
        hint: 'Example: todo due 3 friday, or todo due 3 --clear',
      });
    }
    const task = await service.setDue(parseTaskId(rawId), clear ? null : words.join(' '));
    const today = service.today();
    out.result(task, (style) => [
      `${style.green(task.dueDate === null ? 'Cleared due date' : 'Due')} ${formatTask(task, style, today)}`,
    ]);
  },
};
