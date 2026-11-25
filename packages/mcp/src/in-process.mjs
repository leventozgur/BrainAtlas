// SPDX-License-Identifier: MIT
// BA-43: call one of the Wiki tools in process through the SDK's linked in-memory transport, so a caller without MCP
// registration gets exactly the tool the registered MCP server exposes. BA-43d added the write tools; they are
// registered by createServer only when config.readOnly is not true, exactly as for the stdio server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION } from '@brainatlas/core';
import { createServer } from './index.mjs';

const READ_TOOLS = new Set([
  'wiki_query',
  'wiki_read_page',
  'wiki_read_index',
  'wiki_list_pages',
  'wiki_status',
  'wiki_lint',
]);
const WRITE_TOOLS = new Set([
  'wiki_write_page',
  'wiki_update_page',
  'wiki_create_entity',
  'wiki_create_concept',
  'wiki_add_crosslinks',
  'wiki_update_index',
]);

function argumentError(name) {
  const message = `Unknown Wiki tool: ${name}.`;
  return Object.assign(new Error(message), { code: 'E_ARGUMENT' });
}

/**
 * Run one Wiki tool in process. Only the six read tools and the six write tools are accepted; any other name is
 * refused before a server is created. A write tool in a read-only installation is not registered, so the call
 * returns the SDK's tool error. Client and server are closed on every path, including an error.
 * @param {{config:object,paths:object,env:object}} options
 * @param {string} name
 * @param {object} [args]
 * @returns {Promise<{isError:boolean,text:string}>}
 */
export async function callToolInProcess(options, name, args = {}) {
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) throw argumentError(name);
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
