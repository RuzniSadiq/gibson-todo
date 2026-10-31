import type { Env } from '../infrastructure/config.ts';

export interface TextSink {
  write(chunk: string): unknown;
}

export interface Io {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly env: Env;
  readonly isTTY: boolean;
}

export type Mode = 'text' | 'json';

/** ANSI styling that switches itself off for pipes, NO_COLOR and JSON mode. */
export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
}

const code = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;
const identity = (s: string) => s;

export function createStyle(enabled: boolean): Style {
  if (!enabled) return { bold: identity, dim: identity, green: identity, red: identity, yellow: identity };
  return { bold: code(1, 22), dim: code(2, 22), green: code(32, 39), red: code(31, 39), yellow: code(33, 39) };
}

export function colorEnabled(io: Io): boolean {
  if (io.env['NO_COLOR'] !== undefined && io.env['NO_COLOR'] !== '') return false;
  if (io.env['FORCE_COLOR'] !== undefined && io.env['FORCE_COLOR'] !== '0') return true;
  return io.isTTY;
}

/**
 * Commands produce a value plus a text rendering of it. In JSON mode only the
 * value is printed (one document per invocation), so scripts get a stable shape.
 */
export class Output {
  readonly mode: Mode;
  readonly style: Style;
  readonly #io: Io;

  constructor(io: Io, mode: Mode) {
    this.#io = io;
    this.mode = mode;
    this.style = createStyle(mode === 'text' && colorEnabled(io));
  }

  result(value: unknown, renderText: (style: Style) => readonly string[]): void {
    if (this.mode === 'json') {
      this.#io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    const lines = renderText(this.style);
    if (lines.length > 0) this.#io.stdout.write(`${lines.join('\n')}\n`);
  }

  error(error: { code: string; message: string; hint?: string | undefined }): void {
    if (this.mode === 'json') {
      const body = { error: { code: error.code, message: error.message, hint: error.hint ?? null } };
      this.#io.stderr.write(`${JSON.stringify(body)}\n`);
      return;
    }
    const lines = [`${this.style.red('error:')} ${error.message}`];
    if (error.hint) lines.push(this.style.dim(`hint: ${error.hint}`));
    this.#io.stderr.write(`${lines.join('\n')}\n`);
  }
}
