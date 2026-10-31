/**
 * On-disk schema for the task store.  ⚠ TIER C (schema) — see AGENTS.md.
 *
 * Rules for changing this file:
 *  - Additive only. Bump CURRENT_SCHEMA_VERSION and add a migration from the
 *    previous version in migrations.ts; never edit an old version's shape.
 *  - A file written by a newer version is refused, never rewritten.
 *  - Every field is validated on read: the file is user-editable input.
 */
import type { TaskState } from '../../application/ports.ts';
import { TodoError } from '../../domain/errors.ts';
import type { Task } from '../../domain/task.ts';
import { migrateToCurrent } from './migrations.ts';

export const CURRENT_SCHEMA_VERSION = 1;

export interface StoredTaskV1 {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface StoreDocumentV1 {
  schemaVersion: 1;
  nextId: number;
  tasks: StoredTaskV1[];
}

/** Validates an already-JSON-parsed document and converts it to domain state. */
export function decodeStore(raw: unknown): TaskState {
  if (!isRecord(raw) || typeof raw['schemaVersion'] !== 'number') {
    throw corrupt('the file has no schemaVersion');
  }
  const version = raw['schemaVersion'];
  if (!Number.isInteger(version) || version < 1) {
    throw corrupt(`schemaVersion ${String(version)} is not valid`);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new TodoError(
      'STORAGE',
      `Your task file was written by a newer version of todo (schema v${version}; this build understands up to v${CURRENT_SCHEMA_VERSION}).`,
      { hint: 'Upgrade todo. The file has not been modified.' },
    );
  }
  const doc = migrateToCurrent(raw, version, CURRENT_SCHEMA_VERSION);
  return toState(doc);
}

export function encodeStore(state: TaskState): StoreDocumentV1 {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    nextId: state.nextId,
    tasks: state.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      done: t.done,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  };
}

function toState(doc: Record<string, unknown>): TaskState {
  const { nextId, tasks } = doc;
  if (!isPositiveInt(nextId)) throw corrupt('nextId must be a positive integer');
  if (!Array.isArray(tasks)) throw corrupt('tasks must be a list');

  const seen = new Set<number>();
  const decoded: Task[] = tasks.map((entry: unknown, index) => {
    const task = decodeTask(entry, index);
    if (seen.has(task.id)) throw corrupt(`task id ${task.id} appears twice`);
    if (task.id >= nextId) throw corrupt(`task id ${task.id} is not below nextId ${nextId}`);
    seen.add(task.id);
    return task;
  });
  return { nextId, tasks: decoded };
}

function decodeTask(entry: unknown, index: number): Task {
  const where = `task at position ${index + 1}`;
  if (!isRecord(entry)) throw corrupt(`${where} is not an object`);
  const { id, title, done, createdAt, completedAt } = entry;
  if (!isPositiveInt(id)) throw corrupt(`${where} has an invalid id`);
  if (typeof title !== 'string' || title.length === 0) throw corrupt(`${where} has no title`);
  if (typeof done !== 'boolean') throw corrupt(`${where} has an invalid done flag`);
  if (!isIsoInstant(createdAt)) throw corrupt(`${where} has an invalid createdAt`);
  if (completedAt !== null && !isIsoInstant(completedAt)) {
    throw corrupt(`${where} has an invalid completedAt`);
  }
  if (done !== (completedAt !== null)) {
    throw corrupt(`${where} has done/completedAt out of sync`);
  }
  return { id, title, done, createdAt, completedAt };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

const isIsoInstant = (v: unknown): v is string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

function corrupt(detail: string): TodoError {
  return new TodoError('STORAGE', `Your task file is damaged: ${detail}.`, {
    hint: 'The file has not been modified. Fix it by hand or move it aside to start fresh.',
  });
}
