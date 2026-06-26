#!/usr/bin/env node
// vector-migrate — executable entrypoint.
import { run } from '../src/cli.js';

run(process.argv.slice(2)).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  // Distinct exit codes (see README): a VectorError carries its own; default to 3
  // (git/subprocess failure) for anything else thrown during the run.
  const code = err && Number.isInteger(err.exitCode) ? err.exitCode : 3;
  console.error(`\x1b[31mERROR:\x1b[0m ${msg}`);
  process.exit(code);
});
