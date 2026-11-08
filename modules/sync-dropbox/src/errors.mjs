// SPDX-License-Identifier: MIT
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';

export class DropboxError extends BrainAtlasError {
  constructor(code, retryAfterSeconds) {
    const messages = {
      E_AUTH: 'Dropbox authentication failed.',
      E_NETWORK: 'Dropbox is unavailable.',
      E_CONFLICT: 'Dropbox revision conflict.',
      E_QUOTA: 'Dropbox quota exceeded.',
      E_NOT_FOUND: 'Dropbox object was not found.',
      E_INVALID_PATH: 'Dropbox object path is invalid.',
      E_CREDENTIAL_STORE: 'Credential storage is unavailable.',
      E_ARGUMENT: 'Dropbox enrollment arguments are invalid.',
    };
    super(code, messages[code] ?? 'Dropbox operation failed.');
    this.name = code === 'E_CONFLICT' ? 'ConflictError' : 'DropboxError';
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) this.retryAfterSeconds = retryAfterSeconds;
  }
}
