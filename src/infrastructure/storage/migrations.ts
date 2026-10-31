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
  // Example for the next schema change:
  // 1: (doc) => ({ ...doc, schemaVersion: 2, tasks: (doc.tasks as Document[]).map((t) => ({ ...t, newField: null })) }),
});

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
