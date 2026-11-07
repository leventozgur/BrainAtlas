import { Server } from '@modelcontextprotocol/sdk/server/index.js';
/**
 * Create a fully-configured MCP server for LLM Wiki.
 *
 * The returned {@link Server} has all tool handlers registered and is ready to
 * be connected to a transport (e.g. `StdioServerTransport`).
 *
 * @param wikiRoot  Path to the wiki root directory.  Every tool handler
 *                  receives this as implicit context so callers don't have to
 *                  supply it per-request.
 */
export declare function createMcpServer(wikiRoot: string): Server;
//# sourceMappingURL=server.d.ts.map