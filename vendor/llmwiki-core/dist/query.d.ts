export interface QueryResult {
    title: string;
    path: string;
    score: number;
    excerpt: string;
}
export interface QueryOutput {
    command: string;
    api_version: string;
    query: string;
    matches: number;
    results: QueryResult[];
    saved?: string;
}
/**
 * Slugify a query string for use as a filename.
 */
export declare function slugifyQuery(query: string): string;
/**
 * Execute a query against the wiki, returning scored results.
 */
export declare function queryWiki(queryStr: string, targetPath: string, save?: boolean): Promise<QueryOutput>;
//# sourceMappingURL=query.d.ts.map