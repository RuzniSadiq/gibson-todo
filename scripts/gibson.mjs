#!/usr/bin/env node
// bin/gibson — the owner's interface to the fleet.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './gibson/lib/config.mjs';
import { run as exec } from './gibson/lib/exec.mjs';
import * as ui from './gibson/lib/ui.mjs';

const HELP = `
  ${ui.c.bold('gibson')} — ask for a feature in plain English; the fleet plans, builds, reviews and ships it.

  ${ui.c.bold('Ask for something')}
    bin/gibson "Let me give tasks a priority and sort by it"

  ${ui.c.bold('Keep an eye on it')}
    bin/gibson status              what shipped, what is in flight, what needs you
    bin/gibson approve <pr>        approve a Tier C change that is waiting for you
    bin/gibson resume [run-id]     continue a run that stopped (e.g. after a pause)
    bin/gibson doctor              check runners, GitHub access and guardrails

  ${ui.c.bold('Control')}
    bin/gibson halt "<reason>"     kill switch: every lane stops at its next step
    bin/gibson unhalt              lift the kill switch
    bin/gibson deploy [--install]  rebuild the release; --install puts \`todo\` on your PATH
`;

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();

async function main() {
  switch (command) {
    case undefined: case 'help': case '--help': case '-h':
      console.log(HELP); return 0;
    case 'doctor': {
      const { doctor } = await import('./gibson/pipeline.mjs');
      return (await doctor(config)).ok ? 0 : 1;
    }
    case 'status': return (await import('./gibson/digest.mjs')).status();
    case 'resume': return (await import('./gibson/pipeline.mjs')).resume(rest[0]);
    case 'approve': {
      const pr = Number(String(rest[0] ?? '').replace('#', ''));
      if (!pr) { ui.fail('usage: bin/gibson approve <pr-number>'); return 2; }
      return (await import('./gibson/pipeline.mjs')).approve(pr);
    }
    case 'halt': {
      mkdirSync(dirname(config.haltFile), { recursive: true });
      writeFileSync(config.haltFile, `${new Date().toISOString()} ${rest.join(' ') || 'halted by owner'}\n`);
      ui.ok(`Kill switch engaged (${config.haltFile}). Running lanes stop at their next step.`);
      return 0;
    }
    case 'unhalt':
      if (existsSync(config.haltFile)) rmSync(config.haltFile);
      ui.ok('Kill switch lifted.'); return 0;
    case 'deploy': {
      const { deployAndVerify } = await import('./gibson/stages/deliver.mjs');
      const { context } = await import('./gibson/pipeline.mjs');
      const { Run } = await import('./gibson/lib/run-state.mjs');
      const run = Run.latest(config) ?? Run.create(config, 'manual deploy');
      await deployAndVerify(context(run));
      if (rest.includes('--install')) {
        ui.askContract({
          title: 'INSTALL',
          asking: 'Put the `todo` command on your PATH, pointing at the release build?',
          does: `Runs "npm link" in ${config.releaseDir}, so typing \`todo\` anywhere runs the latest shipped version.`,
          why: 'So you can use the product the fleet ships, exactly as a user would.',
          risks: 'Very low. It only adds a shortcut; undo with "npm rm -g gibson-todo".',
        });
        if (!ui.isInteractive() || !(await ui.prompt('[y]es · [n]o ›')).toLowerCase().startsWith('y')) return 0;
        const r = await exec('npm', ['link'], { cwd: config.releaseDir, timeoutSec: 120 });
        (r.code === 0 ? ui.ok : ui.fail)(r.code === 0 ? 'Installed: try `todo help`' : r.stderr.trim());
      }
      return 0;
    }
    default:
      return (await import('./gibson/pipeline.mjs')).request([command, ...rest].join(' '));
  }
}

main().then((code) => { process.exitCode = code; }, (error) => {
  ui.fail(error.stack ?? String(error));
  process.exitCode = 70;
});
