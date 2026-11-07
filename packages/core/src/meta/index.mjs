// SPDX-License-Identifier: MIT
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
export const NAME = 'BrainAtlas';
export const CLI_NAME = 'brainatlas';
export const CLI_ALIAS = 'ba';
export const MCP_SERVER_KEY = 'brainatlas';
export const NPM_SCOPE = '@brainatlas';
export const MAC_APP_DIR_NAME = 'BrainAtlas';
export const LINUX_DIR_NAME = 'brainatlas';
export const VERSION = pkg.version;
export const SIGNATURE_NAMESPACE = 'brainatlas-release';
