import { join } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { listSources } from './sources.js';
import { ingestSource } from './ingest.js';
import { slugify } from './utils.js';
import { directoryExists } from './wiki.js';
import { API_VERSION } from './constants.js';
import { isNotFoundError } from './errors.js';
export async function bulkIngest(rawDir, wikiDir, options = {}) {
    const { dryRun = false, force = false, onProgress } = options;
    const wikiPath = join(wikiDir, 'wiki');
    if (!(await directoryExists(wikiPath))) {
        return {
            command: 'bulk-ingest',
            api_version: API_VERSION,
            total: 0,
            ingested: 0,
            skipped: 0,
            failed: 0,
            dry_run: dryRun,
            files: [],
        };
    }
    const sources = await listSources(rawDir);
    const result = {
        command: 'bulk-ingest',
        api_version: API_VERSION,
        total: sources.length,
        ingested: 0,
        skipped: 0,
        failed: 0,
        dry_run: dryRun,
        files: [],
    };
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const sourcePath = join(rawDir, source.path);
        onProgress?.(i + 1, sources.length, source.name);
        // Check if already ingested (slug-summary.md exists) unless force
        if (!force) {
            const slug = slugify(source.name);
            const summaryPath = join(wikiPath, 'sources', `${slug}-summary.md`);
            let exists = false;
            try {
                await access(summaryPath, constants.F_OK);
                exists = true;
            }
            catch (err) {
                if (!isNotFoundError(err))
                    throw err;
                // Does not exist — will ingest
            }
            if (exists) {
                result.skipped++;
                result.files.push({ file: source.path, status: 'skipped' });
                continue;
            }
        }
        // Ingest the source
        const ingestResult = await ingestSource(sourcePath, wikiDir, dryRun, force);
        if (ingestResult.status === 'success') {
            result.ingested++;
            result.files.push({ file: source.path, status: 'ingested' });
        }
        else if (ingestResult.status === 'skipped') {
            result.skipped++;
            result.files.push({ file: source.path, status: 'skipped' });
        }
        else {
            result.failed++;
            result.files.push({ file: source.path, status: 'failed', error: ingestResult.error });
        }
    }
    return result;
}
//# sourceMappingURL=bulk-ingest.js.map