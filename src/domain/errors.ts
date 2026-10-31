/**
 * Every failure the application can report is a TodoError with a stable code.
 * The CLI maps codes to exit statuses; nothing else inspects messages.
 */
export type ErrorCode =
  | 'VALIDATION' // the input was understood but is not acceptable
  | 'NOT_FOUND' // the referenced task does not exist
  | 'USAGE' // the command line itself was malformed
  | 'STORAGE'; // the task store could not be read or written safely

export class TodoError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TodoError';
    this.code = code;
    this.hint = options?.hint;
  }
}

export const isTodoError = (value: unknown): value is TodoError => value instanceof TodoError;
