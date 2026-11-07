/** JSON-Schema definition for a single MCP tool. */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/** All read-only tool definitions exposed by the MCP server. */
export declare const READ_TOOLS: ToolDefinition[];
export type ToolArgs = Record<string, unknown>;
/** Validate that a required argument is a non-empty string. */
export declare function requireString(args: ToolArgs, key: string): string;
/** Validate that an optional argument, if present, is a string. */
export declare function optionalString(args: ToolArgs, key: string): string | undefined;
/**
 * S-7: Prevent path traversal — resolved path must stay within baseDir.
 * Mirrors the guard in ingest.ts.
 */
export declare function assertWithinDir(baseDir: string, relPath: string): string;
/** Resolve a tool call to its result text. */
export declare function handleReadToolCall(name: string, args: ToolArgs, wikiRoot: string): Promise<string>;
//# sourceMappingURL=read-tools.d.ts.map