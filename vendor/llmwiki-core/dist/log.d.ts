export interface LogEntry {
    date: string;
    verb: string;
    subject: string;
    details: string;
}
/**
 * Append a new entry to a log file.
 * Auto-generates the date as YYYY-MM-DD if not provided.
 * Creates parent directories and the file if they do not exist.
 */
export declare function appendEntry(logPath: string, entry: Omit<LogEntry, 'date'> & {
    date?: string;
}): Promise<void>;
/**
 * Parse a markdown log file into an array of LogEntry objects.
 * Returns an empty array for missing or empty files.
 */
export declare function readLog(logPath: string): Promise<LogEntry[]>;
/**
 * Return the last N entries from a log file.
 * Entries are returned in file order (oldest first among the last N).
 */
export declare function getRecentEntries(logPath: string, count: number): Promise<LogEntry[]>;
//# sourceMappingURL=log.d.ts.map