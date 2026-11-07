export interface BacklinkResult {
    /** Absolute path of the page containing the backlink */
    sourcePage: string;
    /** Title from the source page's frontmatter (or filename if missing) */
    sourceTitle: string;
    /** The link text used in the markdown link */
    linkText: string;
}
/**
 * Find all wiki pages that contain links pointing to `targetPage`.
 *
 * `targetPage` should be a relative path (e.g. "concepts/ai.md") as it
 * appears in markdown link targets.
 *
 * Iterates all pages via `listPages()`, extracts markdown links,
 * and resolves each link relative to the source page's directory to compare
 * against the target.
 */
export declare function getBacklinks(wikiDir: string, targetPage: string): Promise<BacklinkResult[]>;
//# sourceMappingURL=backlinks.d.ts.map