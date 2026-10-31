import { plural, type Command } from '../command.ts';

export const clearCommand: Command = {
  name: 'clear',
  summary: 'Delete every completed task',
  usage: '[--json]',
  async run({ service, out }) {
    const removed = await service.clearCompleted();
    out.result({ removed }, () => [
      removed === 0 ? 'No completed tasks to clear.' : `Cleared ${plural(removed, 'completed task')}.`,
    ]);
  },
};
