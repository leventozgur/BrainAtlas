/**
 * Result of running the ingest command.
 */
export interface IngestResult {
    command: string;
    api_version: string;
    status: 'success' | 'error' | 'skipped';
    pages_created: string[];
    pages_updated: string[];
    dry_run: boolean;
    error?: string;
    message?: string;
}
/**
 * Ingest a source file into the wiki knowledge base.
 *
 * Reads the source, creates a summary page in wiki/sources/,
 * updates wiki/index.md, and appends to wiki/log.md.
 */
export declare function ingestSource(sourcePath: string, targetPath: string, dryRun: boolean, force?: boolean): Promise<IngestResult>;
//# sourceMappingURL=ingest.d.ts.map