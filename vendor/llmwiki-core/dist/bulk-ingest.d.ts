export interface BulkIngestOptions {
    dryRun?: boolean;
    force?: boolean;
    onProgress?: (current: number, total: number, file: string) => void;
}
export interface BulkIngestFileResult {
    file: string;
    status: 'ingested' | 'skipped' | 'failed';
    error?: string;
}
export interface BulkIngestResult {
    command: string;
    api_version: string;
    total: number;
    ingested: number;
    skipped: number;
    failed: number;
    dry_run: boolean;
    files: BulkIngestFileResult[];
}
export declare function bulkIngest(rawDir: string, wikiDir: string, options?: BulkIngestOptions): Promise<BulkIngestResult>;
//# sourceMappingURL=bulk-ingest.d.ts.map