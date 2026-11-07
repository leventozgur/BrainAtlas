import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { isNotFoundError } from './errors.js';
/**
 * List all files in a raw sources directory with metadata.
 * Returns an empty array if the directory does not exist.
 */
export async function listSources(rawDir) {
    let entries;
    try {
        entries = await readdir(rawDir, { recursive: true });
    }
    catch (err) {
        if (isNotFoundError(err))
            return [];
        throw err;
    }
    const results = [];
    for (const entry of entries) {
        const fullPath = join(rawDir, entry);
        try {
            const s = await stat(fullPath);
            if (s.isFile()) {
                results.push({
                    name: basename(entry),
                    path: entry.replace(/\\/g, '/'),
                    size: s.size,
                    modified: s.mtime.toISOString(),
                    extension: extname(entry),
                });
            }
        }
        catch (err) {
            if (!isNotFoundError(err))
                throw err;
            // Skip entries that can't be stat'd (e.g. broken symlinks)
        }
    }
    return results;
}
//# sourceMappingURL=sources.js.map