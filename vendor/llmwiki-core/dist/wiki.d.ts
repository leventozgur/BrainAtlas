import type { IndexEntry } from './index-ops.js';
import type { BacklinkResult } from './backlinks.js';
export interface WikiPageFrontmatter {
    type?: string;
    title?: string;
    tags?: string[];
    sources?: string[];
    created?: string;
    updated?: string;
    [key: string]: unknown;
}
export interface WikiPage {
    frontmatter: WikiPageFrontmatter;
    body: string;
}
export declare function readPage(filePath: string): Promise<WikiPage>;
export declare function writePage(filePath: string, page: WikiPage): Promise<void>;
export declare function listPages(wikiDir: string): Promise<string[]>;
/**
 * Check whether a directory exists.
 */
export declare function directoryExists(dirPath: string): Promise<boolean>;
export interface PageLinkDetail {
    /** The display text of the markdown link */
    text: string;
    /** The link target (href) */
    target: string;
}
/**
 * Extract all internal markdown links (relative `.md` paths) from content,
 * returning both the display text and target for each link.
 */
export declare function getPageLinksDetailed(content: string): PageLinkDetail[];
export declare function getPageLinks(content: string): string[];
export interface CreatePageResult {
    path: string;
    indexEntry: IndexEntry;
}
/**
 * Create an entity page at wiki/entities/{slug}.md with proper frontmatter
 * and register it in the wiki index.
 */
export declare function createEntityPage(wikiDir: string, name: string, content: string, tags?: string[]): Promise<CreatePageResult>;
/**
 * Create a concept page at wiki/concepts/{slug}.md with proper frontmatter
 * and register it in the wiki index.
 */
export declare function createConceptPage(wikiDir: string, name: string, content: string, tags?: string[]): Promise<CreatePageResult>;
/**
 * Append "See also" crosslinks to a wiki page.
 * Validates all source and target pages exist, reads target titles from
 * frontmatter, and appends (or extends) a "## See also" section with
 * relative markdown links.  Duplicate links are silently skipped.
 */
export declare function addCrosslinks(wikiDir: string, fromPage: string, toPages: string[]): Promise<void>;
export interface DeleteResult {
    /** The relative path of the deleted page */
    deletedPath: string;
    /** Whether the file was successfully deleted */
    deleted: boolean;
    /** Backlink warnings - pages that still link to the deleted page */
    backlinkWarnings: BacklinkResult[];
}
/**
 * Delete a wiki page by relative path.
 * Validates the page exists, computes backlink warnings, removes the index
 * entry, then deletes the file from disk.
 *
 * Security: validates pagePath stays within wikiDir (no path traversal).
 * Order: index entry removed FIRST, then file deleted (safer to have orphan
 * file than orphan index entry).
 */
export declare function deletePage(wikiDir: string, pagePath: string): Promise<DeleteResult>;
export interface RenameResult {
    /** Whether the rename was successful */
    renamed: boolean;
    /** The old relative path */
    oldPath: string;
    /** The new relative path */
    newPath: string;
    /** Number of links that were rewritten across the wiki */
    rewrittenLinks: number;
    /** Relative paths of pages whose links were rewritten */
    affectedPages: string[];
}
/**
 * Rename (move) a wiki page from oldPath to newPath.
 * Rewrites backlinks across the wiki, updates the index entry, and
 * optionally updates a path-derived frontmatter title.
 *
 * Security: validates both paths stay within wikiDir (no path traversal).
 */
export declare function renamePage(wikiDir: string, oldPath: string, newPath: string): Promise<RenameResult>;
//# sourceMappingURL=wiki.d.ts.map