import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
/**
 * Register MCP resources so agents can browse wiki content without tool calls.
 *
 * Static resources:
 *   - `resource://wiki/index`   — full wiki index as JSON
 *   - `resource://wiki/pages`   — list of all pages with frontmatter
 *   - `resource://wiki/sources` — list of raw source files with metadata
 *
 * Template resources:
 *   - `resource://wiki/pages/{path}`   — single page content + frontmatter
 *   - `resource://wiki/sources/{path}` — raw source file content
 */
export declare function registerResources(server: Server, wikiRoot: string): void;
//# sourceMappingURL=resources.d.ts.map