import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { TodoError } from '../../src/domain/errors.ts';
import { latestVersion, migrateToCurrent, MIGRATIONS } from '../../src/infrastructure/storage/migrations.ts';
import { CURRENT_SCHEMA_VERSION, decodeStore, encodeStore } from '../../src/infrastructure/storage/schema.ts';

const taskV1 = { id: 1, title: 'a', done: false, createdAt: '2026-10-31T09:00:00.000Z', completedAt: null };
const taskV2 = { ...taskV1, dueDate: null };
const task = { ...taskV2, priority: 'normal' };
const doc = (over: Record<string, unknown> = {}) => ({ schemaVersion: 3, nextId: 2, tasks: [task], ...over });
const docV2 = (over: Record<string, unknown> = {}) => ({ schemaVersion: 2, nextId: 2, tasks: [taskV2], ...over });
const docV1 = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, nextId: 2, tasks: [taskV1], ...over });
const isStorage = (e: unknown) => e instanceof TodoError && e.code === 'STORAGE';

interface FixtureDoc {
  [key: string]: unknown;
  schemaVersion: number;
  nextId: number;
  tasks: Record<string, unknown>[];
}
const loadFixture = async (path: string) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as FixtureDoc;
const loadFixtureV1 = () => loadFixture('../fixtures/store-v1.json');
const loadFixtureV2 = () => loadFixture('../fixtures/store-v2.json');
const loadFixtureV3 = () => loadFixture('../fixtures/ux/store-v3.json');
const loadFixtureV4 = () => loadFixture('../fixtures/ux/store-v4.json');

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
    assert.equal(CURRENT_SCHEMA_VERSION, 3);
    assert.equal(latestVersion(), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrateToCurrent(docV1(), 1, CURRENT_SCHEMA_VERSION), doc());
    assert.deepEqual(migrateToCurrent(docV2(), 2, CURRENT_SCHEMA_VERSION), doc());
    assert.deepEqual(migrateToCurrent(doc(), 3, CURRENT_SCHEMA_VERSION), doc());
    assert.throws(() => migrateToCurrent(doc(), 1, CURRENT_SCHEMA_VERSION + 1), /No migration/);
  });

  it('[AC-5.1] decodes the checked-in v1 fixture with dueDate null and re-encodes it as the current version, other fields unchanged', async () => {
    const fixture = await loadFixtureV1();
    assert.equal(fixture.schemaVersion, 1, 'the fixture really is a version-1 file');
    assert.ok(fixture.tasks.length > 1 && fixture.tasks.every((t) => !('dueDate' in t)));

    const state = decodeStore(fixture);
    assert.equal(state.tasks.length, fixture.tasks.length);
    for (const t of state.tasks) assert.equal(t.dueDate, null);

    const encoded = encodeStore(state);
    assert.equal(encoded.schemaVersion, CURRENT_SCHEMA_VERSION);
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
    const v2 = docV2({ tasks: [{ ...taskV2, dueDate: '2026-11-14' }] });
    assert.equal(decodeStore(v2).tasks[0]?.dueDate, '2026-11-14', 'a v2 file keeps its due date');
  });

  it('[AC-5.3] rejects an invalid or missing v2 dueDate with a STORAGE error', () => {
    for (const dueDate of ['2026-02-30', '14/11/2026', 42, '2026-11-14T00:00:00Z', '', '2026-13-01', undefined]) {
      for (const bad of [docV2({ tasks: [{ ...taskV2, dueDate }] }), doc({ tasks: [{ ...task, dueDate }] })]) {
        assert.throws(() => decodeStore(bad), isStorage, `dueDate ${JSON.stringify(dueDate)} in v${bad.schemaVersion}`);
      }
    }
    const missing: Record<string, unknown> = { ...taskV2 };
    delete missing['dueDate'];
    assert.throws(() => decodeStore(docV2({ tasks: [missing] })), isStorage, 'missing dueDate key');
  });

  it('[AC-5.4] [AC-21.4] refuses a schemaVersion 4 document as written by a newer version', async () => {
    const newer = (e: unknown) => isStorage(e) && /written by a newer version/.test((e as Error).message);
    assert.throws(() => decodeStore(doc({ schemaVersion: 4 })), newer);
    const fixture = await loadFixtureV4();
    assert.equal(fixture.schemaVersion, 4, 'the ux fixture moved from v3 to v4');
    assert.throws(() => decodeStore(fixture), newer);
  });

  const pickV2 = (t: Record<string, unknown>) => ({
    id: t['id'],
    title: t['title'],
    done: t['done'],
    createdAt: t['createdAt'],
    completedAt: t['completedAt'],
    dueDate: t['dueDate'],
  });

  it('[AC-21.1] decodes the v2 fixture with every original field unchanged and priority normal on each task', async () => {
    const fixture = await loadFixtureV2();
    assert.equal(fixture.schemaVersion, 2, 'the fixture really is a version-2 file');
    assert.ok(fixture.tasks.length > 2, 'several tasks');
    assert.ok(fixture.tasks.some((t) => t['dueDate'] !== null) && fixture.tasks.some((t) => t['dueDate'] === null));
    assert.ok(fixture.tasks.some((t) => t['done'] === true) && fixture.tasks.some((t) => t['done'] === false));
    assert.ok(fixture.tasks.every((t) => !('priority' in t)));

    const state = decodeStore(fixture);
    assert.equal(state.nextId, fixture.nextId);
    assert.deepEqual(state.tasks.map((t) => pickV2({ ...t })), fixture.tasks.map(pickV2));
    assert.deepEqual(state.tasks, fixture.tasks.map((t) => ({ ...t, priority: 'normal' })));

    const encoded = encodeStore(state);
    assert.equal(encoded.schemaVersion, 3);
    assert.equal(encoded.nextId, fixture.nextId);
    assert.deepEqual(encoded.tasks, fixture.tasks.map((t) => ({ ...t, priority: 'normal' })));
  });

  it('[AC-21.1] decodes the v1 fixture through v2 → v3 with dueDate null, priority normal and other fields unchanged', async () => {
    const fixture = await loadFixtureV1();
    assert.equal(fixture.schemaVersion, 1);
    const state = decodeStore(fixture);
    assert.equal(state.nextId, fixture.nextId);
    assert.deepEqual(state.tasks, fixture.tasks.map((t) => ({ ...t, dueDate: null, priority: 'normal' })));
  });

  it('[AC-21.1] the v2→v3 migration is pure and leaves non-object entries and a non-list tasks for the decoder', async () => {
    const migrate = MIGRATIONS[2];
    assert.ok(migrate, 'MIGRATIONS[2] is registered');
    for (const input of [docV2(), await loadFixtureV2()]) {
      const snapshot = structuredClone(input);
      const frozen = deepFreeze(input);
      let out: Record<string, unknown> | undefined;
      assert.doesNotThrow(() => (out = migrate(frozen)));
      assert.deepEqual(frozen, snapshot, 'input unchanged');
      assert.notEqual(out, frozen);
      assert.equal(out?.['schemaVersion'], 3);
      const tasks = out?.['tasks'] as Record<string, unknown>[];
      assert.deepEqual(tasks, snapshot.tasks.map((t) => ({ ...t, priority: 'normal' })));
      assert.deepEqual(migrate(frozen), out, 'deterministic');
    }

    const odd = deepFreeze(docV2({ nextId: 3, tasks: [42, null, 'x', [1], { ...taskV2, id: 2 }] }));
    assert.deepEqual(migrate(odd)['tasks'], [42, null, 'x', [1], { ...taskV2, id: 2, priority: 'normal' }]);
    for (const tasks of ['nope', 7, null, { 0: taskV2 }]) {
      assert.equal(migrate(deepFreeze(docV2({ tasks })))['tasks'], tasks, `tasks ${JSON.stringify(tasks)} passed through`);
    }

    for (const bad of [
      docV2({ tasks: [42] }),
      docV2({ tasks: [null] }),
      docV2({ tasks: ['x'] }),
      docV2({ tasks: [[taskV2]] }),
      docV2({ tasks: 'nope' }),
      docV2({ tasks: { 0: taskV2 } }),
      docV2({ tasks: null }),
    ]) {
      assert.throws(() => decodeStore(bad), isStorage, JSON.stringify(bad));
    }
  });

  it('[AC-21.2] a v3 state round-trips high, normal and low exactly', async () => {
    const input = doc({
      nextId: 4,
      tasks: [
        { ...task, id: 1, priority: 'high', dueDate: '2026-11-14' },
        { ...task, id: 2, priority: 'normal' },
        { ...task, id: 3, priority: 'low', done: true, completedAt: '2026-10-31T10:00:00.000Z' },
      ],
    });
    const state = decodeStore(input);
    assert.deepEqual(state.tasks.map((t) => t.priority), ['high', 'normal', 'low']);
    assert.deepEqual(encodeStore(state), input);
    assert.deepEqual(decodeStore(JSON.parse(JSON.stringify(encodeStore(state)))), state);

    const fixture = await loadFixtureV3();
    assert.equal(fixture.schemaVersion, 3, 'the real v3 fixture');
    assert.deepEqual(encodeStore(decodeStore(fixture)), fixture);
  });

  it('[AC-21.3] a v3 task with a missing, unknown, mis-cased or numeric priority is damage', () => {
    const missing: Record<string, unknown> = { ...task };
    delete missing['priority'];
    const bads: unknown[] = [undefined, 'urgent', 'High', 'HIGH', ' high', 'high ', 'high\n', '', 1, 0, null, true, ['high'], { level: 'high' }];
    const cases = [missing, ...bads.map((priority) => ({ ...task, priority }))];
    for (const t of cases) {
      assert.throws(
        () => decodeStore(doc({ tasks: [t] })),
        (e: unknown) =>
          isStorage(e) && /damaged/.test((e as Error).message) && /priority/.test((e as Error).message) && Boolean((e as TodoError).hint),
        JSON.stringify(t),
      );
    }
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
