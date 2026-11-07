import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
export declare const PROMPTS: readonly [{
    readonly name: "ingest-and-integrate";
    readonly description: "Ingest a source file and integrate its knowledge into the wiki — create entities, concepts, crosslinks, and verify health.";
    readonly arguments: readonly [{
        readonly name: "source_path";
        readonly description: "Path to source file in the raw/ directory";
        readonly required: true;
    }];
}, {
    readonly name: "lint-and-fix";
    readonly description: "Run wiki lint, review findings by severity, fix deterministic issues, and report remaining problems that need human judgment.";
}, {
    readonly name: "research-topic";
    readonly description: "Research a topic across the wiki — query, read related pages, synthesize findings, and identify knowledge gaps.";
    readonly arguments: readonly [{
        readonly name: "topic";
        readonly description: "The topic to research across the wiki";
        readonly required: true;
    }];
}];
/**
 * Register MCP prompts for reusable agent workflow templates.
 *
 * Prompts provide structured multi-step instructions that guide an LLM agent
 * through common wiki operations using the available MCP tools.
 */
export declare function registerPrompts(server: Server, _wikiRoot: string): void;
//# sourceMappingURL=prompts.d.ts.map