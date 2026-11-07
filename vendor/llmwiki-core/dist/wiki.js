import matter from 'gray-matter';
import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { join, dirname, extname, relative, resolve } from 'node:path';
import { isNotFoundError } from './errors.js';
import { slugify } from './utils.js';
import { addEntry, escapeMarkdownLinkText, readIndex, removeEntry, writeIndex } from './index-ops.js';
import { getBacklinks } from './backlinks.js';
export async function readPage(filePath) {
    const raw = await readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);
    return {
        frontmatter: data,
        body: content.trim(),
    };
}
export async function writePage(filePath, page) {
    await mkdir(dirname(filePath), { recursive: true });
    const output = matter.stringify(page.body, page.frontmatter);
    await writeFile(filePath, output, 'utf-8');
}
export async function listPages(wikiDir) {
    try {
        const entries = await readdir(wikiDir, { recursive: true });
        return entries
            .filter((entry) => typeof entry === 'string' && extname(entry) === '.md')
            .map((entry) => join(wikiDir, entry));
    }
    catch (err) {
        if (isNotFoundError(err))
            return [];
        throw err;
    }
}
/**
 * Check whether a directory exists.
 */
export async function directoryExists(dirPath) {
    try {
        const s = await stat(dirPath);
        return s.isDirectory();
    }
    catch (err) {
        if (isNotFoundError(err))
            return false;
        throw err;
    }
}
/**
 * Extract all internal markdown links (relative `.md` paths) from content,
 * returning both the display text and target for each link.
 */
export function getPageLinksDetailed(content) {
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const links = [];
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
        const text = match[1];
        const target = match[2];
        if (target.endsWith('.md') && !target.startsWith('http://') && !target.startsWith('https://')) {
            links.push({ text, target });
        }
    }
    return links;
}
export function getPageLinks(content) {
    return getPageLinksDetailed(content).map((link) => link.target);
}
/**
 * Create an entity page at wiki/entities/{slug}.md with proper frontmatter
 * and register it in the wiki index.
 */
export async function createEntityPage(wikiDir, name, content, tags = []) {
    const slug = slugify(name);
    const relPath = `entities/${slug}.md`;
    const fullPath = join(wikiDir, relPath);
    const now = new Date().toISOString();
    await writePage(fullPath, {
        frontmatter: {
            type: 'entity',
            title: name,
            tags,
            created: now,
        },
        body: content,
    });
    const indexEntry = {
        path: relPath,
        title: name,
        summary: '',
        category: 'Entities',
        tags,
    };
    const indexPath = join(wikiDir, 'index.md');
    await addEntry(indexPath, indexEntry);
    return { path: relPath, indexEntry };
}
/**
 * Create a concept page at wiki/concepts/{slug}.md with proper frontmatter
 * and register it in the wiki index.
 */
export async function createConceptPage(wikiDir, name, content, tags = []) {
    const slug = slugify(name);
    const relPath = `concepts/${slug}.md`;
    const fullPath = join(wikiDir, relPath);
    const now = new Date().toISOString();
    await writePage(fullPath, {
        frontmatter: {
            type: 'concept',
            title: name,
            tags,
            created: now,
        },
        body: content,
    });
    const indexEntry = {
        path: relPath,
        title: name,
        summary: '',
        category: 'Concepts',
        tags,
    };
    const indexPath = join(wikiDir, 'index.md');
    await addEntry(indexPath, indexEntry);
    return { path: relPath, indexEntry };
}
/**
 * Append "See also" crosslinks to a wiki page.
 * Validates all source and target pages exist, reads target titles from
 * frontmatter, and appends (or extends) a "## See also" section with
 * relative markdown links.  Duplicate links are silently skipped.
 */
