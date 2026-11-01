import type { Task } from '../domain/task.ts';
import { dueCell, priorityCell, type Cell } from './command.ts';
import type { Style } from './output.ts';

const GAP = '  ';
const ID_MIN_WIDTH = 4;

/**
 * Renders a task list as aligned columns, one line per task:
 * `  #3  [ ]  high  due Sat 14 Nov  Title`.
 *
 * Every column but the title is sized to its widest plain-text value and padded
 * before colour is applied, so escape codes never skew the alignment. The
 * priority and due columns are left out when no listed task has a value for
 * them; the title comes last and is never padded, so rows have no trailing space.
 * `today` is the local calendar date (YYYY-MM-DD) from the injected clock.
 */
export function renderTaskRows(tasks: readonly Task[], style: Style, today: string): string[] {
  const ids: Cell[] = tasks.map((t) => ({ text: `#${t.id}`, paint: style.dim }));
  const boxes: Cell[] = tasks.map((t) => (t.done ? { text: '[x]', paint: style.green } : { text: '[ ]', paint: plain }));
  const priorities = tasks.map((t) => priorityCell(t, style));
  const dues = tasks.map((t) => dueCell(t, style, today));

  const columns: Column[] = [
    { cells: ids, width: widest(ids, ID_MIN_WIDTH), align: 'right' },
    { cells: boxes, width: widest(boxes), align: 'left' },
  ];
  for (const cells of [priorities, dues]) {
    if (cells.some((c) => c.text !== '')) columns.push({ cells, width: widest(cells), align: 'left' });
  }

  return tasks.map((task, row) => {
    const padded = columns.map(({ cells, width, align }) => pad(cells[row] ?? EMPTY, width, align));
    const title = task.done ? style.dim(task.title) : task.title;
    return [...padded, title].join(GAP);
  });
}

interface Column {
  readonly cells: readonly Cell[];
  readonly width: number;
  readonly align: 'left' | 'right';
}

const plain = (s: string): string => s;
const EMPTY: Cell = { text: '', paint: plain };

function widest(cells: readonly Cell[], min = 0): number {
  return cells.reduce((max, c) => Math.max(max, c.text.length), min);
}

/** Pads the plain text to `width`, then colours only the text (never the padding). */
function pad(cell: Cell, width: number, align: 'left' | 'right'): string {
  const fill = ' '.repeat(Math.max(0, width - cell.text.length));
  const painted = cell.text === '' ? '' : cell.paint(cell.text);
  return align === 'right' ? `${fill}${painted}` : `${painted}${fill}`;
}
