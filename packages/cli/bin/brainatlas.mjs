#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { VERSION, CLI_NAME, redact } from '@brainatlas/core';
import { main } from '../src/index.mjs';
if (process.argv[2] === '--version' || process.argv[2] === '-V') { console.log(VERSION); process.exit(0); }
try {
  await main();
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'E_ERROR';
  const message = typeof error?.message === 'string' ? error.message : `${CLI_NAME} failed.`;
  if (process.argv.slice(2).includes('--json')) {
    const redactedMessage = redact(message);
    const containsPath = Boolean(error?.path || (Array.isArray(error?.conflicts) && error.conflicts.length))
      || /(?:^|[\s("'=])(?:\/(?:[^\s,;:'"()]*)|~\/[^\s,;:'"()]*|[A-Za-z]:[\\/][^\s,;:'"()]*(?:[\\/][^\s,;:'"()]*)*|\.\.?[\\/][^\s,;:'"()]*)/.test(redactedMessage)
      || /\b[\w.-]+[\\/][\w./\\-]+/.test(redactedMessage);
    const safeMessage = containsPath ? `${CLI_NAME} command failed.` : redactedMessage;
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: safeMessage } })}\n`);
    console.error(`${code}: ${message}`);
  } else {
    console.error(`${code}: ${message}`);
  }
  process.exitCode = code === 'E_COMMAND_UNKNOWN' ? 2 : 1;
}