export async function addCrosslinks(wikiDir, fromPage, toPages) {
    if (toPages.length === 0)
        return;
    const fromFull = join(wikiDir, fromPage);
    // Validate fromPage exists
    try {
        await stat(fromFull);
    }
    catch (err) {
        if (isNotFoundError(err)) {
            throw new Error(`Source page not found: ${fromPage}`);
        }
        throw err;
    }
    // Validate all toPages exist, collect missing
    const missing = [];
    for (const tp of toPages) {
        try {
            await stat(join(wikiDir, tp));
        }
        catch (err) {
            if (isNotFoundError(err)) {
                missing.push(tp);
            }
            else {
                throw err;
            }
        }
    }
    if (missing.length > 0) {
        throw new Error(`Target pages not found: ${missing.join(', ')}`);
    }
    // Read the source page
    const page = await readPage(fromFull);
    // Build link entries for each target page
    const linkLines = [];
    for (const tp of toPages) {
        const toFull = join(wikiDir, tp);
        let title;
        try {
            const targetPage = await readPage(toFull);
            title =
                targetPage.frontmatter.title ||
                    tp.replace(/\.md$/, '').split('/').pop();
        }
        catch {
            title = tp.replace(/\.md$/, '').split('/').pop();
        }
        const relLink = relative(dirname(fromFull), toFull).replace(/\\/g, '/');
        linkLines.push(`- [${escapeMarkdownLinkText(title)}](${relLink})`);
    }
    // Check if "## See also" section exists
    const seeAlsoHeader = '## See also';
    const seeAlsoIndex = page.body.indexOf(seeAlsoHeader);
    let newBody;
    if (seeAlsoIndex !== -1) {
        // Find the end of the See also section (next ## heading or end of body)
        const afterHeader = seeAlsoIndex + seeAlsoHeader.length;
        const nextHeadingMatch = page.body.slice(afterHeader).search(/\n## /);
        const sectionEnd = nextHeadingMatch !== -1 ? afterHeader + nextHeadingMatch : page.body.length;
        // Get existing links to avoid duplicates
        const existingSection = page.body.slice(afterHeader, sectionEnd);
        const existingLinks = new Set(existingSection
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('- [')));
        const newLinks = linkLines.filter((l) => !existingLinks.has(l));
        if (newLinks.length === 0)
            return;
        // Insert new links at the end of the existing section
        const before = page.body.slice(0, sectionEnd).trimEnd();
        const after = page.body.slice(sectionEnd);
        newBody = before + '\n' + newLinks.join('\n') + after;
    }
    else {
        newBody =
            page.body.trimEnd() + '\n\n' + seeAlsoHeader + '\n\n' + linkLines.join('\n');
    }
    await writePage(fromFull, {
        frontmatter: page.frontmatter,
        body: newBody,
    });
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
export async function deletePage(wikiDir, pagePath) {
    // 1. Path traversal validation
    const resolvedBase = resolve(wikiDir).replace(/\\/g, '/');
    const resolvedFull = resolve(wikiDir, pagePath).replace(/\\/g, '/');
    if (!resolvedFull.startsWith(resolvedBase + '/') && resolvedFull !== resolvedBase) {
        throw new Error('Path traversal detected — pagePath must stay within wikiDir');
    }
    // 2. Validate page exists
    const fullPath = join(wikiDir, pagePath);
    try {
        await stat(fullPath);
    }
    catch (err) {
        if (isNotFoundError(err)) {
            throw new Error(`Page not found: ${pagePath}`);
        }
        throw err;
    }
    // 3. Compute backlinks before deletion
    const backlinkWarnings = await getBacklinks(wikiDir, pagePath);
    // 4. Remove index entry FIRST (safer order)
    const indexPath = join(wikiDir, 'index.md');
    await removeEntry(indexPath, pagePath);
    // 5. Delete the file from disk
    await unlink(fullPath);
    return {
        deletedPath: pagePath,
        deleted: true,
        backlinkWarnings,
    };
}
/**
 * Rename (move) a wiki page from oldPath to newPath.
 * Rewrites backlinks across the wiki, updates the index entry, and
 * optionally updates a path-derived frontmatter title.
 *
 * Security: validates both paths stay within wikiDir (no path traversal).
 */
export async function renamePage(wikiDir, oldPath, newPath) {
    // 1. Path traversal guard on BOTH paths
    const resolvedBase = resolve(wikiDir).replace(/\\/g, '/');
    const resolvedOld = resolve(wikiDir, oldPath).replace(/\\/g, '/');
    if (!resolvedOld.startsWith(resolvedBase + '/') && resolvedOld !== resolvedBase) {
        throw new Error('Path traversal detected — oldPath must stay within wikiDir');
    }
    const resolvedNew = resolve(wikiDir, newPath).replace(/\\/g, '/');
    if (!resolvedNew.startsWith(resolvedBase + '/') && resolvedNew !== resolvedBase) {
        throw new Error('Path traversal detected — newPath must stay within wikiDir');
    }
    // 2. Validate old page exists
    const oldFull = join(wikiDir, oldPath);
    try {
        await stat(oldFull);
    }
    catch (err) {
        if (isNotFoundError(err)) {
            throw new Error(`Page not found: ${oldPath}`);
        }
        throw err;
    }
    // 3. Validate new path does NOT exist
    const newFull = join(wikiDir, newPath);
    try {
        await stat(newFull);
        throw new Error(`Target path already exists: ${newPath}`);
    }
    catch (err) {
        if (!isNotFoundError(err))
            throw err;
        // Good — file doesn't exist
    }
    // 4. Read old page content
    const page = await readPage(oldFull);
    // 5. Update frontmatter title if it was path-derived
    const oldStem = oldPath.replace(/\.md$/, '').split('/').pop();
    const newStem = newPath.replace(/\.md$/, '').split('/').pop();
    if (page.frontmatter.title) {
        const normalizedTitle = page.frontmatter.title.toLowerCase().replace(/[\s_-]+/g, '-');
        const normalizedOldStem = oldStem.toLowerCase().replace(/[\s_-]+/g, '-');
        if (normalizedTitle === normalizedOldStem) {
            page.frontmatter.title = newStem.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        }
    }
    // 6. Create parent directories + write new file
    await writePage(newFull, page);
    // 7. Scan ALL wiki pages for links to oldPath and rewrite them
    const allPages = await listPages(wikiDir);
    const normOld = oldPath.replace(/\\/g, '/');
    const affectedPages = [];
    let rewrittenLinks = 0;
    for (const absPagePath of allPages) {
        // Skip the old file itself (it's about to be deleted)
        if (resolve(absPagePath).replace(/\\/g, '/') === resolvedOld)
            continue;
        // Skip the new file (just written)
        if (resolve(absPagePath).replace(/\\/g, '/') === resolve(newFull).replace(/\\/g, '/'))
            continue;
        const sourcePage = await readPage(absPagePath);
        const links = getPageLinksDetailed(sourcePage.body);
        let modified = false;
        let updatedBody = sourcePage.body;
        for (const { text, target } of links) {
            const sourceDir = dirname(absPagePath);
            const resolvedAbsolute = join(sourceDir, target);
            const resolvedRelative = relative(wikiDir, resolvedAbsolute).replace(/\\/g, '/');
            if (resolvedRelative === normOld) {
                // Compute new relative link from this source page to new location
                const newRelLink = relative(dirname(absPagePath), newFull).replace(/\\/g, '/');
                // Replace the exact link in body
                const oldLink = `[${text}](${target})`;
                const newLink = `[${text}](${newRelLink})`;
                updatedBody = updatedBody.replace(oldLink, newLink);
                modified = true;
                rewrittenLinks++;
            }
        }
        if (modified) {
            await writePage(absPagePath, { frontmatter: sourcePage.frontmatter, body: updatedBody });
            const relSourcePath = relative(wikiDir, absPagePath).replace(/\\/g, '/');
            affectedPages.push(relSourcePath);
        }
    }
    // 8. Update index entry
    const indexPath = join(wikiDir, 'index.md');
    const entries = await readIndex(indexPath);
    const entryIdx = entries.findIndex((e) => e.path === oldPath);
    if (entryIdx >= 0) {
        entries[entryIdx].path = newPath;
        if (page.frontmatter.title) {
            entries[entryIdx].title = page.frontmatter.title;
        }
        await writeIndex(indexPath, entries);
    }
    // 9. Delete old file
    await unlink(oldFull);
    // 10. Return result
    return { renamed: true, oldPath, newPath, rewrittenLinks, affectedPages };
}
//# sourceMappingURL=wiki.js.map