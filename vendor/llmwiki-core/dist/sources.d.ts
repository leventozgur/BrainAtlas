export interface SourceFile {
    /** File name including extension */
    name: string;
    /** Relative path from rawDir */
    path: string;
    /** File size in bytes */
    size: number;
    /** Last modified date as ISO string */
    modified: string;
    /** File extension including the dot (e.g. ".txt") */
    extension: string;
}
/**
 * List all files in a raw sources directory with metadata.
 * Returns an empty array if the directory does not exist.
 */
export declare function listSources(rawDir: string): Promise<SourceFile[]>;
//# sourceMappingURL=sources.d.ts.map