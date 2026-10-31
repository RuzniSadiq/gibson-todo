#!/usr/bin/env node
import { run } from './app.ts';

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  isTTY: process.stdout.isTTY,
});
