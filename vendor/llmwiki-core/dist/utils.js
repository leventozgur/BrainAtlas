/**
 * Slugify a filename: lowercase, strip extension, replace non-alphanumeric
 * sequences with hyphens, trim leading/trailing hyphens.
 */
export function slugify(filename) {
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
    return nameWithoutExt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
/**
 * Extract an excerpt from page body (first N characters).
 */
export function excerpt(body, maxLen = 200) {
    const cleaned = body.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLen)
        return cleaned;
    return cleaned.slice(0, maxLen) + '…';
}
//# sourceMappingURL=utils.js.map