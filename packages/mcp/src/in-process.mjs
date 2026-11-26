// SPDX-License-Identifier: MIT
// BA-43: call one of the Wiki tools in process through the SDK's linked in-memory transport, so a caller without MCP
// registration gets exactly the tool the registered MCP server exposes. BA-88 adds the two write tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION } from '@brainatlas/core';
import { createServer } from './index.mjs';

const CALLABLE_TOOLS = new Set([
  'wiki_query',
  'wiki_read_page',
  'wiki_read_index',
  'wiki_list_pages',
  'wiki_status',
  'wiki_lint',
  'wiki_write_page',
  'wiki_update_index',
]);

function argumentError(name) {
  const message = `Unknown Wiki tool: ${name}.`;
  return Object.assign(new Error(message), { code: 'E_ARGUMENT' });
}

/**
 * Run one Wiki tool in process: the six read tools plus wiki_write_page and wiki_update_index. Any other name is
 * refused before a server is created. Client and server are closed on every path, including an error.
 * @param {{config:object,paths:object,env:object,dryRun?:boolean}} options
 * @param {string} name
 * @param {object} [args]
 * @returns {Promise<{isError:boolean,text:string}>}
 */
export async function callToolInProcess(options, name, args = {}) {
  if (!CALLABLE_TOOLS.has(name)) throw argumentError(name);
  const server = createServer(options);
  const client = new Client({ name: 'brainatlas-cli', version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result?.content) ? result.content : [];
    const first = content.find((item) => item?.type === 'text');
    const text = typeof first?.text === 'string' ? first.text : '';
    return { isError: result?.isError === true, text };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
