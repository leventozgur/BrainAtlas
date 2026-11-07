export interface LintFinding {
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    file?: string;
}
export interface LintResult {
    command: string;
    api_version: string;
    findings: LintFinding[];
    errorCount: number;
    warningCount: number;
    infoCount: number;
    categorySummary: Record<string, number>;
}
/**
 * Run lint checks on a wiki knowledge base.
 * If categories is provided and non-empty, only run those check categories.
 */
export declare function lintWiki(targetPath: string, categories?: string[]): Promise<LintResult>;
export interface LintFixOptions {
    /** When true, remove orphan pages (destructive). Default: false. */
    fixOrphans?: boolean;
}
export interface LintFixResult {
    command: string;
    api_version: string;
    fixed: LintFinding[];
    remaining: LintFinding[];
    fixedCount: number;
}
/**
 * Run lint checks and automatically fix deterministic issues.
 *
 * Fixable:
 *  - stale-entries → remove from index
 *  - index-completeness → add missing pages to index
 *  - frontmatter-validation (missing fields) → add defaults
 *
 * NOT auto-fixed (by default):
 *  - orphan-pages → destructive, requires fixOrphans: true
 *  - broken-links → requires human judgment
 *  - missing-pages → informational (broken-links covers the error)
 */
export declare function lintFix(targetPath: string, options?: LintFixOptions): Promise<LintFixResult>;
//# sourceMappingURL=lint.d.ts.map