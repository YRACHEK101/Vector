#!/usr/bin/env node
// vector-migrate — executable entrypoint.
import { run } from '../src/cli.js';

run(process.argv.slice(2)).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(`\x1b[31mERROR:\x1b[0m ${msg}`);
  process.exit(1);
});
