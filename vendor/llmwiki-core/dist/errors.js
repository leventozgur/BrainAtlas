export function isNotFoundError(err) {
    return err instanceof Error && err.code === 'ENOENT';
}
export function isPermissionError(err) {
    return err instanceof Error && err.code === 'EACCES';
}
//# sourceMappingURL=errors.js.map