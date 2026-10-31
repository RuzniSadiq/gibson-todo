import { TodoError } from './errors.ts';

/** How urgent a task is. Stored and shown in lower case. */
export type Priority = 'high' | 'normal' | 'low';

/** Every level, most urgent first. */
export const PRIORITIES: readonly Priority[] = Object.freeze(['high', 'normal', 'low']);

export const DEFAULT_PRIORITY: Priority = 'normal';

export const PRIORITY_INPUT_HINT = 'Use one of: high, normal, low.';

/**
 * Strict guard: true only for an exact lower-case level. Used by the store
 * decoder, so 'High', ' high', a trailing newline or the number 1 are never
 * accepted from a file.
 */
export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

// C0/C1 control characters (tab, newline, ...) and line/paragraph separators.
// trim() would silently strip a trailing newline, so such input is refused up front.
function hasControlOrLineBreak(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) return true;
  }
  return false;
}

/**
 * Resolves user input to a level: surrounding spaces are trimmed and the word
 * is lower-cased, then it must match a level exactly. Anything else (including
 * input containing a control character or line break) is a VALIDATION error
 * naming the bad value.
 */
export function parsePriority(input: string): Priority {
  if (!hasControlOrLineBreak(input)) {
    const word = input.trim().toLowerCase();
    if (isPriority(word)) return word;
  }
  throw new TodoError('VALIDATION', `${JSON.stringify(input)} is not a priority I understand.`, {
    hint: PRIORITY_INPUT_HINT,
  });
}

/** Sort rank: high < normal < low (lower sorts first). */
export function priorityRank(priority: Priority): number {
  return PRIORITIES.indexOf(priority);
}
