#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { main } from '../src/index.mjs';
main().catch(() => { process.stderr.write('BrainAtlas MCP failed to start.\n'); process.exitCode = 1; });
