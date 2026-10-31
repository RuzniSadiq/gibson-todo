import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { systemClock, type Clock, type TaskRepository } from '../application/ports.ts';
import { TaskService } from '../application/task-service.ts';
import { isTodoError, TodoError, type ErrorCode } from '../domain/errors.ts';
import { resolveDataFile } from '../infrastructure/config.ts';
import { JsonFileRepository } from '../infrastructure/storage/json-file-repository.ts';
import type { Command } from './command.ts';
import { Output, type Io } from './output.ts';
import { COMMANDS, findCommand } from './registry.ts';

/** Stable, documented exit statuses — scripts may depend on them. */
export const EXIT = Object.freeze({ ok: 0, user: 1, usage: 2, storage: 3, internal: 70 });

const EXIT_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: EXIT.user,
  NOT_FOUND: EXIT.user,
  USAGE: EXIT.usage,
  STORAGE: EXIT.storage,
};

export interface AppDeps {
  readonly repository?: TaskRepository;
  readonly clock?: Clock;
}

/** The whole CLI as a function: argv in, exit status out. main.ts is a thin shell. */
export async function run(argv: readonly string[], io: Io, deps: AppDeps = {}): Promise<number> {
  const wantsJson = argv.includes('--json');
  const [first, ...rest] = argv;

  if (first === undefined) return run(['list'], io, deps);
  if (first === '--version' || first === '-v') {
    io.stdout.write(`${version()}\n`);
    return EXIT.ok;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    io.stdout.write(`${helpText(rest[0])}\n`);
    return EXIT.ok;
  }

  try {
    const command = findCommand(first);
    if (!command) throw unknownCommand(first);
    const { values, positionals } = parseCommandArgs(command, rest);
    if (values['help']) {
      io.stdout.write(`${helpText(command.name)}\n`);
      return EXIT.ok;
    }
    const out = new Output(io, values['json'] ? 'json' : 'text');
    const repository = deps.repository ?? new JsonFileRepository(resolveDataFile(io.env));
    const service = new TaskService(repository, deps.clock ?? systemClock);
    await command.run({ service, out }, { values, positionals });
    return EXIT.ok;
  } catch (error) {
    const out = new Output(io, wantsJson ? 'json' : 'text');
    if (isTodoError(error)) {
      out.error(error);
      return EXIT_BY_CODE[error.code];
    }
    out.error({ code: 'INTERNAL', message: 'Unexpected failure — this is a bug.', hint: String(error) });
    return EXIT.internal;
  }
}

function parseCommandArgs(command: Command, args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        ...command.options,
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TodoError('USAGE', detail, { hint: `Run \`todo help ${command.name}\`.` });
  }
}

function unknownCommand(name: string): TodoError {
  const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const guess = names.find((candidate) => editDistance(candidate, name) <= 2);
  return new TodoError('USAGE', `Unknown command "${name}".`, {
    hint: guess ? `Did you mean \`todo ${guess}\`?` : 'Run `todo help` to see all commands.',
  });
}

export function helpText(commandName?: string): string {
  const command = commandName ? findCommand(commandName) : undefined;
  if (command) {
    const lines = [`todo ${command.name} ${command.usage}`, '', `  ${command.summary}.`];
    if (command.aliases?.length) lines.push('', `  Aliases: ${command.aliases.join(', ')}`);
    if (command.examples?.length) lines.push('', '  Examples:', ...command.examples.map((e) => `    ${e}`));
    return lines.join('\n');
  }
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `todo ${version()} — a small, fast task list for your terminal`,
    '',
    'Usage: todo <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Options:',
    '  --json       Machine-readable output',
    '  -h, --help   Show help (also: todo help <command>)',
    '  -v, --version',
    '',
    'Tasks are stored in $TODO_FILE, or ~/.local/share/gibson-todo/tasks.json.',
  ].join('\n');
}

let cachedVersion: string | undefined;
function version(): string {
  // Resolves to the package root from both src/cli and dist/cli.
  cachedVersion ??= (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  ).version;
  return cachedVersion;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] as number;
      row[j] = Math.min(current + 1, (row[j - 1] as number) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] as number;
}
