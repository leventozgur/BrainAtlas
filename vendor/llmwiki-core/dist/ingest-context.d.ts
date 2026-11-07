import { type IngestResult } from './ingest.js';
/** Info about a related wiki page */
export interface PageInfo {
    path: string;
    title: string;
    score: number;
    excerpt: string;
}
/** Enhanced ingest result with contextual information */
export interface IngestWithContextResult {
    /** Mechanical ingest result */
    ingest: IngestResult;
    /** Word count of the source document */
    source_word_count: number;
    /** Detected content type from file extension */
    source_content_type: string;
    /** Related wiki pages found via keyword overlap */
    related_pages: PageInfo[];
    /** Suggested next actions for the LLM */
    suggested_actions: string[];
}
/** Detect content type from file extension */
export declare function detectContentType(filePath: string): string;
/** Count words in text */
export declare function countWords(text: string): number;
/** Extract keywords from text (first N words, stop words removed, deduplicated) */
export declare function extractKeywords(text: string, maxWords?: number): string[];
/**
 * Ingest a source and return enhanced result with context.
 *
 * Performs mechanical ingest via ingestSource(), then enriches the result
 * with word count, content type, related pages, and suggested actions.
 *
 * @param sourcePath  Path to the source file to ingest.
 * @param targetPath  Project root that contains the wiki/ directory.
 * @param dryRun      Simulate without writing files.
 * @param force       Re-ingest even if source was already processed.
 */
export declare function ingestWithContext(sourcePath: string, targetPath: string, dryRun?: boolean, force?: boolean): Promise<IngestWithContextResult>;
//# sourceMappingURL=ingest-context.d.ts.map