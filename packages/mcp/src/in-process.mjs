// SPDX-License-Identifier: MIT
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION, toolNames } from '@brainatlas/core';
import { createServer } from './index.mjs';

const CALLABLE_TOOLS = new Set(toolNames());

function argumentError(name) {
  const message = `Unknown Wiki tool: ${name}.`;
  return Object.assign(new Error(message), { code: 'E_ARGUMENT' });
}

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
