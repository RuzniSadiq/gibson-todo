import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { EXIT, run } from '../../src/cli/app.ts';
import { InMemoryRepository } from '../../src/infrastructure/storage/memory-repository.ts';
import { captureIo, fixedClock } from '../helpers.ts';

describe('cli app', () => {
  let repository: InMemoryRepository;
  const todo = async (...argv: string[]) => {
    const io = captureIo();
    const code = await run(argv, io, { repository, clock: fixedClock() });
    return { code, out: io.out(), err: io.err() };
  };
  beforeEach(() => (repository = new InMemoryRepository()));

  it('[AC-1.1] add → list → done → undo → edit → rm → clear', async () => {
    assert.match((await todo('add', 'Buy', 'milk')).out, /Added\s+#1 {2}\[ \] {2}Buy milk/);
    await todo('add', 'Ship release');
    assert.match((await todo('done', '#1')).out, /Done/);
    const open = await todo('list');
    assert.doesNotMatch(open.out, /Buy milk/);
    assert.match(open.out, /1 open task · 0 done/);
    assert.match((await todo('ls', '--all')).out, /\[x\] {2}Buy milk/);
    await todo('undo', '1');
    assert.match((await todo('edit', '1', 'Buy', 'oat', 'milk')).out, /Buy oat milk/);
    await todo('rm', '2');
    await todo('done', '1');
    assert.match((await todo('clear')).out, /Cleared 1 completed task\./);
    assert.match((await todo()).out, /Nothing to do/);
  });

  it('[AC-1.4] --json emits parseable documents', async () => {
    const added = JSON.parse((await todo('add', 'x', '--json')).out);
    assert.deepEqual(Object.keys(added).sort(), ['completedAt', 'createdAt', 'done', 'dueDate', 'id', 'priority', 'title']);
    assert.equal(added.dueDate, null);
    assert.equal(added.priority, 'normal');
    const listed = JSON.parse((await todo('list', '--json')).out);
    assert.equal(listed[0].title, 'x');
    assert.deepEqual(JSON.parse((await todo('clear', '--json')).out), { removed: 0 });
  });

  it('[AC-1.4] maps failures to stable exit codes', async () => {
    assert.equal((await todo('done', '7')).code, EXIT.user);
    assert.equal((await todo('add', '   ')).code, EXIT.user);
    assert.equal((await todo('done')).code, EXIT.usage);
    assert.equal((await todo('done', 'abc')).code, EXIT.usage);
    assert.equal((await todo('list', '--bogus')).code, EXIT.usage);
    assert.equal((await todo('list', '--all', '--done')).code, EXIT.usage);
    const unknown = await todo('lsit');
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.err, /Did you mean `todo list`/);
  });

  it('[AC-1.4] reports errors as JSON on stderr in --json mode', async () => {
    const result = await todo('done', '9', '--json');
    assert.equal(result.out, '');
    assert.deepEqual(JSON.parse(result.err).error.code, 'NOT_FOUND');
  });

  it('prints help and version', async () => {
    assert.match((await todo('help')).out, /Commands:/);
    assert.match((await todo('help', 'done')).out, /todo done <id\.\.\.>/);
    assert.match((await todo('add', '--help')).out, /Examples:/);
    assert.match((await todo('--version')).out, /^\d+\.\d+\.\d+\n$/);
  });
});
