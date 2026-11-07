// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';
import { runChecks } from './guard-lib.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
const checks = await runChecks(root);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id}`);
  for (const f of c.findings) console.log(`${f.file}:${f.line}:${f.rule}`);
}
if (checks.some(c=>!c.ok)) process.exitCode=1;
