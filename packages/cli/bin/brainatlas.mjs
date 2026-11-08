#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { VERSION, CLI_NAME } from '@brainatlas/core';
import { main } from '../src/index.mjs';
if (process.argv[2] === '--version' || process.argv[2] === '-V') { console.log(VERSION); process.exit(0); }
try {
  await main();
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'E_ERROR';
  const message = typeof error?.message === 'string' ? error.message : `${CLI_NAME} failed.`;
  console.error(`${code}: ${message}`);
  process.exitCode = code === 'E_COMMAND_UNKNOWN' ? 2 : 1;
}
