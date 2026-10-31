import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TodoError } from '../../src/domain/errors.ts';
import { latestVersion, migrateToCurrent } from '../../src/infrastructure/storage/migrations.ts';
import { CURRENT_SCHEMA_VERSION, decodeStore, encodeStore } from '../../src/infrastructure/storage/schema.ts';

const task = { id: 1, title: 'a', done: false, createdAt: '2026-10-31T09:00:00.000Z', completedAt: null };
const doc = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, nextId: 2, tasks: [task], ...over });
const isStorage = (e: unknown) => e instanceof TodoError && e.code === 'STORAGE';

describe('store schema', () => {
  it('[AC-1.2] round-trips the current version', () => {
    const state = decodeStore(doc());
    assert.deepEqual(encodeStore(state), doc());
    assert.equal(encodeStore(state).schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it('[AC-1.2] refuses files written by a newer version', () => {
    assert.throws(() => decodeStore(doc({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })), /newer version/);
  });

  it('[AC-1.2] rejects structurally invalid documents', () => {
    for (const bad of [
      null,
      [],
      {},
      doc({ schemaVersion: 0 }),
      doc({ nextId: 0 }),
      doc({ tasks: 'nope' }),
      doc({ tasks: [{ ...task, id: 'one' }] }),
      doc({ tasks: [task, task] }),
      doc({ nextId: 1 }),
      doc({ tasks: [{ ...task, done: true }] }),
      doc({ tasks: [{ ...task, createdAt: 'yesterday' }] }),
    ]) {
      assert.throws(() => decodeStore(bad), isStorage, JSON.stringify(bad));
    }
  });

  it('migration registry reaches exactly the current schema version', () => {
    assert.equal(latestVersion(), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrateToCurrent(doc(), 1, CURRENT_SCHEMA_VERSION), doc());
    assert.throws(() => migrateToCurrent(doc(), 1, CURRENT_SCHEMA_VERSION + 1), /No migration/);
  });
});
