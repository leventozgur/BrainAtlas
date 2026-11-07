/**
 * Result of running the init command.
 */
export interface InitResult {
    command: string;
    api_version: string;
    status: 'created' | 'already_initialized';
    created_dirs: string[];
    created_files: string[];
    warning?: string;
}
/**
 * Initialize a wiki knowledge base at the given path.
 * Creates the `.wiki` directory containing the wiki structure.
 * The `targetPath` is the project/workspace folder; the wiki root
 * will be `targetPath/.wiki/`.
 *
 * Returns a structured result describing what was created.
 */
export declare function initWiki(targetPath: string): Promise<InitResult>;
//# sourceMappingURL=init.d.ts.map