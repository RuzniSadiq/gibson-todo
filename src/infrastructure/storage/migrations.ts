/**
 * Forward-only schema migrations.  ⚠ TIER C (schema) — see AGENTS.md.
 *
 * MIGRATIONS[n] upgrades a version-n document to version n+1. Migrations are
 * pure, additive (they only add fields with safe defaults) and never delete
 * user data. Add a test in test/infrastructure/schema.test.ts for each one.
 */
import { TodoError } from '../../domain/errors.ts';

type Document = Record<string, unknown>;
type Migration = (doc: Document) => Document;

export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({
  // v1 → v2: every task gains `dueDate: null`. Non-object entries and a
  // non-list `tasks` are passed through untouched so the decoder reports them.
  1: (doc: Document): Document => ({
    ...doc,
    schemaVersion: 2,
    tasks: Array.isArray(doc['tasks'])
      ? doc['tasks'].map((t: unknown) => (isRecord(t) ? { ...t, dueDate: null } : t))
      : doc['tasks'],
  }),
  // v2 → v3: every task gains `priority: 'normal'`. Same pass-through rule:
  // non-object entries and a non-list `tasks` are left for the decoder.
  2: (doc: Document): Document => ({
    ...doc,
    schemaVersion: 3,
    tasks: Array.isArray(doc['tasks'])
      ? doc['tasks'].map((t: unknown) => (isRecord(t) ? { ...t, priority: 'normal' } : t))
      : doc['tasks'],
  }),
});

function isRecord(v: unknown): v is Document {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function migrateToCurrent(doc: Document, fromVersion: number, target: number): Document {
  let current = doc;
  for (let version = fromVersion; version < target; version += 1) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new TodoError('STORAGE', `No migration from schema v${version} to v${version + 1}.`);
    }
    current = step(current);
  }
  return current;
}

/** The schema version reached by applying every registered migration to v1. */
export function latestVersion(): number {
  let version = 1;
  while (MIGRATIONS[version]) version += 1;
  return version;
}
