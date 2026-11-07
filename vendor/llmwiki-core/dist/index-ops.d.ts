export interface IndexEntry {
    path: string;
    title: string;
    summary: string;
    category: string;
    tags: string[];
}
export interface FindOptions {
    title?: string;
    tags?: string[];
}
/** Escape characters that have special meaning inside markdown link text. */
export declare function escapeMarkdownLinkText(text: string): string;
/**
 * Parse a categorized markdown index file into an array of IndexEntry objects.
 * Returns an empty array for missing or empty files.
 */
export declare function readIndex(filePath: string): Promise<IndexEntry[]>;
/**
 * Serialize an array of IndexEntry objects back to a categorized markdown file.
 * Entries are grouped by category in the order they first appear.
 */
export declare function writeIndex(filePath: string, entries: IndexEntry[]): Promise<void>;
/**
 * Add an entry to the index file under the appropriate category.
 * Creates the category if it does not already exist.
 */
export declare function addEntry(filePath: string, entry: IndexEntry): Promise<void>;
/**
 * Remove an entry from the index file by its path.
 * If the path does not exist, the file is left unchanged.
 */
export declare function removeEntry(filePath: string, path: string): Promise<void>;
/**
 * Update metadata fields (summary, tags, category) for an existing index entry.
 * Returns `true` if the entry was found and updated, `false` if not found.
 */
export declare function updateIndexEntry(filePath: string, pagePath: string, updates: Partial<Omit<IndexEntry, 'path'>>): Promise<boolean>;
/**
 * Search entries by title substring and/or tags.
 * Title matching is case-insensitive. Tag matching requires at least
 * one of the provided tags to be present on the entry.
 */
export declare function findEntries(entries: IndexEntry[], options: FindOptions): IndexEntry[];
//# sourceMappingURL=index-ops.d.ts.map