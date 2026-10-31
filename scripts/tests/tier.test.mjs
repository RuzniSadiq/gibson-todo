import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../gibson/lib/config.mjs';
import { globToRegExp, scopesOverlap } from '../gibson/lib/glob.mjs';
import { assessTier, classifyPaths, isMemoryOnly, maxTier } from '../gibson/lib/tier.mjs';

const config = loadConfig();
const small = { files: 1, lines: 10 };

describe('tier classifier', () => {
  it('[AC-1.6] maps changed paths to risk tiers', () => {
    assert.equal(classifyPaths(['src/cli/commands/list.ts'], config).tier, 'A');
    assert.equal(classifyPaths(['test/cli/app.test.ts', 'README.md'], config).tier, 'A');
    assert.equal(classifyPaths(['src/domain/task.ts'], config).tier, 'B');
    assert.equal(classifyPaths(['package.json'], config).tier, 'B');
    assert.equal(classifyPaths(['src/infrastructure/storage/schema.ts'], config).tier, 'C');
    assert.equal(classifyPaths(['src/infrastructure/storage/migrations.ts'], config).tier, 'C');
    assert.equal(classifyPaths(['.github/workflows/gibson-gate.yml'], config).tier, 'C');
    assert.equal(classifyPaths(['scripts/review-evidence.mjs'], config).tier, 'C');
    assert.equal(classifyPaths(['gibson/PRODUCT-DIRECTION.md'], config).tier, 'C', 'the most severe matching rule wins');
    assert.equal(classifyPaths(['somewhere/new.txt'], config).tier, 'B', 'unknown paths fail safe to B');
  });

  it('[AC-1.6] size alone lifts routine work to Tier B (>150 lines or >6 files)', () => {
    assert.equal(assessTier({ paths: ['src/cli/a.ts'], size: { files: 1, lines: 151 }, declared: 'A' }, config).tier, 'B');
    assert.equal(assessTier({ paths: ['src/cli/a.ts'], size: { files: 7, lines: 20 }, declared: 'A' }, config).tier, 'B');
  });

  it('[AC-1.6] detects undeclared drift into Tier C, never drifts out', () => {
    const drift = assessTier({ paths: ['src/cli/x.ts', 'src/infrastructure/storage/schema.ts'], size: small, declared: 'A' }, config);
    assert.equal(drift.tier, 'C');
    assert.equal(drift.drift, true);
    assert.equal(drift.undeclaredTierC, true);
    const declaredC = assessTier({ paths: ['src/cli/x.ts'], size: small, declared: 'C' }, config);
    assert.equal(declaredC.tier, 'C', 'a declared tier is a floor');
    assert.equal(maxTier('A', 'C', 'B'), 'C');
  });

  it('memory-only changes are recognised (Law 4 exception)', () => {
    assert.equal(isMemoryOnly(['MEMORY.md'], config), true);
    assert.equal(isMemoryOnly(['MEMORY.md', 'src/cli/app.ts'], config), false);
    assert.equal(isMemoryOnly([], config), false);
  });

  it('globs and claim-scope overlap fail closed', () => {
    assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
    assert.ok(globToRegExp('src/**').test('src/x.ts'));
    assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
    assert.equal(scopesOverlap('src/cli/**', 'src/cli/commands/list.ts'), true);
    assert.equal(scopesOverlap('src/cli/**', 'src/domain/**'), false);
    assert.equal(scopesOverlap('**', 'src/domain/**'), true);
  });

  it('[AC-1.6] tier-classify CLI fails CI on undeclared drift', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gibson-tier-'));
    try {
      const sh = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      sh('init', '-q', '-b', 'main');
      sh('config', 'user.email', 't@example.com');
      sh('config', 'user.name', 't');
      mkdirSync(join(repo, 'gibson'));
      cpSync(fileURLToPath(new URL('../../gibson/config.json', import.meta.url)), join(repo, 'gibson/config.json'));
      writeFileSync(join(repo, 'README.md'), 'x\n');
      sh('add', '-A');
      sh('commit', '-qm', 'base');
      mkdirSync(join(repo, 'src/infrastructure/storage'), { recursive: true });
      writeFileSync(join(repo, 'src/infrastructure/storage/schema.ts'), 'export const v = 2;\n');
      sh('add', '-A');
      sh('commit', '-qm', 'change schema');
      const script = fileURLToPath(new URL('../tier-classify.mjs', import.meta.url));
      const labelledA = spawnSync(process.execPath, [script, '--base', 'HEAD~1', '--declared', 'A'], { cwd: repo, encoding: 'utf8' });
      assert.equal(labelledA.status, 1, labelledA.stdout);
      assert.match(labelledA.stdout, /drifted into Tier C/);
      const labelledC = spawnSync(process.execPath, [script, '--base', 'HEAD~1', '--labels', '["tier:C"]'], { cwd: repo, encoding: 'utf8' });
      assert.equal(labelledC.status, 0, labelledC.stdout);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
