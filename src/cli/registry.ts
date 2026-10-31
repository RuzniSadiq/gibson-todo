import type { Command } from './command.ts';
import { addCommand } from './commands/add.ts';
import { clearCommand } from './commands/clear.ts';
import { doneCommand } from './commands/done.ts';
import { dueCommand } from './commands/due.ts';
import { editCommand } from './commands/edit.ts';
import { listCommand } from './commands/list.ts';
import { removeCommand } from './commands/remove.ts';
import { undoCommand } from './commands/undo.ts';

/** Help output follows this order. New commands: add a file in ./commands and list it here. */
export const COMMANDS: readonly Command[] = [
  addCommand,
  listCommand,
  doneCommand,
  undoCommand,
  editCommand,
  dueCommand,
  removeCommand,
  clearCommand,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}
