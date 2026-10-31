import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { TodoError } from '../../src/domain/errors.ts';
import { latestVersion, migrateToCurrent, MIGRATIONS } from '../../src/infrastructure/storage/migrations.ts';
import { CURRENT_SCHEMA_VERSION, decodeStore, encodeStore } from '../../src/infrastructure/storage/schema.ts';

const taskV1 = { id: 1, title: 'a', done: false, createdAt: '2026-10-31T09:00:00.000Z', completedAt: null };
const task = { ...taskV1, dueDate: null };
const doc = (over: Record<string, unknown> = {}) => ({ schemaVersion: 2, nextId: 2, tasks: [task], ...over });
const docV1 = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, nextId: 2, tasks: [taskV1], ...over });
const isStorage = (e: unknown) => e instanceof TodoError && e.code === 'STORAGE';

const FIXTURE_V1 = new URL('../fixtures/store-v1.json', import.meta.url);
const loadFixtureV1 = async () => JSON.parse(await readFile(FIXTURE_V1, 'utf8')) as {
  schemaVersion: number;
  nextId: number;
  tasks: Record<string, unknown>[];
};

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

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
      docV1({ tasks: 'nope' }),
      docV1({ tasks: [42] }),
      docV1({ tasks: [{ ...taskV1, done: true }] }),
    ]) {
      assert.throws(() => decodeStore(bad), isStorage, JSON.stringify(bad));
    }
  });

  it('migration registry reaches exactly the current schema version', () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 2);
    assert.equal(latestVersion(), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrateToCurrent(docV1(), 1, CURRENT_SCHEMA_VERSION), doc());
    assert.deepEqual(migrateToCurrent(doc(), 2, CURRENT_SCHEMA_VERSION), doc());
    assert.throws(() => migrateToCurrent(doc(), 1, CURRENT_SCHEMA_VERSION + 1), /No migration/);
  });

  it('[AC-5.1] decodes the checked-in v1 fixture with dueDate null and re-encodes it as v2, other fields unchanged', async () => {
    const fixture = await loadFixtureV1();
    assert.equal(fixture.schemaVersion, 1, 'the fixture really is a version-1 file');
    assert.ok(fixture.tasks.length > 1 && fixture.tasks.every((t) => !('dueDate' in t)));

    const state = decodeStore(fixture);
    assert.equal(state.tasks.length, fixture.tasks.length);
    for (const t of state.tasks) assert.equal(t.dueDate, null);

    const encoded = encodeStore(state);
    assert.equal(encoded.schemaVersion, 2);
    assert.equal(encoded.nextId, fixture.nextId);
    const pick = (t: Record<string, unknown>) => ({
      id: t['id'],
      title: t['title'],
      done: t['done'],
      createdAt: t['createdAt'],
      completedAt: t['completedAt'],
    });
    assert.deepEqual(
      encoded.tasks.map((t) => pick({ ...t })),
      fixture.tasks.map(pick),
    );
    for (const t of encoded.tasks) assert.equal(t.dueDate, null);
  });

  it('[AC-5.2] a v2 task with dueDate "2026-11-14" round-trips deep-equal', () => {
    const input = doc({
      nextId: 4,
      tasks: [
        { ...task, id: 1, dueDate: '2026-11-14' },
        { ...task, id: 3, title: 'b', done: true, completedAt: '2026-10-31T10:00:00.000Z', dueDate: null },
      ],
    });
    assert.deepEqual(encodeStore(decodeStore(input)), input);
    assert.equal(decodeStore(input).tasks[0]?.dueDate, '2026-11-14');
  });

  it('[AC-5.3] rejects an invalid or missing v2 dueDate with a STORAGE error', () => {
    for (const dueDate of ['2026-02-30', '14/11/2026', 42, '2026-11-14T00:00:00Z', '', '2026-13-01', undefined]) {
      const bad = doc({ tasks: [{ ...task, dueDate }] });
      assert.throws(() => decodeStore(bad), isStorage, `dueDate ${JSON.stringify(dueDate)}`);
    }
    const missing: Record<string, unknown> = { ...task };
    delete missing['dueDate'];
    assert.throws(() => decodeStore(doc({ tasks: [missing] })), isStorage, 'missing dueDate key');
  });

  it('[AC-5.4] refuses a schemaVersion 3 document as written by a newer version', () => {
    assert.throws(
      () => decodeStore(doc({ schemaVersion: 3 })),
      (e: unknown) => isStorage(e) && /written by a newer version/.test((e as Error).message),
    );
  });

  it('[AC-5.5] the v1→v2 migration is pure: frozen input is not mutated and the result is v2', async () => {
    const migrate = MIGRATIONS[1];
    assert.ok(migrate, 'MIGRATIONS[1] is registered');
    for (const input of [docV1(), await loadFixtureV1()]) {
      const snapshot = structuredClone(input);
      const frozen = deepFreeze(input);
      let out: Record<string, unknown> | undefined;
      assert.doesNotThrow(() => (out = migrate(frozen)));
      assert.deepEqual(frozen, snapshot, 'input unchanged');
      assert.equal(out?.['schemaVersion'], 2);
      assert.notEqual(out, frozen);
      const tasks = out?.['tasks'] as Record<string, unknown>[];
      assert.ok(tasks.every((t) => t['dueDate'] === null));
      assert.deepEqual(migrate(frozen), out, 'deterministic');
    }
  });
});
