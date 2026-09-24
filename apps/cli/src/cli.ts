#!/usr/bin/env node
import { run } from "./main.js";

const code = await run(process.argv.slice(2), {
  env: process.env,
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
});
process.exit(code);
