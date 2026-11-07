import type { ToolArgs, ToolDefinition } from './read-tools.js';
/** All write tool definitions exposed by the MCP server. */
export declare const WRITE_TOOLS: ToolDefinition[];
/** Resolve a write tool call to its result text. */
export declare function handleWriteToolCall(name: string, args: ToolArgs, wikiRoot: string): Promise<string>;
//# sourceMappingURL=write-tools.d.ts.map