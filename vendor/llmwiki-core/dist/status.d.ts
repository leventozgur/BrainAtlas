/**
 * Result of running the status command.
 */
export interface StatusResult {
    command: string;
    api_version: string;
    source_count: number;
    wiki_page_count: number;
    last_ingest_date: string | null;
    last_lint_date: string | null;
    orphan_page_count: number;
    index_coverage_pct: number;
}
/**
 * Gather wiki knowledge base status from the target directory.
 * Returns zeros / nulls gracefully when the wiki is uninitialized.
 */
export declare function getWikiStatus(targetPath: string): Promise<StatusResult>;
//# sourceMappingURL=status.d.ts.map