#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { VERSION, CLI_NAME } from '@brainatlas/core';
if (process.argv[2] === '--version' || process.argv[2] === '-V') { console.log(VERSION); process.exit(0); }
console.error(`${CLI_NAME}: not implemented`);
process.exit(2);
